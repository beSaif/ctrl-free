"""Verified against Equans examples: pipeline output on the demo PDF vs the golden numbers."""
from __future__ import annotations

from app import verification as V
from tests.test_api import base_id, client, pytestmark, tenders_dir  # noqa: F401  (shared fixtures)


def test_verification_route(client, base_id):
    r = client.get(f"/api/tenders/{base_id}/verification")
    assert r.status_code == 200, r.text
    v = r.json()
    assert v["loaded"]
    s = v["summary"]
    assert s["total"] == 22 and s["found"] == 22
    assert s["product_ok"] >= 20 and s["direct_ok"] >= 20
    rows = {x["example_id"]: x for x in v["rows"]}
    assert rows["LV0001"]["page"] == 78 and rows["LV0001"]["found"]
    assert len({x["our_lv_id"] for x in v["rows"]}) == 22  # one parsed line per example


def test_verification_without_benchmark(client, base_id, tmp_path):
    from app import store
    v = V.verify(store.load(base_id), benchmark_dir=tmp_path)
    assert v["loaded"] is False and v["rows"] == []


def test_verification_unknown_tender(client):
    assert client.get("/api/tenders/t_nope/verification").status_code == 404
