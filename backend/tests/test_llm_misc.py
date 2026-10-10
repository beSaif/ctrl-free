"""LLM client, cache, fallbacks; translate, meta, instructions, quotes.

Network-free: a FakeClient stands in for OpenAI. Tests marked `live` run only when a real call works.
"""
from __future__ import annotations

import json
import re
from types import SimpleNamespace

import httpx
import openai
import pytest

from app import config, instructions, llm, matcher, meta, quotes, translate
from scripts.eval_matcher import build_example_positions


# --------------------------------------------------------------------------- fake OpenAI client

def schema_default(schema: dict):
    t = schema.get("type")
    if "enum" in schema:
        return schema["enum"][0]
    if t == "object":
        return {k: schema_default(v) for k, v in schema.get("properties", {}).items()}
    if t == "array":
        return []
    if t == "integer":
        return 0
    if t == "number":
        return 0.0
    if t == "boolean":
        return False
    return "x"


class _Resp:
    def __init__(self, text):
        self.output_text = text
        self.usage = SimpleNamespace(input_tokens=100, output_tokens=20)
        self.output = []


class FakeClient:
    """Mimics client.responses.create with strict json_schema output."""

    def __init__(self, handler=None, fail_first_with=None):
        self.calls = []
        self.handler = handler or (lambda name, schema, user, kw: schema_default(schema))
        self.fail_first_with = fail_first_with
        outer = self

        class Responses:
            def create(self, **kw):
                outer.calls.append(kw)
                if outer.fail_first_with is not None:
                    e, outer.fail_first_with = outer.fail_first_with(kw), None
                    if e is not None:
                        raise e
                fmt = kw["text"]["format"]
                assert fmt["type"] == "json_schema" and fmt["strict"] is True
                user = kw["input"][1]["content"]
                return _Resp(json.dumps(outer.handler(fmt["name"], fmt["schema"], user, kw), ensure_ascii=False))

        self.responses = Responses()

    def with_options(self, **kw):
        return self


@pytest.fixture
def fake_llm(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "LLM_CACHE_DIR", tmp_path)
    monkeypatch.setattr(config, "OPENAI_API_KEY", "test-key")
    monkeypatch.setattr(config, "AZURE_OPENAI_ENDPOINT", None)
    monkeypatch.setattr(config, "LLM_OFFLINE", False)

    def install(client):
        llm.reset(client)
        return client

    yield install
    llm.reset(None)


@pytest.fixture
def offline(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "LLM_CACHE_DIR", tmp_path)
    monkeypatch.setattr(config, "LLM_OFFLINE", True)
    llm.reset(None)
    yield
    llm.reset(None)


def _bad_request(msg):
    req = httpx.Request("POST", "https://api.openai.com/v1/responses")
    return openai.BadRequestError(msg, response=httpx.Response(400, request=req), body=None)


def _rate_limit(msg):
    req = httpx.Request("POST", "https://api.openai.com/v1/responses")
    return openai.RateLimitError(msg, response=httpx.Response(429, request=req), body=None)


SCHEMA = {"type": "object", "properties": {"answer": {"type": "string", "enum": ["a", "b"]}},
          "required": ["answer"], "additionalProperties": False}


# --------------------------------------------------------------------------- llm.py

def test_offline_without_cache_raises(offline):
    with pytest.raises(llm.LLMUnavailable):
        llm.call_json("s", "u", SCHEMA)


def test_cache_hit_works_offline(fake_llm, monkeypatch):
    fake = fake_llm(FakeClient())
    assert llm.call_json("sys", "user", SCHEMA, name="t") == {"answer": "a"}
    assert len(fake.calls) == 1
    monkeypatch.setattr(config, "LLM_OFFLINE", True)
    assert llm.call_json("sys", "user", SCHEMA, name="t") == {"answer": "a"}  # cache hit, no network
    assert llm.last_call_cached()
    assert len(fake.calls) == 1
    key = llm.cache_key(config.LLM_MODEL, "sys", "user", SCHEMA)
    assert (config.LLM_CACHE_DIR / f"{key}.json").exists()


def test_rejected_temperature_is_dropped_and_retried(fake_llm):
    def fail(kw):
        return _bad_request("Unsupported parameter: 'temperature' is not supported with this model.") if "temperature" in kw else None

    fake = fake_llm(FakeClient(fail_first_with=fail))
    assert llm.call_json("s", "u2", SCHEMA, temperature=0) == {"answer": "a"}
    assert "temperature" in fake.calls[0] and "temperature" not in fake.calls[1]


def test_account_error_disables_llm(fake_llm):
    fake_llm(FakeClient(fail_first_with=lambda kw: _rate_limit("Your account is not active (billing_not_active)")))
    with pytest.raises(llm.LLMUnavailable):
        llm.call_json("s", "u3", SCHEMA)
    assert not llm.available()


def test_map_concurrent_keeps_order_and_exceptions():
    def f(x):
        if x == 3:
            raise ValueError("boom")
        return x * 2

    out = llm.map_concurrent(f, range(6), max_workers=4)
    assert out[:3] == [0, 2, 4] and isinstance(out[3], ValueError) and out[4:] == [8, 10]


# --------------------------------------------------------------------------- translate.py

def test_rule_titles_offline(offline):
    ps, _ = build_example_positions()
    t = translate.translate_titles(ps, use_llm=False)
    assert t["LV0001"]["title_en"] == "Supply air valve, plastic, DN100"
    assert t["LV0002"]["title_en"].endswith("DN125")
    assert "400x300x1250 mm" in t["LV0006"]["title_en"]
    assert t["LV0016"]["title_en"].endswith("30 mm")


def test_translate_with_fake_llm_batches(fake_llm):
    def handler(name, schema, user, kw):
        assert name == "translate_titles"
        return {k: {"title_en": f"T {k}", "description_en": "d"} for k in schema["properties"]}

    fake = fake_llm(FakeClient(handler))
    ps, _ = build_example_positions()
    t = translate.translate_titles(ps, batch=10)
    assert len(fake.calls) == 3  # 22 positions / 10 per call
    assert t["LV0022"] == {"title_en": "T LV0022", "description_en": "d", "method": "llm"}


# --------------------------------------------------------------------------- meta.py

def test_meta_rules_oberglatt(offline):
    m = meta.extract_meta(pdf=config.DEMO_PDF, use_llm=False)
    assert m["name"] == "Neubau Primarschule Erlenstrasse, Oberglatt"
    assert m["client"] == "Gemeinde Oberglatt"
    assert m["trade"] == "BKP 244 Lüftungsanlagen"
    assert m["due_at"] == "2026-09-22T10:00:00"
    sr = m["submission_rule"]
    assert sr["page"] == 9 and sr["heading"].startswith("1.14 Adresse und Frist für die Einreichung")
    assert sr["text_de"].startswith("Das vollständige, unterzeichnete Angebot") and sr["text_de"].endswith("einzureichen.")
    assert sr["bbox"] is not None
    aw = {a["label"]: a["points"] for a in m["award_criteria"]}
    assert aw == {"Preis": 60, "Qualität": 25, "Leistungsfähigkeit": 10, "Lehrbetrieb": 5}
    assert m["meta_sources"]["due_at"] == 9


def test_meta_from_pages_text_only(offline):
    import pymupdf

    d = pymupdf.open(config.DEMO_PDF)
    m = meta.extract_meta({n: d[n - 1].get_text() for n in range(1, 16)}, use_llm=False)
    assert m["due_at"] == "2026-09-22T10:00:00" and m["client"] == "Gemeinde Oberglatt"


def test_meta_llm_translations_and_verification(fake_llm):
    def handler(name, schema, user, kw):
        d = schema_default(schema)
        d["submission_rule"] = {"page": 9, "heading": "h", "text_de": "invented text", "text_en": "The complete signed offer ..."}
        d["award_criteria"] = [{"label": "Preis", "points": 60, "page": 9, "rule_de": "x", "rule_en": "Points by linear interpolation"}]
        return d

    fake_llm(FakeClient(handler))
    m = meta.extract_meta(pdf=config.DEMO_PDF)
    assert m["method"] == "rules+llm"
    assert m["submission_rule"]["text_de"].startswith("Das vollständige")  # rules quote kept, LLM text not verbatim
    assert m["submission_rule"]["text_en"].startswith("The complete")
    assert m["award_criteria"][0]["rule_en"] == "Points by linear interpolation"


# --------------------------------------------------------------------------- instructions.py

@pytest.fixture(scope="module")
def examples():
    ps, gt = build_example_positions()
    return ps, matcher.match_positions(ps, use_llm=False)


def _page_text(n):
    import pymupdf

    return meta.join_lines(pymupdf.open(config.DEMO_PDF)[n - 1].get_text().splitlines())


def test_instructions_rules(offline, examples):
    ps, m = examples
    ins = instructions.extract_instructions(None, ps, pdf=config.DEMO_PDF, matches=m, use_llm=False)
    assert 10 <= len(ins) <= 20
    by_type = {i["type"]: i for i in ins}
    for t in ("Varianten", "Filter", "Brandschutzklappen", "Flexible Rohre", "Dichtheitsanforderungen", "Schalldämpfer",
              "Korrosionsschutz", "Transport", "Überschreiten der geforderten Werte", "Innendämmungen"):
        assert t in by_type, t
    assert by_type["Varianten"]["applies_label"] == "Product changes"
    assert by_type["Filter"]["kind"] == "cost" and "Ersatzfilterzellen" in by_type["Filter"]["text_de"]
    assert by_type["Brandschutzklappen"]["kind"] == "covered" and by_type["Brandschutzklappen"]["applies_to"] == ["LV0004"]
    assert by_type["Korrosionsschutz"]["kind"] == "cost" and by_type["Korrosionsschutz"]["applies_to"] == ["LV0021"]
    assert by_type["Transport"]["kind"] == "covered"
    assert by_type["Dichtheitsanforderungen"]["kind"] == "risk"
    assert by_type["Überschreiten der geforderten Werte"]["kind"] == "risk"
    assert by_type["Schalldämpfer"]["applies_to"] == ["LV0006", "LV0009", "LV0010", "LV0011"]
    ids = {p["lv_id"] for p in ps}
    for i in ins:
        assert meta.verbatim_in(i["text_de"], _page_text(i["page"]) + " " + _page_text(i["page"] + 1)), i["type"]
        assert set(i["applies_to"]) <= ids
        assert i["kind"] in ("cost", "risk", "scope", "covered") and i["why"]
        assert i["id"].startswith("i_") and i["state"] == "open"


def test_instructions_text_only_fallback(offline, examples):
    import pymupdf

    ps, m = examples
    d = pymupdf.open(config.DEMO_PDF)
    ins = instructions.extract_instructions({n: d[n - 1].get_text() for n in range(30, 50)}, ps, matches=m, use_llm=False)
    types = {i["type"] for i in ins}
    assert {"Varianten", "Schalldämpfer", "Korrosionsschutz"} <= types


def test_instructions_llm_quotes_are_verified(fake_llm, examples):
    ps, m = examples

    def handler(name, schema, user, kw):
        if name == "translate_texts":
            return {k: f"EN {k}" for k in schema["properties"]}
        payload = json.loads(user)
        rules = payload["rules"]
        items = []
        for r in rules[:5]:
            first = meta.split_sentences(r["text_de"])[0]
            items.append({"rule_id": r["rule_id"], "quote_de": first, "text_en": "EN", "kind": "scope", "why": "because"})
        items.append({"rule_id": rules[5]["rule_id"], "quote_de": "Dieser Satz steht nicht im Text.", "text_en": "EN",
                      "kind": "risk", "why": "w"})
        return {"instructions": items}

    fake_llm(FakeClient(handler))
    ins = instructions.extract_instructions(None, ps, pdf=config.DEMO_PDF, matches=m)
    assert len(ins) == 6
    for i in ins:
        assert meta.verbatim_in(i["text_de"], _page_text(i["page"]) + " " + _page_text(i["page"] + 1))
        assert i["method"] == "llm" and i["text_en"]


# --------------------------------------------------------------------------- quotes.py

def test_quote_groups_and_email(offline, examples):
    ps, m = examples
    ins = instructions.extract_instructions(None, ps, pdf=config.DEMO_PDF, matches=m, use_llm=False)
    groups = {g["id"]: g for g in quotes.group_for_quotes(ps, matches=m, instructions=ins)}
    assert groups["silencer"]["lv_ids"] == ["LV0006", "LV0010", "LV0011"]
    assert groups["silencer"]["rule_ref"] == "Schalldämpfer, S. 39"
    assert groups["flow_controller"]["lv_ids"] == ["LV0007", "LV0012"]
    assert groups["weatherproof_insulation"]["lv_ids"] == ["LV0018"]
    md = meta.extract_meta(pdf=config.DEMO_PDF, use_llm=False)
    d = quotes.draft_request(md, groups["silencer"], ps, ins, matches=m)
    assert d["subject"].startswith("Preisanfrage Schalldämpfer (3 Positionen)")
    body = d["body_de"]
    assert body.startswith("Guten Tag\n\nFür das Projekt Neubau Primarschule Erlenstrasse, Oberglatt")
    assert "LV0006 · Seite 80" in body and "4 Stk" in body
    assert "Anforderungen gemäss Ausschreibung (Schalldämpfer, S. 39):" in body
    assert "«Schalldämpfer ausgebildet als Absorptions-" in body
    assert "Netto-Einheitspreis, Lieferzeit und Gültigkeit" in body


@pytest.fixture(scope="module")
def demo_replies(tmp_path_factory):
    return quotes.make_demo_replies(tmp_path_factory.mktemp("demo"))


def test_read_demo_replies(offline, examples, demo_replies):
    ps, m = examples
    open_ids = {"LV0006", "LV0010", "LV0011", "LV0007", "LV0012", "LV0018"}
    openp = [p for p in ps if p["lv_id"] in open_ids]
    sil, vav = demo_replies[:2]
    props = {p["lv_id"]: p for p in quotes.read_supplier_reply(sil.read_bytes(), sil.name, openp, use_llm=False, matches=m)}
    assert {k: v["unit_price"] for k, v in props.items()} == {"LV0006": 2480.0, "LV0010": 5150.0, "LV0011": 3720.0}
    assert props["LV0010"]["source"] == "supplier_reply_silencers.pdf p.1 pos 2"
    assert "5'150.00" in props["LV0010"]["quoted_text"]
    props = {p["lv_id"]: p for p in quotes.read_supplier_reply(vav.read_bytes(), vav.name, openp, use_llm=False, matches=m)}
    assert {k: v["unit_price"] for k, v in props.items()} == {"LV0007": 3980.0, "LV0012": 3250.0}
    assert props["LV0007"]["source"].endswith("pos 10")


def test_read_plain_text_reply(offline, examples):
    ps, m = examples
    openp = [p for p in ps if p["lv_id"] in ("LV0018",)]
    text = ("Guten Tag\nGerne offerieren wir:\nWetterfeste Ummantelung V2A, Dämmung 100 mm   440 m2   à CHF 238.50   Total CHF 104'940.00\n"
            "Gültig 30 Tage.\n")
    props = quotes.read_supplier_reply(text, "mail.txt", openp, use_llm=False, matches=m)
    assert props and props[0]["lv_id"] == "LV0018" and props[0]["unit_price"] == 238.5


def test_read_reply_llm_prices_parsed_by_code(fake_llm, examples):
    ps, m = examples
    openp = [p for p in ps if p["lv_id"] in ("LV0007",)]
    text = "Angebot\nPos 7  Regler eckig Typ X  Menge 4  netto 3'990.00 je Stück\n"

    def handler(name, schema, user, kw):
        assert schema["properties"]["items"]["items"]["properties"]["lv_id"]["enum"] == ["LV0007"]
        return {"items": [{"lv_id": "LV0007", "line_text": "Pos 7  Regler eckig Typ X  Menge 4  netto 3'990.00 je Stück",
                           "unit_price_text": "3'990.00", "page": 1, "pos": "7"},
                          {"lv_id": "LV0007", "line_text": "not in reply 1'000.00", "unit_price_text": "1'000.00", "page": 1, "pos": ""}]}

    fake_llm(FakeClient(handler))
    props = quotes.read_supplier_reply(text, "reply.txt", openp, matches=m)
    assert len(props) == 1 and props[0]["unit_price"] == 3990.0 and props[0]["method"] == "llm"


# --------------------------------------------------------------------------- live (skipped without a working key)

def _live_ok() -> bool:
    if not llm.available():
        return False
    try:
        llm.call_json("Answer with a.", "ping", SCHEMA, name="ping")
        return True
    except (llm.LLMUnavailable, llm.LLMError):
        return False


@pytest.mark.skipif(not _live_ok(), reason="no working LLM key (offline, no key, or billing inactive)")
def test_live_meta_translation():
    m = meta.extract_meta(pdf=config.DEMO_PDF)
    assert m["method"] == "rules+llm" and m["submission_rule"]["text_en"]


# --------------------------------------------------------------------------- deterministic (no-LLM) paths

@pytest.mark.parametrize("de,en", [
    ("Kanaldichtheitsprüfung", "Duct tightness test"),
    ("Regenhut, 110 x 35 cm", "Rain cap, 1100 x 350 mm"),
    ("Zuluftgerät 1-1: Leerteil", "Supply air unit 1-1: empty section"),
    ("Farbbeschichtung nach NCS exkl. Sonderfarbzuschlag", "Colour coating to NCS excl. special colour surcharge"),
    ("Rohreinlagen unter Bodenplatte, Ø 250 mm", "Pipe inserts under floor board, DN250"),
    ("Brandschutzklappen eingemauert, Ø 10 cm", "Fire damper built into masonry, DN100"),
])
def test_glossary(de, en):
    assert translate.gloss(de)[0] == en


def test_glossary_titles_are_english(offline):
    ps = [{"lv_id": "A", "title_de": "Zuluft-Tellerventil aus Kunststoff, mit Luftmengeneinstellung, Ø 10 cm",
           "text_de": "Zuluft - Tellerventil\naus Kunststoff\nGrösse Ø 10 cm", "variant_de": "Ø 10 cm", "kind": "item"},
          {"lv_id": "B", "title_de": "Total Kanäle \"B\"", "kind": "subtotal"},
          {"lv_id": "C", "title_de": "Kanalrauchmelder", "text_de": "Kanalrauchmelder", "kind": "item"}]
    t = translate.translate_titles(ps)
    assert t["A"]["title_en"] == "Supply air valve, plastic, DN100" and t["A"]["method"] == "glossary"
    assert t["B"]["title_en"] == 'Total ducts "B"'
    assert t["C"]["title_en"] == "Duct smoke detector"


def test_text_en_glossary_marked(offline, examples):
    ps, m = examples
    md = meta.extract_meta(pdf=config.DEMO_PDF)
    assert md["submission_rule"]["text_en"].startswith("The complete, signed offer")
    assert md["submission_rule"]["text_en_method"] == "glossary"
    assert md["award_criteria"][0]["label_en"] == "Price"
    ins = instructions.extract_instructions(None, ps, pdf=config.DEMO_PDF, matches=m)
    assert all(i["text_en"] and i["text_en_method"] == "glossary" for i in ins)


def test_reply_lv_id_with_contradicting_size_is_ignored(offline, examples):
    ps, m = examples
    openp = [p for p in ps if p["lv_id"] in ("LV0006", "LV0011")]  # 400x300x1250 (4 pc), 540x400x1250 (6 pc)
    text = "1  Schalldämpfer 540 x 400 x 1250 mm (Ihre Pos. LV0006)  6 Stk  3'720.00  22'320.00\n"
    props = quotes.read_supplier_reply(text, "r.txt", openp, use_llm=False, matches=m)
    assert [(p["lv_id"], p["unit_price"]) for p in props] == [("LV0011", 3720.0)]
