"""Hourly work priced as labour, supplier request grouping, plain summaries built by code."""
from app import meta, pricing as P, quotes


def _pos(lv, **kw):
    base = {"lv_id": lv, "kind": "item", "quantity": 1.0, "unit": "pc", "system_key": "LA01", "section": "C",
            "section_name": "Armaturen und Instrumente", "page": 10, "title_de": "", "text_de": "",
            "match": {"product_id": None, "label": "None", "confidence": 0.2}, "attributes": {}}
    base.update(kw)
    base["match"] = {**base["match"], "attributes": base["attributes"]}
    return base


def test_hourly_work_is_priced_as_labour():
    p = _pos("LV0001", quantity=176.0, unit="h", title_de="Montage, Service- und Montagearbeitsstunde")
    ev = P.evaluate_position(p, {})
    pr = ev["pricing"]
    assert pr["unit_price_source"] == "labour" and pr["material"] == 0
    assert pr["rate"] == 96 and pr["role"] == "installer" and pr["labour"] == 176 * 96
    assert pr["explain"]["labour"] == "176.00 h × CHF 96/h (installer, hourly work) = CHF 16'896.00"
    assert ev["status"] == "assumption_applied" and ev["needs_review"]
    # commissioning work takes the commissioning rate; a catalogue product turns it back into a normal line
    c = P.evaluate_position(_pos("LV0002", quantity=21.0, unit="h", title_de="Einregulierung"), {})
    assert c["pricing"]["role"] == "commissioning_specialist"
    assert not P.is_hourly_work(_pos("LV0003", unit="h", overrides={"product_id": "P-AIR-001"}))


def test_quote_groups_fold_leftovers():
    ps = [
        _pos("LV0001", attributes={"type": "rain cap"}),
        _pos("LV0002", attributes={"type": "colour coating"}),      # goes with the rain cap before it
        _pos("LV0003", attributes={"type": "smoke detector"}, section="D", section_name="Regulierung"),
        _pos("LV0004", attributes={"type": "installation labour"}, section="E", section_name="Montage, Dienstleistungen"),
        _pos("LV0005", unit="h", quantity=10.0, attributes={"type": "installation labour"}, section="E",
             section_name="Montage, Dienstleistungen"),
        _pos("LV0006", attributes={"type": "air-handling unit"}, section="A", section_name="Apparate"),
        _pos("LV0007", attributes={"type": "silencer"}, section="A", section_name="Apparate", parent_lv_id="LV0006"),
    ]
    ps = P.evaluate_positions(ps, {})
    groups = {g["id"]: g for g in quotes.group_for_quotes(ps, catalog=[])}
    assert groups["weather_protection"]["lv_ids"] == ["LV0001", "LV0002"]
    assert groups["controls"]["lv_ids"] == ["LV0003"]
    assert groups["sec_montage_und_dienstleistungen"]["title"] == "Installation and services"
    assert groups["sec_montage_und_dienstleistungen"]["lv_ids"] == ["LV0004"]  # hourly work is not asked for
    assert groups["ahu"]["lv_ids"] == ["LV0006", "LV0007"]  # parts go with their parent device


def test_plain_summaries():
    crit = {"label": "Preis", "points": 60, "page": 9,
            "rule_de": "Die Punkte werden gemäss einer linearen Interpolation berechnet, welche beim tiefsten Angebot "
                       "mit 100 Punkten anfängt und bei 150 % des tiefsten Angebotes 0 Punkte erreicht."}
    s = meta.award_price_summary(crit, 100)
    assert s["summary_en"] == ("Price is worth 60 of 100 award points (p. 9). The lowest offer gets all 60; "
                               "an offer 50% above the lowest gets 0, linear in between.")
    assert s["summary_de"].startswith("Der Preis zählt 60 von 100 Zuschlagspunkten (S. 9).")
    rule = {"text_de": "Das vollständige, unterzeichnete Angebot (1-fach Papier sowie 1 USB-Datenträger mit sämtlichen "
                       "Dateien im pdf-Format und der SIA-Schnittstelle des Leistungsverzeichnisses) ist im verschlossenen "
                       "Umschlag (Couvert / Schachtel) bei der Beschaffungsstelle Gemeinde Oberglatt, Abteilung Immobilien, "
                       "Rümlangstrasse 8, 8145 Oberglatt bis zum 22. September 2026, 10.00 Uhr einzureichen."}
    sm = meta.submission_summary(rule, "2026-09-22T10:00:00", "Gemeinde Oberglatt")
    assert sm["short_en"] == ("Sealed envelope to Gemeinde Oberglatt: 1 paper copy and 1 USB stick with all files "
                              "as PDF and the SIA interface file.")
    assert sm["full_en"].endswith("Rümlangstrasse 8, 8145 Oberglatt, by 22.09.2026, 10:00.")
    assert meta.submission_summary({"text_de": "Siehe Beilage."}, None) is None
