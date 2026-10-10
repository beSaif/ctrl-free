"""LLM path safety: with a live (fake) LLM the pipeline is never worse than rules-only, and a slow,
failing or rate-limited LLM cannot hang or crash it (bounded time budget, rules fallback)."""
from __future__ import annotations

import json
import time

import httpx
import openai
import pytest

from app import config, llm, matcher, pipeline, store
from app import verification as V
from tests.test_llm_misc import FakeClient, _rate_limit, fake_llm, schema_default  # noqa: F401  (fixtures)

pytestmark = pytest.mark.skipif(not config.DEMO_PDF.exists(), reason="demo PDF missing")


@pytest.fixture
def tenders(monkeypatch, tmp_path):
    d = tmp_path / "tenders"
    d.mkdir()
    monkeypatch.setattr(config, "TENDERS_DIR", d)
    return d


def _run_demo() -> tuple[dict, float]:
    t = store.create(config.DEMO_PDF.read_bytes(), config.DEMO_PDF.name, {})
    t0 = time.monotonic()
    pipeline.run(t["id"])
    return store.load(t["id"]), time.monotonic() - t0


def _adversarial(name, schema, user, kw):
    """Always picks the 2nd candidate with high confidence; everything else gets schema defaults."""
    if name == "pick_products":
        out = {}
        for lv, sub in schema["properties"].items():
            enum = sub["properties"]["product_id"]["enum"]
            out[lv] = {"product_id": enum[1] if len(enum) > 2 else "none", "confidence": "high",
                       "reason": "adversarial", "assumptions": []}
        return out
    return schema_default(schema)


def _assert_verified(t: dict) -> None:
    s = V.verify(t)["summary"]
    assert (s["found"], s["product_ok"], s["install_ok"], s["direct_ok"]) == (22, 22, 22, 22), s
    assert s["subset_direct_ok"] and s["subset_cost_ok"] and s["scenarios_ok"]


def test_adversarial_llm_cannot_override_strong_rules(fake_llm, tenders):
    fake = fake_llm(FakeClient(_adversarial))
    t, _ = _run_demo()
    assert t["status"] == "ready"
    assert any(c["text"]["format"]["name"] == "pick_products" for c in fake.calls)
    _assert_verified(t)
    # every Strong rules match keeps its product; the LLM's disagreement is recorded and lowers it to Close
    rules = matcher.match_positions(t["positions"], list(pipeline.catalog().values()), use_llm=False)
    by_lv = {p["lv_id"]: p for p in t["positions"]}
    strong = [lv for lv, m in rules.items() if m["label"] == "Strong"]
    assert strong
    for lv in strong:
        m = by_lv[lv]["match"]
        assert m["product_id"] == rules[lv]["product_id"], lv
        if m.get("llm_disagreed"):
            assert m["label"] == "Close" and any("AI check" in a for a in m["assumptions"])
    assert sum(1 for lv in strong if by_lv[lv]["match"].get("llm_disagreed")) > 0


def test_combine_rules_not_strong_lets_llm_decide_among_valid_candidates():
    cands = [{"product_id": "A", "_type_ok": True, "_size": 0}, {"product_id": "B", "_type_ok": True, "_size": 1}]
    rules = {"product_id": "A", "confidence": 0.7, "label": "Close", "method": "rules", "assumptions": ["x"]}
    pick_b = {"product_id": "B", "confidence": 0.92, "label": "Strong", "method": "llm", "assumptions": []}
    assert matcher.combine_picks(rules, pick_b, cands)["product_id"] == "B"
    # "none" never removes a product the code found; it is recorded instead
    none = {"product_id": None, "confidence": 0.0, "label": "None", "method": "llm", "reason": "no fit"}
    kept = matcher.combine_picks(rules, none, cands)
    assert kept["product_id"] == "A" and kept["method"] == "rules" and kept["llm_disagreed"]
    # an LLM pick that fails the code check (wrong size) does not replace a code match
    cands[1]["_size"] = -1
    assert matcher.combine_picks(rules, pick_b, cands)["product_id"] == "A"
    # confirmation never lowers a Strong code match
    strong = {"product_id": "A", "confidence": 0.9, "label": "Strong", "method": "rules", "assumptions": []}
    low = {"product_id": "A", "confidence": 0.45, "label": "Weak", "method": "llm", "assumptions": []}
    assert matcher.combine_picks(strong, low, cands)["label"] == "Strong"


class _SlowFailingClient:
    """Every request waits (up to its timeout) and then fails: timeouts, 429s and broken JSON in turn."""

    def __init__(self, delay: float):
        self.delay, self.timeout, self.calls = delay, None, 0
        outer = self

        class Responses:
            def create(self, **kw):
                outer.calls += 1
                n = outer.calls
                time.sleep(min(outer.delay, outer.timeout or outer.delay))
                req = httpx.Request("POST", "https://api.openai.com/v1/responses")
                if n % 3 == 0:
                    raise _rate_limit("Rate limit reached for requests")
                if n % 3 == 1:
                    raise openai.APITimeoutError(request=req)
                from tests.test_llm_misc import _Resp
                return _Resp("{not json")

        self.responses = Responses()

    def with_options(self, timeout=None, **kw):
        self.timeout = timeout
        return self


def test_slow_failing_llm_is_bounded_by_the_time_budget(fake_llm, tenders, monkeypatch):
    monkeypatch.setattr(llm, "PIPELINE_BUDGET", 3.0)
    fake = fake_llm(_SlowFailingClient(delay=5.0))
    t, took = _run_demo()
    assert fake.calls > 0
    assert t["status"] == "ready", t.get("warnings")
    assert took < 40, took  # rules take a few seconds; the LLM may use at most the budget (+ one request)
    _assert_verified(t)
    assert llm.budget_left() is None  # the budget is released after the run


def test_time_budget_blocks_live_calls_but_not_cache(fake_llm):
    fake = fake_llm(FakeClient())
    schema = {"type": "object", "properties": {"a": {"type": "string"}}, "required": ["a"],
              "additionalProperties": False}
    llm.call_json("s", "cached", schema)
    with llm.time_budget(0):
        assert llm.call_json("s", "cached", schema) == {"a": "x"}  # cache hit still served
        with pytest.raises(llm.LLMUnavailable):
            llm.call_json("s", "new question", schema)
    assert len(fake.calls) == 1


def test_wrong_shaped_answers_fall_back_to_rules(fake_llm, tenders):
    fake_llm(FakeClient(lambda name, schema, user, kw: {"oops": [1, 2, 3]} if name != "tender_meta" else []))
    t, _ = _run_demo()
    assert t["status"] == "ready", t.get("warnings")
    _assert_verified(t)
    rules = matcher.match_positions(t["positions"], list(pipeline.catalog().values()), use_llm=False)
    for p in t["positions"]:
        if p["lv_id"] in rules:  # unusable answers change nothing: exactly the rules-only products
            assert (p.get("match") or {}).get("product_id") == rules[p["lv_id"]]["product_id"], p["lv_id"]
    json.dumps(t)  # state stays serialisable


def test_match_that_relies_on_an_llm_read_type_is_never_strong(fake_llm):
    def handler(name, schema, user, kw):
        if name == "normalize_types":
            return {lv: {"type_en": "supply air valve"} for lv in schema["properties"]}
        return {lv: {"product_id": sub["properties"]["product_id"]["enum"][0], "confidence": "high",
                     "reason": "x", "assumptions": []} for lv, sub in schema["properties"].items()}

    fake_llm(FakeClient(handler))
    p = {"lv_id": "X1", "text_de": "Sockelrohr V2A\nØ 10 cm Stk 1", "quantity": 1, "unit": "pc", "kind": "item"}
    m = matcher.match_positions([p])["X1"]
    assert m["product_id"] and m["label"] == "Close" and m["confidence"] <= 0.74
    assert any("type read by AI" in a for a in m["assumptions"])
