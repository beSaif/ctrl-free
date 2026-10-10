"""DE -> EN titles and short descriptions for positions (batched LLM, cached; rules fallback).

    translate_titles(positions, use_llm=None, batch=25, attrs_by_lv=None) -> {lv_id: {title_en, description_en, method}}

Fallback without LLM (method "glossary"): catalogue-like lines get an estimator-style title from the
normalized attributes ("Supply air valve, plastic, DN100"); everything else is translated with a
deterministic ventilation glossary (compound splitting, Ø 10 cm -> DN100). description_en is a rough
glossary gist when most words are known, else None.

    gloss(text) -> (english, coverage)          translate_texts(...) falls back to gloss() too
"""
from __future__ import annotations

import json
import re
from typing import Callable

from . import llm, matcher

SYSTEM = """You translate lines of a Swiss German ventilation (HVAC) tender into short estimator-style English.
For each line return:
- title_en: at most 9 words, product type first, then material/finish and the line's OWN size (the 'own_row'), e.g.
  "Supply air valve, plastic, DN100", "Rectangular silencer 400x300x1250 mm", "Thermal duct insulation, mineral wool 30 mm",
  "Fire damper EI90-S with actuator, DN100", "Installation and transport". Use DN for round sizes (Ø 12.5 cm = DN125) and mm for rectangular sizes.
- description_en: one plain sentence (max 30 words) with the key requirements of the block. No prices, no invented facts.
Use the size values given in 'code_attributes' when present; they were converted by code."""

MATERIAL_EN = {"plastic": "plastic", "galvanized steel": "galvanised", "stainless steel": "stainless steel", "aluminium": "aluminium"}

# --------------------------------------------------------------------------- deterministic glossary translator
# Generic Swiss German building-services vocabulary (no tender-specific rows). Used when no LLM is available.

# compound stems (lowercase) -> English; longest match first when splitting compounds
STEMS = {
    # air / ventilation
    "zuluft": "supply air", "abluft": "exhaust air", "fortluft": "discharge air", "aussenluft": "outdoor air",
    "umluft": "recirculated air", "rückluft": "return air", "frischluft": "fresh air", "luft": "air",
    "tellerventil": "air valve", "ventil": "valve", "teller": "disc", "gerät": "unit", "geräte": "units",
    "lüftungsgerät": "ventilation unit", "lüftung": "ventilation", "lüftungs": "ventilation", "anlage": "system",
    "brandschutzklappe": "fire damper", "brandschutz": "fire protection", "brand": "fire", "klappe": "damper",
    "drossel": "balancing", "jalousie": "louvre", "motor": "motor", "absperr": "shut-off", "rückschlag": "non-return",
    "schalldämpfer": "silencer", "schalldämm": "sound-absorbing", "schall": "sound", "dämpfer": "attenuator",
    "kompakt": "compact", "kulisse": "splitter", "kulissen": "splitters",
    "volumenstromregler": "air volume controller", "volumenstrom": "volume flow", "regler": "controller",
    "einkanal": "single-duct", "kanal": "duct", "kanäle": "ducts", "rohr": "pipe", "rohre": "pipes",
    "spiro": "spiral", "wickelfalz": "spiral-seam", "bogen": "bend", "bögen": "bends", "formstück": "fitting",
    "reduktion": "reducer", "abzweig": "branch", "endstück": "end piece", "mittelstück": "middle piece", "stück": "piece",
    "dämmung": "insulation", "dämmungen": "insulation", "aussendämmung": "external insulation",
    "innendämmung": "internal insulation", "isolation": "insulation", "mineralwolle": "mineral wool",
    "mineralwoll": "mineral wool", "matte": "mat", "matten": "mats", "platte": "board", "platten": "boards",
    "folie": "foil", "alu": "aluminium", "blech": "sheet metal", "stahlblech": "sheet steel", "stahl": "steel",
    "lochblech": "perforated sheet", "verkleidung": "cladding", "ummantelung": "cladding", "dekor": "decorative",
    "gitter": "grille", "wetterschutz": "weather protection", "regenhut": "rain cap", "lamellenhut": "louvre cap",
    "lamelle": "louvre", "lamellen": "louvres", "hut": "cap", "säule": "column", "säulen": "column",
    "revisionsdeckel": "inspection cover", "revisisondeckel": "inspection cover", "deckel": "cover",
    "revision": "inspection", "kontroll": "inspection", "putz": "cleaning", "durchdringung": "penetration",
    "durchführung": "penetration", "abschottung": "fire stop", "wand": "wall", "wände": "walls", "decke": "ceiling",
    "decken": "ceiling", "boden": "floor", "dach": "roof", "flachdach": "flat roof", "mauer": "wall",
    "montage": "installation", "einbau": "installation", "transport": "transport", "inbetriebsetzung": "commissioning",
    "inbetriebsetzen": "commissioning", "inbetriebnahme": "commissioning", "einregulierung": "balancing",
    "einregulieren": "balancing", "kassette": "cassette", "lampe": "lamp", "lampen": "lamp", "leer": "empty",
    "teil": "section", "tropfenabscheider": "droplet separator", "kühler": "cooler", "erhitzer": "heater",
    "batterie": "coil", "fühler": "sensor", "temperatur": "temperature", "feuchte": "humidity", "druck": "pressure",
    "differenz": "differential", "wächter": "switch", "frostschutz": "frost protection", "rauchmelder": "smoke detector",
    "rauch": "smoke", "melder": "detector", "antrieb": "actuator", "dreh": "rotary", "stell": "positioning",
    "thermometer": "thermometer", "zeiger": "dial", "rahmen": "frame", "schild": "label", "schilder": "labels",
    "bezeichnung": "labelling", "bezeichnungs": "labelling", "farbe": "colour", "farb": "colour", "pfeil": "arrow",
    "pfeile": "arrows", "beschichtung": "coating", "sonder": "special", "zuschlag": "surcharge",
    "potential": "equipotential", "verbindung": "connection", "ausgleich": "bonding", "manschette": "collar",
    "dehnung": "expansion", "dehnungs": "expansion", "dichtheit": "tightness", "dichtheits": "tightness",
    "prüfung": "test", "segment": "segment", "doppelwandig": "double-walled", "wetterfest": "weatherproof",
    "luftmenge": "airflow", "luftmengen": "airflow", "menge": "volume", "mengen": "volume", "einstellung": "adjustment",
    "regulierung": "control", "sockel": "base", "verlängerung": "extension", "erd": "underground",
    "verlegung": "laying", "kragen": "collar", "ringraum": "annular gap", "dichtung": "seal",
    "einlage": "insert", "einlagen": "inserts", "statisch": "structural", "berechnung": "calculation",
    "versand": "shipping", "kosten": "costs", "fracht": "freight", "verpackung": "packaging", "front": "front",
    "führung": "guide", "element": "element", "elemente": "elements", "unterkonstruktion": "substructure",
    "überströmer": "transfer air unit", "überström": "transfer air", "einbausatz": "installation kit", "satz": "set",
    "wirbel": "swirl", "strahl": "jet", "auslass": "outlet", "durchlass": "outlet", "düse": "nozzle", "düsen": "nozzle",
    "anschluss": "connection", "winkel": "angle", "winkle": "angle", "füsse": "feet", "fuss": "foot",
    "schiene": "rail", "profil": "profile", "aufhängung": "hanger", "aufhänge": "hanging", "draht": "wire",
    "geflecht": "mesh", "schlitz": "slot", "schieber": "slide", "klassenzimmer": "classroom", "zimmer": "room",
    "schulzimmer": "classrooms", "team": "team", "büro": "office", "büros": "offices", "gruppenraum": "group room",
    "gruppenräume": "group rooms", "räume": "rooms", "raum": "room", "küche": "kitchen", "küchen": "kitchen",
    "abwäscherei": "dishwashing", "abwaschen": "dishwashing", "essen": "dining", "nebenräume": "ancillary rooms",
    "turnhalle": "sports hall", "feld": "field", "gebäude": "building", "automation": "automation",
    "dienstleistungen": "services", "apparate": "equipment", "armaturen": "fittings", "instrumente": "instruments",
    "zwischentotal": "subtotal", "total": "total", "arbeit": "work", "stunde": "hour", "stunden": "hours",
    "service": "service", "ende": "end", "filter": "filter", "ventilator": "fan", "ventilatoren": "fans",
    "wärme": "heat", "rückgewinnung": "recovery", "tauscher": "exchanger", "misch": "mixing", "kälte": "cooling",
    "heizung": "heating", "steuerung": "control", "schalt": "switch", "schrank": "cabinet", "kabel": "cable",
    "material": "material", "materialien": "materials", "hygiene": "hygiene", "dokumentation": "documentation",
    "plan": "plan", "pläne": "drawings", "schema": "diagram", "garantie": "warranty", "flexibel": "flexible",
    "befestigung": "fixing", "befestigungs": "fixing", "dübel": "anchors", "schrauben": "screws", "korrosion": "corrosion",
    "schutz": "protection", "geräusch": "noise", "pegel": "level", "wert": "value", "werte": "values",
    "abschnitt": "section", "lieferung": "delivery", "liefer": "delivery", "zeit": "time", "frist": "deadline",
    "angebot": "offer", "angebots": "offer", "umschlag": "envelope", "datenträger": "data carrier", "papier": "paper",
    "schnittstelle": "interface", "leistungsverzeichnis": "bill of quantities", "leistungsverzeichnisses": "bill of quantities",
    "beschaffung": "procurement", "beschaffungsstelle": "procurement office", "abteilung": "department",
    "immobilien": "real estate", "unterzeichnet": "signed", "verschlossen": "sealed", "vollständig": "complete",
    "gemeinde": "municipality", "aufschrift": "label", "nummer": "number", "punkte": "points", "punkt": "point",
    "gewichtung": "weighting", "angestellte": "employees", "lernende": "apprentices", "referenz": "reference",
    "referenzen": "references", "projekt": "project", "projekte": "projects", "komplexität": "complexity",
    "schlüssel": "key", "person": "person", "kapazität": "capacity", "nachweis": "proof", "mitarbeiter": "staff",
    "prozent": "percent", "ausführung": "execution", "ausführungs": "execution", "fristen": "deadlines",
    "messung": "measurement", "nachprüfung": "re-test", "nachprüfungen": "re-tests", "folge": "follow-up",
    "unternehmer": "contractor", "bauherr": "client", "bauherrschaft": "client", "feuerpolizei": "fire authority",
    "gebäudeversicherung": "building insurance", "kontrollöffnung": "inspection opening", "öffnung": "opening",
    "stellung": "position", "end": "end", "endschalter": "limit switch", "schalter": "switch", "kontakt": "contact",
    "thermostat": "thermostat", "anzeige": "indication", "endstellung": "end position", "endstellungen": "end positions",
    "schaltschrank": "control cabinet", "absorption": "absorption", "absorptions": "absorption", "relaxation": "relaxation",
    "relaxations": "relaxation", "frequenzband": "frequency band", "frequenz": "frequency", "band": "band",
    "abdeckung": "cover", "lochblechabdeckung": "perforated-sheet cover", "nitrostahl": "nitro steel", "bride": "clamp band",
    "schlauch": "hose", "schläuche": "hoses", "messe": "measurement", "eurovent": "Eurovent", "norm": "standard",
    "normen": "standards", "suissetec": "Suissetec", "schiebefälze": "slide-in seams", "schiebefalz": "slide-in seam",
    "satzersatz": "spare set", "ersatz": "spare", "zelle": "cell", "zellen": "cells", "qualität": "quality",
    "aufhängematerial": "hanging material", "ausführung": "design", "promat": "Promat", "montageort": "installation site",
    "ort": "site", "inbetrieb": "commissioning", "änderung": "change", "überschreitung": "exceedance",
    "überschreitungen": "exceedances", "zusammenhang": "connection", "schalen": "shells", "kitt": "sealant",
    "mauerwerk": "masonry", "durchbruch": "opening", "durchbrüche": "openings", "mischung": "mixing", "schikane": "baffle",
    "schikanen": "baffles", "ausrüstung": "equipment", "zubehör": "accessories", "zubehörteile": "accessories",
    "betrieb": "operation", "arbeiten": "works", "gültigkeit": "validity", "festpreis": "fixed price",
    "festpreise": "fixed prices", "offertpreise": "offer prices", "bauvollendung": "completion of construction",
    "interpolation": "interpolation", "angebotssumme": "offer sum", "minuspunkte": "negative points",
    "gruppenräum": "group rooms", "ton": "shade", "farbton": "colour shade", "hohe": "high", "hoch": "high",
}

WORDS = {
    # function words and common words
    "und": "and", "oder": "or", "mit": "with", "ohne": "without", "für": "for", "aus": "of", "in": "in", "im": "in the",
    "an": "on", "am": "at the", "auf": "on", "bei": "at", "zu": "to", "zum": "to the", "zur": "to the", "von": "of",
    "vom": "from the", "nach": "to", "durch": "through", "unter": "under", "über": "over", "bis": "up to", "ab": "from",
    "der": "the", "die": "the", "das": "the", "den": "the", "dem": "the", "des": "of the", "ein": "a", "eine": "a",
    "einer": "a", "eines": "a", "einem": "a", "einen": "a", "je": "per", "pro": "per", "als": "as", "wie": "as",
    "gemäss": "as per", "gem": "as per", "inkl": "incl.", "exkl": "excl.", "einschl": "incl.", "bzw": "or", "sowie": "and",
    "nicht": "not", "kein": "no", "keine": "no", "falls": "if", "sofern": "if", "wenn": "if", "aller": "all",
    "alle": "all", "sämtliche": "all", "sämtliches": "all", "jede": "every", "jeder": "every", "jedes": "every",
    "bestehender": "existing", "zusätzliche": "additional", "zusätzlich": "additional", "zusätzlichen": "additional",
    "ist": "is", "sind": "are", "wird": "is", "werden": "are", "muss": "must", "müssen": "must", "darf": "may",
    "dürfen": "may", "hat": "has", "haben": "have", "kann": "can", "soll": "shall", "sollen": "shall",
    "nur": "only", "auch": "also", "generell": "generally", "mindestens": "at least", "mind": "min.",
    "ca": "approx.", "z.b": "e.g.", "zb": "e.g.", "etc": "etc.", "usw": "etc.", "dies": "this", "diese": "these",
    "beidseits": "on both sides", "beidseitig": "on both sides", "beidseitiger": "on both sides", "einseitig": "one-sided",
    "eckig": "rectangular", "rechteckig": "rectangular", "runde": "round", "rund": "round", "runden": "round",
    "variabel": "variable", "variable": "variable", "variabler": "variable", "konstant": "constant", "konstanten": "constant",
    "vol": "volume", "strom": "flow", "isolierte": "insulated", "isoliert": "insulated", "luftdicht": "airtight",
    "luftdichte": "airtight", "abriebfest": "abrasion-resistant", "gestiftet": "pinned", "eingemauert": "built into masonry",
    "fest": "fixed", "arretierbar": "lockable", "hochdämmenden": "highly insulating", "hochdämmend": "highly insulating",
    "lackiert": "painted", "sichtbare": "visible", "sichtbar": "visible", "oben": "top", "unten": "bottom",
    "hinten": "rear", "vorne": "front", "länge": "length", "kunststoff": "plastic", "verzinkt": "galvanised",
    "verzinktem": "galvanised", "verzinkter": "galvanised", "sendzimirverzinkt": "galvanised", "sendizimierverzinkt": "galvanised",
    "thermische": "thermal", "thermisch": "thermal", "wetterfeste": "weatherproof", "doppelwandige": "double-walled",
    "bauseits": "by others", "gelieferten": "supplied", "geliefert": "supplied", "ausschreibung": "tender",
    "abziehen": "removing", "reinigen": "cleaning", "austausch": "replacement", "statische": "structural",
    "abdichtung": "sealing", "fckw-freiem": "CFC-free", "polyurethan": "polyurethane", "drahtgeflecht": "wire mesh",
    "brandabschnittsbildende": "fire-compartment", "brandabschnittsbildenden": "fire-compartment",
    "versandkosten": "shipping costs", "handling": "handling", "baureihe": "series", "typ": "type", "fabrikat": "make",
    "grösse": "size", "material": "material", "change-over-batterie": "change-over coil", "nm": "Nm",
    "vorgeschriebene": "specified", "andere": "other", "materialien": "materials", "offeriert": "offered",
    "variante": "variant", "entsprechenden": "corresponding", "begründung": "justification", "technisch": "technically",
    "besser": "better", "gleichwertig": "equivalent", "preisgünstiger": "cheaper", "ähnliches": "similar",
    "geschehen": "be done", "submission": "tender", "satz": "set", "gleicher": "same", "mitzuliefern": "to be supplied",
    "eingerechnet": "included in the price", "einzurechnen": "to be included in the price", "verzinkter": "galvanised",
    "sache": "responsibility", "unternehmers": "contractor's", "erste": "first", "vergütet": "paid", "forderungen": "requirements",
    "erfüllt": "met", "allfällige": "any", "tragen": "bear", "zuständigen": "responsible", "kantonalen": "cantonal",
    "anerkannt": "approved", "unmittelbar": "directly", "vor": "before", "klappe": "damper", "aussen": "outside",
    "ersichtlich": "visible", "elektrischem": "electrical", "öffnungs": "opening", "schliesskontakt": "closing contact",
    "ausgerüstet": "equipped", "beiden": "both", "ausgebildet": "designed", "breitbandiger": "broadband",
    "dämpfung": "attenuation", "schalldämpfung": "sound attenuation", "ganze": "whole", "anzugeben": "to be stated",
    "brennbarem": "combustible", "hygroskopischem": "hygroscopic", "hygrostatischen": "hygrostatic", "folien": "foils",
    "ausgenommen": "except", "trockene": "dry", "auszuführen": "to be executed", "nichtbrennbaren": "non-combustible",
    "flexible": "flexible", "verwendet": "used", "breiten": "wide", "anschluss": "connection", "umwickelt": "wrapped",
    "vorstehen": "project", "ergeben": "arise", "sich": "", "geforderten": "required", "belastet": "charged",
    "entstehenden": "arising", "innendämmungen": "internal insulation", "zugelassen": "permitted", "transport": "transport",
    "unternehmer": "contractor", "dem": "the", "mit": "with", "vorschriften": "regulations", "bestimmungen": "provisions",
    "richtlinien": "guidelines", "örtlichen": "local", "kantonaler": "cantonal", "energiefachstellen": "energy offices",
    "ausführung": "execution", "dämmungen": "insulation", "gelten": "apply", "gilt": "applies", "einzureichen": "to be submitted",
    "verschlossenen": "sealed", "unterzeichnete": "signed", "vollständige": "complete", "sämtlichen": "all",
    "dateien": "files", "format": "format", "pdf-format": "PDF format", "fach": "copy", "beschaffungsstelle": "procurement office",
    "uhr": "", "september": "September", "oktober": "October", "november": "November", "dezember": "December",
    "januar": "January", "februar": "February", "märz": "March", "april": "April", "mai": "May", "juni": "June",
    "juli": "July", "august": "August", "punkte": "points", "linearen": "linear", "berechnet": "calculated",
    "welche": "which", "beim": "at the", "tiefsten": "lowest", "anfängt": "starts", "erreicht": "reaches", "es": "there",
    "gibt": "are", "so": "thus", "ermittelten": "determined", "anschliessend": "then", "multipliziert": "multiplied",
    "pkt": "pts", "zwei": "two", "anbieters": "bidder", "vergleichbare": "comparable", "ähnlicher": "similar",
    "älter": "older", "jahre": "years", "zugewiesenen": "assigned", "anzahl": "number", "einhaltung": "compliance",
    "anbieter": "bidders", "ausbilden": "train", "erhalten": "receive", "abhängig": "depending", "vom": "on the",
    "verhältnis": "ratio", "zu": "to", "angestellten": "employees", "lehrbetrieb": "training company",
    "preis": "price", "leistungsfähigkeit": "capacity", "qualität": "quality", "hohe": "high", "hohen": "high",
    "sein": "be", "geräuscharme": "low-noise", "wirkungsgraden": "efficiency", "wirkungsgrad": "efficiency",
    "motorengetätigte": "motor-operated", "gegenläufigen": "opposed", "hohllamellenprofilen": "hollow blade profiles",
    "lagern": "bearings", "nylon": "nylon", "dichtheitsanforderung": "tightness requirement", "zweckentsprechend": "suitably",
    "mengenreguliereinheit": "volume control unit", "gleichmässige": "uniform", "einströmgeschwindigkeit": "inlet velocity",
    "ausströmgeschwindigkeit": "outlet velocity", "aus-": "outlet", "gewährleisten": "ensure", "verpflichtet": "obliged",
    "einwandfreie": "proper", "einwandfreien": "proper", "notwendig": "necessary", "notwendigen": "necessary",
    "einzuschliessen": "to include", "erforderlichen": "required", "erforderlich": "required", "normalen": "normal",
    "einzeln": "individually", "aufgeführt": "listed", "ausmass": "bill of quantities", "couvert": "envelope",
    "schachtel": "box", "promatverzinkt": "Promat-galvanised", "z.t": "partly", "zt": "partly", "dafür": "for this",
    "besorgt": "responsible", "fremdinstallationen": "third-party installations", "befestigt": "fixed",
    "kopfgedämmt": "head-insulated", "schwingungsdämpfer": "vibration dampers", "schwingungsfrei": "vibration-free",
    "montiert": "installed", "berührung": "contact", "baukörper": "building structure", "direkte": "direct",
    "geprüft": "tested", "überprüft": "checked", "anordnung": "order", "musterkanal": "sample duct",
    "fertig": "fully", "kanalabschnitten": "duct sections", "einrichtungen": "facilities", "hilfeleistungen": "assistance",
    "erbringen": "provide", "leckluftmengen": "leakage air volumes", "ausgeschriebenen": "specified",
    "dichtheitsklassen": "tightness classes", "ausgabe": "edition", "erfüllen": "meet", "bewährte": "proven",
    "betriebssichere": "reliable", "volle": "full", "unterhalt": "maintenance", "garantieservice": "warranty service",
    "übernommen": "assumed", "fabrikate": "makes", "temperaturmischung": "temperature mixing", "schichtungen": "stratification",
    "garantieren": "guarantee", "filterzellen": "filter cells", "ersatzfilterzellen": "spare filter cells",
    "differenzdruckmanometer": "differential pressure gauge", "anzeigenden": "indicating", "filterteil": "filter section",
    "auszurüsten": "to be equipped", "mineralwollplatten": "mineral wool boards", "vorstehen": "project",
    "zurückzuschneiden": "to be cut back", "dauerelastischem": "permanently elastic", "auszufugen": "to be jointed",
    "schallschutz": "sound insulation", "innerhalb": "inside", "ausserhalb": "outside", "gebäudes": "building",
    "grenzwerte": "limit values", "resp": "or", "raumkonditionsblätter": "room condition sheets",
    "isolsuisse": "IsolSuisse", "dämmstärken": "insulation thicknesses", "ausführungsart": "type of execution",
    "materialspezifikation": "material specification", "aussenliegender": "external", "maschengitter": "wire mesh",
    "chromnickelstahl": "chrome-nickel steel", "stösse": "joints", "fugen": "seams", "klebeband": "adhesive tape",
    "verklebt": "taped", "dampfsperre": "vapour barrier", "geeignet": "suitable", "stiften": "pins", "clips": "clips",
    "sichern": "secure", "schutzköpfen": "protective caps", "abzuschneiden": "to be cut off", "vorstehenden": "protruding",
    "aufhängungen": "hangers", "kanalverbindungen": "duct joints", "anzubringen": "to be fitted", "möglich": "possible",
    "immer": "ever", "seitenwänden": "side walls", "nieten": "rivets", "parkerschrauben": "self-tapping screws",
    "ang": "spec.", "arch": "architect", "architekten": "architect", "wunsch": "request", "zuschlag": "award",
}

_UNKNOWN_KEEP = re.compile(r"^[A-Z0-9][A-Z0-9\-./]+$")  # model codes like TVR-D, BM0, NCS


def _gloss_word(w: str) -> str | None:
    low = w.lower().strip(".")
    if not low:
        return w
    if low in WORDS:
        return WORDS[low]
    if low in STEMS:
        return STEMS[low]
    for suf in ("en", "em", "er", "es", "e", "n", "s"):
        if low.endswith(suf) and len(low) - len(suf) >= 3:
            b = low[: -len(suf)]
            if b in WORDS:
                return WORDS[b]
            if b in STEMS:
                return STEMS[b]
    return _split_compound(low)


_STEM_KEYS = sorted(STEMS, key=len, reverse=True)


def _split_compound(low: str) -> str | None:
    """Stem split with backtracking ('kanaldichtheitsprüfung' -> duct tightness test, 'rohreinlagen' -> pipe inserts)."""
    from functools import lru_cache

    n = len(low)

    @lru_cache(maxsize=None)
    def go(i: int):
        if i == n:
            return ()
        if low[i:] in ("e", "en", "n", "er", "es", "em", "s"):
            return ()
        best = None
        for k in _STEM_KEYS:
            if low.startswith(k, i):
                rest = go(i + len(k))
                if rest is not None:
                    cand = (STEMS[k],) + rest
                    if best is None or len(cand) < len(best):
                        best = cand
                if best is not None and len(best) == 1:
                    break
        if best is None and i > 0 and low[i] in "s-":  # linking 's' / hyphen
            best = go(i + 1)
        return best

    r = go(0)
    return " ".join(r) if r else None


def _sizes_en(text: str) -> str:
    def dn(m):
        v = float(m.group(1).replace(",", "."))
        unit = (m.group(2) or "").lower()
        mm = v * 10 if unit == "cm" or (not unit and v < 64) else v
        return f"DN{int(round(mm))}"

    text = re.sub(r"(?:Ø|ø|⌀)\s*(\d+(?:[.,]\d+)?)\s*(cm|mm)?", dn, text)
    text = re.sub(r"(\d+(?:[.,]\d+)?)\s*(?:Ø|ø|⌀)\s*(cm|mm)?", dn, text)
    text = re.sub(r"\bDN\s+(\d+)", r"DN\1", text)

    def dims(m):
        vals = [float(g.replace(",", ".")) for g in m.groups()[:3] if g]
        f = 10 if (m.group(4) or "").lower() == "cm" else 1
        return " x ".join(f"{v * f:g}" for v in vals) + " mm"

    text = re.sub(r"(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)(?:\s*[x×]\s*(\d+(?:[.,]\d+)?))?\s*(cm|mm)\b", dims, text)
    return text


def gloss(text: str) -> tuple[str, float]:
    """Word-by-word DE->EN using the glossary. Returns (english, coverage 0..1). Model codes are kept."""
    if not text:
        return "", 1.0
    text = _sizes_en(text)
    out, known, total = [], 0, 0
    for tok in re.split(r"(\s+|[,;:()«»\"„“]|(?<=\w)/(?=\w))", text):
        if not tok or tok.isspace() or re.fullmatch(r"[,;:()«»\"„“/]", tok):
            out.append(tok or "")
            continue
        core = tok.strip(".")
        if re.fullmatch(r"[\d'’.,/\-x×%+°]+|DN\d+|mm|cm|m2|m²|m3/h|m³/h|Pa|dB|Hz|kg/m3|V|kW|Stk", core) or _UNKNOWN_KEEP.match(core):
            out.append(tok)
            continue
        total += 1
        parts = re.split(r"([-/])", core) if re.search(r"[-/]", core) and not _gloss_word(core) else [core]
        tr = []
        ok = True
        for part in parts:
            if part in ("-", "/"):
                if part == "/":
                    tr.append("/")
                continue
            g = _gloss_word(part) if part else ""
            if g is None:
                ok = False
                tr.append(part)
            else:
                tr.append(g)
        if ok:
            known += 1
        word = " ".join(t for t in tr if t)
        if tok.endswith(".") and not core.lower() in ("inkl", "exkl", "einschl", "bzw", "ca", "mind", "gem", "pkt", "vol"):
            word += "."
        out.append(word)
    s = "".join(out)
    s = re.sub(r"\b(\w+) \1\b", r"\1", s)            # 'air air valve' -> 'air valve'
    s = re.sub(r"\s+([,.;:)])", r"\1", s)
    s = re.sub(r"\(\s+", "(", s)
    s = re.sub(r"\s{2,}", " ", s).strip()
    s = s.replace("e.g..", "e.g.").replace("..", ".")
    s = re.sub(r"(\S+)([.!?]\s+)([a-z])",
               lambda m: m.group(0) if (m.group(1) + ".").lower().endswith(("incl.", "excl.", "e.g.", "approx.", "min.", "spec.", "volume.", "no."))
               else m.group(1) + m.group(2) + m.group(3).upper(), s)
    s = s[:1].upper() + s[1:]
    return s, (known / total if total else 1.0)


RULE_TITLE_FAMILIES = {"silencer", "fire_damper", "fire_seal", "insulation", "weatherproof_insulation", "flow_controller",
                       "damper", "air_terminal", "fire_access"}


def glossary_title(position: dict, attrs: dict | None = None) -> str | None:
    """Readable English title without an LLM."""
    a = attrs or matcher.normalize(position)
    fam = matcher.family_of(a.get("type"))
    if position.get("kind") in ("subtotal", "text_only"):
        fam = None
    if fam in RULE_TITLE_FAMILIES and a.get("type_source") == "rules":
        t = rule_title(position, a)
        if t:
            return t
    src = position.get("title_de") or (position.get("text_de") or "").split("\n")[0]
    g, cov = gloss(src)
    if cov >= 0.5 or not a.get("type"):
        return g or None
    return rule_title(position, a) or g


def rule_title(position: dict, attrs: dict | None = None) -> str | None:
    a = attrs or matcher.normalize(position)
    t = a.get("type")
    if not t:
        return None
    t = re.sub(r"\b(VAV|CAV)\s+", "", t) if t.startswith(("VAV", "CAV")) else t
    if t.startswith("variable volume flow controller") or t.startswith("constant volume flow controller"):
        t = t.replace(" circular", "").replace(" rectangular", "")
    if t.startswith("silencer ") and a.get("shape"):
        t = f"{a['shape']} silencer"
    parts = [t[0].upper() + t[1:]]
    if a.get("fire_class") and "fire" in t:
        parts[0] += f" {a['fire_class']}"
    if a.get("material") and a["material"] in MATERIAL_EN and not t.startswith(("weatherproof", "thermal")):
        parts.append(MATERIAL_EN[a["material"]])
    size = matcher.size_label(a)
    if size:
        parts.append(size)
    return ", ".join(parts)


def _payload(p: dict, a: dict) -> dict:
    return {
        "lv_id": p["lv_id"],
        "title_de": p.get("title_de"),
        "own_row": matcher._own_line(p),
        "unit": p.get("unit_raw") or p.get("unit"),
        "text_de": matcher._trim(p.get("text_de") or "", 1100),
        "code_attributes": {k: v for k, v in a.items() if v not in (None, [], "") and k in
                            ("type", "dn_mm", "dims_mm", "thickness_mm", "fire_class", "material", "angle_deg")},
    }


def translate_titles(positions: list[dict], use_llm: bool | None = None, batch: int = 25,
                     attrs_by_lv: dict | None = None, progress: Callable[[int, int], None] | None = None) -> dict[str, dict]:
    attrs_by_lv = attrs_by_lv or {}
    out: dict[str, dict] = {}
    for p in positions:
        a = attrs_by_lv.get(p["lv_id"]) or matcher.normalize(p)
        attrs_by_lv[p["lv_id"]] = a
        out[p["lv_id"]] = {"title_en": glossary_title(p, a), "description_en": glossary_description(p), "method": "glossary"}
    if use_llm is False or not positions:
        return out
    todo = [p for p in positions if (p.get("text_de") or p.get("title_de"))]

    def run(chunk):
        ids = [p["lv_id"] for p in chunk]
        schema = {
            "type": "object",
            "properties": {i: {"type": "object",
                               "properties": {"title_en": {"type": "string"}, "description_en": {"type": "string"}},
                               "required": ["title_en", "description_en"], "additionalProperties": False} for i in ids},
            "required": ids, "additionalProperties": False,
        }
        user = json.dumps([_payload(p, attrs_by_lv[p["lv_id"]]) for p in chunk], ensure_ascii=False, indent=1)
        return llm.call_json(SYSTEM, user, schema, name="translate_titles", temperature=0)

    chunks = llm.chunks(todo, batch)
    results = llm.map_concurrent(run, chunks, max_workers=8, progress=progress)
    for chunk, res in zip(chunks, results):
        if isinstance(res, Exception) or not res:
            continue
        for p in chunk:
            r = res.get(p["lv_id"]) or {}
            if r.get("title_en"):
                out[p["lv_id"]] = {"title_en": r["title_en"].strip(), "description_en": (r.get("description_en") or "").strip() or None,
                                   "method": "llm"}
    return out


def translate_texts_or_gloss(texts: dict[str, str], use_llm: bool | None = None,
                            context: str = "Swiss German construction tender") -> dict[str, tuple[str | None, str | None]]:
    """{key: (english, method)} with method "llm" or "glossary" (rough word-by-word gist)."""
    tr = translate_texts(texts, use_llm=use_llm, context=context)
    out = {}
    for k, de in texts.items():
        if tr.get(k):
            out[k] = (tr[k], "llm")
        else:
            g, cov = gloss(de)
            out[k] = (g, "glossary") if g and cov >= 0.5 else (None, None)
    return out


def translate_texts(texts: dict[str, str], use_llm: bool | None = None, context: str = "Swiss German construction tender") -> dict[str, str | None]:
    """Generic DE->EN for short texts (instructions, rules). Returns {key: english|None}."""
    if not texts or use_llm is False:
        return {k: None for k in texts}
    keys = list(texts)
    out: dict[str, str | None] = {k: None for k in keys}
    system = (f"Translate German text from a {context} into plain, faithful English. Keep numbers, norms and units. "
              "Do not summarise or add anything.")

    def run(chunk):
        schema = {"type": "object", "properties": {k: {"type": "string"} for k in chunk},
                  "required": chunk, "additionalProperties": False}
        return llm.call_json(system, json.dumps({k: texts[k] for k in chunk}, ensure_ascii=False, indent=1), schema,
                             name="translate_texts", temperature=0)

    chunks = llm.chunks(keys, 15)
    for chunk, res in zip(chunks, llm.map_concurrent(run, chunks)):
        if isinstance(res, Exception) or not res:
            continue
        for k in chunk:
            if res.get(k):
                out[k] = res[k].strip()
    return out


HINT_LINE = re.compile(r"^(Fabrikat|Typ|Farbe|Offerte|Regelfabrikat|Mod\.|_{3,})", re.I)


def glossary_description(position: dict) -> str | None:
    """Rough English gist of the block (first descriptive lines), only when the glossary covers most words."""
    lines = [l.strip() for l in str(position.get("text_de") or "").splitlines() if l.strip() and not HINT_LINE.match(l.strip())]
    if len(lines) < 2:
        return None
    g, cov = gloss(" ".join(lines[:4])[:400])
    return g if cov >= 0.7 else None
