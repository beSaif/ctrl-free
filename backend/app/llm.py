"""LLM access: one client, JSON-schema calls, disk cache, retries, concurrency.

The LLM never produces a price. It only picks, labels, classifies and translates;
every caller has a rules fallback and catches `LLMUnavailable`.

    call_json(system, user, schema, model=None, name="result", temperature=None) -> dict
    map_concurrent(fn, items, max_workers=8, progress=None) -> list
    available() -> bool, stats() -> dict

Cache: one JSON file per call in config.LLM_CACHE_DIR, keyed by
sha256(model + system + user + schema). Cache hits work offline (LLM_OFFLINE=1 or no key).
"""
from __future__ import annotations

import hashlib
import json
import logging
import random
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Iterable

from . import config

log = logging.getLogger(__name__)


class LLMUnavailable(RuntimeError):
    """No usable LLM (offline mode, no key, inactive billing, network down). Fall back to rules."""


class LLMError(RuntimeError):
    """The LLM answered but the answer was unusable (bad JSON, refusal)."""


_lock = threading.Lock()
_client = None
_client_kind: str | None = None
_disabled_reason: str | None = None          # set after a non-retryable account error
_unsupported: dict[str, set[str]] = {}         # model -> params the API rejected (e.g. temperature)
_api_mode: dict[str, str] = {}                 # model -> "responses" | "chat"
_stats = {"calls": 0, "cache_hits": 0, "errors": 0, "input_tokens": 0, "output_tokens": 0, "seconds": 0.0}
_local = threading.local()

DEFAULT_TIMEOUT = 90.0
MAX_RETRIES = 4


# --------------------------------------------------------------------------- client

def _configured() -> bool:
    if config.AZURE_OPENAI_ENDPOINT:
        return bool(config.AZURE_OPENAI_API_KEY)
    return bool(config.OPENAI_API_KEY)


def available() -> bool:
    """True when a live call may be attempted (cache hits work regardless)."""
    return not config.LLM_OFFLINE and _configured() and _disabled_reason is None


def unavailable_reason() -> str | None:
    if config.LLM_OFFLINE:
        return "LLM_OFFLINE=1"
    if not _configured():
        return "no API key configured"
    return _disabled_reason


def get_client():
    """AzureOpenAI when AZURE_OPENAI_ENDPOINT is set, else OpenAI. Cached."""
    global _client, _client_kind
    if not available():
        raise LLMUnavailable(unavailable_reason() or "LLM unavailable")
    with _lock:
        if _client is None:
            if config.AZURE_OPENAI_ENDPOINT:
                from openai import AzureOpenAI

                _client = AzureOpenAI(
                    azure_endpoint=config.AZURE_OPENAI_ENDPOINT,
                    api_key=config.AZURE_OPENAI_API_KEY,
                    api_version=config.AZURE_OPENAI_API_VERSION,
                    timeout=DEFAULT_TIMEOUT,
                    max_retries=0,
                )
                _client_kind = "azure"
            else:
                from openai import OpenAI

                _client = OpenAI(api_key=config.OPENAI_API_KEY, timeout=DEFAULT_TIMEOUT, max_retries=0)
                _client_kind = "openai"
    return _client


def reset(client=None) -> None:
    """Tests: inject a fake client or clear state."""
    global _client, _disabled_reason, _client_kind
    with _lock:
        _client = client
        _client_kind = "fake" if client is not None else None
        _disabled_reason = None
        _unsupported.clear()
        _api_mode.clear()


def stats() -> dict:
    return dict(_stats)


def last_call_cached() -> bool:
    return bool(getattr(_local, "cached", False))


# --------------------------------------------------------------------------- cache

def cache_key(model: str, system: str, user: str, schema: dict) -> str:
    blob = json.dumps([model, system, user, schema], sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def _cache_path(key: str):
    return config.LLM_CACHE_DIR / f"{key}.json"


def cache_get(key: str) -> dict | None:
    p = _cache_path(key)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text("utf-8"))["response"]
    except Exception:  # corrupt entry: ignore
        return None


def cache_put(key: str, response: dict, meta: dict) -> None:
    p = _cache_path(key)
    tmp = p.with_suffix(".tmp%d" % threading.get_ident())
    tmp.write_text(json.dumps({**meta, "response": response}, ensure_ascii=False, indent=1), "utf-8")
    tmp.replace(p)


# --------------------------------------------------------------------------- calls

def _is_account_error(e: Exception) -> bool:
    text = repr(e).lower()
    return any(s in text for s in ("billing_not_active", "insufficient_quota", "invalid_api_key",
                                   "account is not active", "incorrect api key", "deactivated"))


def _rejected_param(e: Exception) -> str | None:
    text = str(e).lower()
    for p in ("temperature", "reasoning", "max_output_tokens", "text.verbosity", "verbosity"):
        if p in text and ("unsupported" in text or "not supported" in text or "unrecognized" in text
                          or "does not support" in text or "invalid" in text):
            return p.split(".")[-1]
    return None


def _responses_call(client, model, system, user, schema, name, temperature):
    kwargs: dict[str, Any] = {
        "model": model,
        "input": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "text": {"format": {"type": "json_schema", "name": name, "schema": schema, "strict": True}},
    }
    bad = _unsupported.get(model, set())
    if temperature is not None and "temperature" not in bad:
        kwargs["temperature"] = temperature
    if "reasoning" not in bad and config_reasoning():
        kwargs["reasoning"] = {"effort": config_reasoning()}
    r = client.responses.create(**kwargs)
    text = getattr(r, "output_text", None)
    if not text:
        # refusal or empty: walk the output items
        for item in getattr(r, "output", []) or []:
            for c in getattr(item, "content", []) or []:
                if getattr(c, "type", "") == "refusal":
                    raise LLMError("refusal: %s" % getattr(c, "refusal", ""))
        raise LLMError("empty response")
    u = getattr(r, "usage", None)
    return text, (getattr(u, "input_tokens", 0) or 0), (getattr(u, "output_tokens", 0) or 0)


def _chat_call(client, model, system, user, schema, name, temperature):
    kwargs: dict[str, Any] = {
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "response_format": {"type": "json_schema", "json_schema": {"name": name, "schema": schema, "strict": True}},
    }
    bad = _unsupported.get(model, set())
    if temperature is not None and "temperature" not in bad:
        kwargs["temperature"] = temperature
    if "reasoning" not in bad and config_reasoning():
        kwargs["reasoning_effort"] = config_reasoning()
    r = client.chat.completions.create(**kwargs)
    msg = r.choices[0].message
    if getattr(msg, "refusal", None):
        raise LLMError("refusal: %s" % msg.refusal)
    if not msg.content:
        raise LLMError("empty response")
    u = getattr(r, "usage", None)
    return msg.content, (getattr(u, "prompt_tokens", 0) or 0), (getattr(u, "completion_tokens", 0) or 0)


def config_reasoning() -> str | None:
    """Reasoning effort for gpt-5 family models; keeps calls fast. Env LLM_REASONING ('' disables)."""
    import os

    v = os.getenv("LLM_REASONING", "low")
    return v or None


def call_json(system: str, user: str, schema: dict, model: str | None = None, name: str = "result",
              temperature: float | None = None, use_cache: bool = True, timeout: float | None = None) -> dict:
    """One Structured-Outputs call (strict json_schema). Returns the parsed dict.

    Raises LLMUnavailable when no live call is possible and the cache has no answer,
    LLMError when the model's answer is unusable after retries.
    """
    global _disabled_reason
    model = model or config.LLM_MODEL
    key = cache_key(model, system, user, schema)
    _local.cached = False
    if use_cache:
        hit = cache_get(key)
        if hit is not None:
            _stats["cache_hits"] += 1
            _local.cached = True
            return hit
    client = get_client()  # raises LLMUnavailable
    if timeout is not None:
        try:
            client = client.with_options(timeout=timeout)
        except Exception:
            pass

    import openai

    last: Exception | None = None
    t0 = time.time()
    attempt = 0
    while attempt < MAX_RETRIES:
        attempt += 1
        mode = _api_mode.get(model, "responses")
        try:
            fn = _responses_call if mode == "responses" else _chat_call
            text, tin, tout = fn(client, model, system, user, schema, name, temperature)
            data = json.loads(text)
            _api_mode[model] = mode
            with _lock:
                _stats["calls"] += 1
                _stats["input_tokens"] += tin
                _stats["output_tokens"] += tout
                _stats["seconds"] += time.time() - t0
            if use_cache:
                cache_put(key, data, {"model": model, "name": name, "created": time.strftime("%Y-%m-%dT%H:%M:%S"),
                                      "api": mode, "input_tokens": tin, "output_tokens": tout})
            return data
        except (openai.AuthenticationError, openai.PermissionDeniedError) as e:
            _disabled_reason = "account error: %s" % str(e)[:160]
            raise LLMUnavailable(_disabled_reason) from e
        except openai.RateLimitError as e:
            if _is_account_error(e):
                _disabled_reason = "account error: %s" % str(e)[:160]
                raise LLMUnavailable(_disabled_reason) from e
            last = e
        except openai.NotFoundError as e:
            # Responses API not available for this deployment/model: switch to chat once.
            if mode == "responses":
                _api_mode[model] = "chat"
                attempt -= 1
                last = e
                continue
            raise LLMError("model not found: %s" % model) from e
        except openai.BadRequestError as e:
            p = _rejected_param(e)
            if p and p not in _unsupported.setdefault(model, set()):
                _unsupported[model].add(p)
                attempt -= 1
                last = e
                continue
            if mode == "responses" and ("responses" in str(e).lower() or "text.format" in str(e).lower()):
                _api_mode[model] = "chat"
                attempt -= 1
                last = e
                continue
            _stats["errors"] += 1
            raise LLMError(str(e)[:300]) from e
        except (openai.APIConnectionError, openai.APITimeoutError) as e:
            last = e
        except openai.InternalServerError as e:
            last = e
        except (json.JSONDecodeError, LLMError) as e:
            last = e
        time.sleep(min(20.0, (2 ** attempt) * 0.5 + random.random()))
    _stats["errors"] += 1
    if isinstance(last, (json.JSONDecodeError, LLMError)):
        raise LLMError(str(last)) from last
    # Network kept failing: treat as unavailable so callers use rules.
    raise LLMUnavailable("LLM call failed after %d attempts: %s" % (MAX_RETRIES, str(last)[:200])) from last


def map_concurrent(fn: Callable[[Any], Any], items: Iterable[Any], max_workers: int = 8,
                   progress: Callable[[int, int], None] | None = None, return_exceptions: bool = True) -> list:
    """Run fn over items in a thread pool, results in input order.

    With return_exceptions=True a failing item yields its exception object instead of raising.
    """
    items = list(items)
    out: list[Any] = [None] * len(items)
    if not items:
        return out
    done = 0

    def run(i):
        try:
            return i, fn(items[i]), None
        except Exception as e:  # noqa: BLE001
            return i, None, e

    with ThreadPoolExecutor(max_workers=max(1, min(max_workers, len(items)))) as ex:
        for i, res, err in ex.map(run, range(len(items))):
            if err is not None and not return_exceptions:
                raise err
            out[i] = err if err is not None else res
            done += 1
            if progress:
                try:
                    progress(done, len(items))
                except Exception:
                    pass
    return out


def chunks(seq: list, n: int) -> list[list]:
    return [seq[i:i + n] for i in range(0, len(seq), n)]
