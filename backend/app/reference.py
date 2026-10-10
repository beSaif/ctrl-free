"""Reference data: product catalogue, install rules and project parameters.

Loaded from ``app.config.REFERENCE_DIR`` (catalog.csv, productivity.csv,
project_parameters.json) and cached. ``import_reference`` validates a new file,
archives the current one under ``history/`` and replaces it.
"""
from __future__ import annotations

import copy
import csv
import io
import json
import shutil
from datetime import datetime
from functools import lru_cache
from pathlib import Path

from app import config

REFERENCE_DIR: Path = config.REFERENCE_DIR

FILES = {"catalog": "catalog.csv", "rules": "productivity.csv", "parameters": "project_parameters.json"}
KIND_ALIASES = {"catalog": "catalog", "catalogue": "catalog", "rules": "rules", "productivity": "rules",
                "install_rules": "rules", "parameters": "parameters", "params": "parameters",
                "project_parameters": "parameters"}

# Plain-word labels used in explain sentences, the UI and the report.
FACTOR_LABELS = {
    "site_efficiency": "site efficiency",
    "mounting_height_school": "ceiling height",
    "mounting_height_sports_hall": "sports hall ceiling height",
    "school_logistics": "school logistics",
    "timber_interface": "timber interface",
}
INVERTED_FACTORS = {"site_efficiency"}  # applied as 1 / value (README: "Apply site_efficiency as 1 / site_efficiency")
PROFILE_FACTOR_SWAP = {"sports_hall": {"mounting_height_school": "mounting_height_sports_hall"}}

PROJECT_COST_LABELS = {
    "engineering": "Engineering and project management",
    "commissioning": "Commissioning",
    "hygiene": "Hygiene inspection",
    "documentation": "Documentation",
}

SETTING_LABELS = {
    "competition": "How strong is the competition",
    "appetite": "How much we want this job",
    "sensitivity": "Client price sensitivity (win points per 1% above standard)",
    "ref_win": "Win chance at the standard price",
    "overhead_pct": "Overhead",
    "transport_pct": "Transport and equipment",
    "material_waste_pct": "Material waste",
    "small_material_pct": "Small material",
    "supplier_contingency_pct": "Supplier package contingency",
    "include_small_material": "Small material in the price",
    "include_supplier_contingency": "Supplier contingency in the price",
    "round_to": "Offer price rounded up to",
}

CATALOG_REQUIRED = ["product_id", "category", "description", "unit", "net_cost_chf", "install_code",
                    "source_type", "supplier_quote_required"]
RULES_REQUIRED = ["install_code", "work_type", "unit", "base_hours_per_unit", "labour_role",
                  "default_hourly_rate_chf", "factor_keys"]
PARAMS_REQUIRED = {
    "productivity_factors": ["site_efficiency"],
    "allowances": ["material_waste_pct", "small_material_pct", "transport_equipment_pct",
                   "supplier_package_contingency_pct"],
    "project_costs": ["engineering_hours", "engineering_rate_chf_per_h", "commissioning_hours",
                      "commissioning_rate_chf_per_h", "hygiene_inspection_chf", "documentation_chf"],
    "commercial": ["overhead_pct", "target_margin_pct", "round_to_chf"],
    "stretch_bid_optimization": ["reference_win_probability", "price_sensitivity_probability_points_per_1pct_price",
                                 "strategic_appetite_adjustment", "competition_adjustment",
                                 "minimum_probability", "maximum_probability", "scenario_margins_pct"],
}


def factor_label(key: str) -> str:
    return FACTOR_LABELS.get(key, key.replace("_", " "))


def _path(kind: str) -> Path:
    return Path(REFERENCE_DIR) / FILES[kind]


def _to_bool(v) -> bool:
    return str(v).strip().lower() in ("true", "1", "yes", "y", "ja")


def _to_float(v, field: str, row_id: str) -> float:
    try:
        return float(str(v).strip())
    except (TypeError, ValueError):
        raise ValueError(f"{row_id}: '{field}' must be a number, got '{v}'") from None


# ---------------------------------------------------------------- parsing

def _parse_catalog(text: str) -> dict[str, dict]:
    reader = csv.DictReader(io.StringIO(text))
    missing = [c for c in CATALOG_REQUIRED if c not in (reader.fieldnames or [])]
    if missing:
        raise ValueError(f"Catalogue is missing columns: {', '.join(missing)}")
    out: dict[str, dict] = {}
    for i, raw in enumerate(reader, start=2):
        pid = (raw.get("product_id") or "").strip()
        if not pid:
            raise ValueError(f"Row {i}: product_id is empty")
        if pid in out:
            raise ValueError(f"Row {i}: product_id {pid} appears twice")
        row = {k: (v.strip() if isinstance(v, str) else v) for k, v in raw.items() if k}
        row["net_cost_chf"] = _to_float(row["net_cost_chf"], "net_cost_chf", pid)
        for f in ("list_price_chf", "discount_pct"):
            if row.get(f) not in (None, ""):
                row[f] = _to_float(row[f], f, pid)
        row["supplier_quote_required"] = _to_bool(row["supplier_quote_required"])
        if row["source_type"] not in ("catalog", "supplier_package"):
            raise ValueError(f"{pid}: source_type must be 'catalog' or 'supplier_package'")
        if row["net_cost_chf"] < 0:
            raise ValueError(f"{pid}: net_cost_chf is negative")
        out[pid] = row
    if not out:
        raise ValueError("Catalogue has no rows")
    return out


def _parse_rules(text: str, factor_keys: set[str] | None = None) -> dict[str, dict]:
    reader = csv.DictReader(io.StringIO(text))
    missing = [c for c in RULES_REQUIRED if c not in (reader.fieldnames or [])]
    if missing:
        raise ValueError(f"Install rules are missing columns: {', '.join(missing)}")
    out: dict[str, dict] = {}
    for i, raw in enumerate(reader, start=2):
        code = (raw.get("install_code") or "").strip()
        if not code:
            raise ValueError(f"Row {i}: install_code is empty")
        if code in out:
            raise ValueError(f"Row {i}: install_code {code} appears twice")
        row = {k: (v.strip() if isinstance(v, str) else v) for k, v in raw.items() if k}
        row["base_hours_per_unit"] = _to_float(row["base_hours_per_unit"], "base_hours_per_unit", code)
        row["default_hourly_rate_chf"] = _to_float(row["default_hourly_rate_chf"], "default_hourly_rate_chf", code)
        row["factor_keys"] = [k.strip() for k in str(row.get("factor_keys") or "").split("|") if k.strip()]
        if factor_keys is not None:
            unknown = [k for k in row["factor_keys"] if k not in factor_keys]
            if unknown:
                raise ValueError(f"{code}: unknown site factor {', '.join(unknown)}")
        out[code] = row
    if not out:
        raise ValueError("Install rules have no rows")
    return out


def _parse_parameters(text: str) -> dict:
    try:
        params = json.loads(text)
    except json.JSONDecodeError as e:
        raise ValueError(f"Parameters are not valid JSON: {e}") from None
    if not isinstance(params, dict):
        raise ValueError("Parameters must be a JSON object")
    for section, keys in PARAMS_REQUIRED.items():
        if not isinstance(params.get(section), dict):
            raise ValueError(f"Parameters are missing the section '{section}'")
        for k in keys:
            if k not in params[section]:
                raise ValueError(f"Parameters: '{section}.{k}' is missing")
    for k, v in params["productivity_factors"].items():
        if not isinstance(v, (int, float)) or v <= 0:
            raise ValueError(f"Parameters: factor '{k}' must be a positive number")
    return params


# ---------------------------------------------------------------- cached loaders

@lru_cache(maxsize=1)
def load_parameters() -> dict:
    return _parse_parameters(_path("parameters").read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def load_catalog() -> dict[str, dict]:
    return _parse_catalog(_path("catalog").read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def load_rules() -> dict[str, dict]:
    return _parse_rules(_path("rules").read_text(encoding="utf-8"))


def clear_cache() -> None:
    load_parameters.cache_clear()
    load_catalog.cache_clear()
    load_rules.cache_clear()


def catalog_row(product_id: str | None) -> dict | None:
    return load_catalog().get(product_id) if product_id else None


def rule_row(install_code: str | None) -> dict | None:
    return load_rules().get(install_code) if install_code else None


def project_cost_amounts(params: dict | None = None) -> dict[str, float]:
    """CHF per project cost item (engineering hours × rate, commissioning hours × rate, fixed items)."""
    pc = (params or load_parameters())["project_costs"]
    return {
        "engineering": float(pc["engineering_hours"]) * float(pc["engineering_rate_chf_per_h"]),
        "commissioning": float(pc["commissioning_hours"]) * float(pc["commissioning_rate_chf_per_h"]),
        "hygiene": float(pc["hygiene_inspection_chf"]),
        "documentation": float(pc["documentation_chf"]),
    }


def project_cost_labels(params: dict | None = None) -> dict[str, str]:
    pc = (params or load_parameters())["project_costs"]

    def n(v):
        return f"{float(v):,.0f}".replace(",", "'")
    return {
        "engineering": f"Engineering {n(pc['engineering_hours'])} h × CHF {n(pc['engineering_rate_chf_per_h'])}",
        "commissioning": f"Commissioning {n(pc['commissioning_hours'])} h × CHF {n(pc['commissioning_rate_chf_per_h'])}",
        "hygiene": "Hygiene inspection",
        "documentation": "Documentation",
    }


def reference_bundle() -> dict:
    """Everything the Reference data screen needs."""
    return {
        "catalog": list(load_catalog().values()),
        "rules": [dict(r, factor_keys="|".join(r["factor_keys"])) for r in load_rules().values()],
        "parameters": load_parameters(),
        "source": {k: str(_path(k).name) for k in FILES},
        "versions": reference_versions(),
    }


# ---------------------------------------------------------------- settings

def default_settings(params: dict | None = None) -> dict:
    """SPEC PricingSettings built from project_parameters.json."""
    p = params or load_parameters()
    b, c, a = p["stretch_bid_optimization"], p["commercial"], p["allowances"]
    std = float(c["target_margin_pct"])
    margins: dict[str, float] = {}
    for name, m in b["scenario_margins_pct"].items():
        if "Standard" not in margins and float(m) > std:
            margins["Standard"] = std
        margins[name] = float(m)
    margins.setdefault("Standard", std)
    return {
        "competition": float(b["competition_adjustment"]),
        "appetite": float(b["strategic_appetite_adjustment"]),
        "sensitivity": float(b["price_sensitivity_probability_points_per_1pct_price"]),
        "ref_win": float(b["reference_win_probability"]),
        "min_win": float(b["minimum_probability"]),
        "max_win": float(b["maximum_probability"]),
        "margins": margins,
        "overhead_pct": float(c["overhead_pct"]),
        "transport_pct": float(a["transport_equipment_pct"]),
        "material_waste_pct": float(a["material_waste_pct"]),
        "small_material_pct": float(a["small_material_pct"]),
        "supplier_contingency_pct": float(a["supplier_package_contingency_pct"]),
        "include_small_material": False,
        "include_supplier_contingency": False,
        "round_to": float(c["round_to_chf"]),
        "factors": {k: float(v) for k, v in p["productivity_factors"].items()},
        "project_costs": {k: False for k in PROJECT_COST_LABELS},
        "chosen": None,
        "notes": {"competition": "", "appetite": "", "sensitivity": ""},
        "changed_by": {},
    }


_SETTING_SOURCES = {
    "competition": "stretch_bid_optimization.competition_adjustment",
    "appetite": "stretch_bid_optimization.strategic_appetite_adjustment",
    "sensitivity": "stretch_bid_optimization.price_sensitivity_probability_points_per_1pct_price",
    "ref_win": "stretch_bid_optimization.reference_win_probability",
    "overhead_pct": "commercial.overhead_pct",
    "transport_pct": "allowances.transport_equipment_pct",
    "material_waste_pct": "allowances.material_waste_pct",
    "small_material_pct": "allowances.small_material_pct",
    "supplier_contingency_pct": "allowances.supplier_package_contingency_pct",
    "round_to": "commercial.round_to_chf",
}
_PROJECT_COST_SOURCES = {
    "engineering": "project_costs.engineering_hours × engineering_rate_chf_per_h",
    "commissioning": "project_costs.commissioning_hours × commissioning_rate_chf_per_h",
    "hygiene": "project_costs.hygiene_inspection_chf",
    "documentation": "project_costs.documentation_chf",
}


def setting_source(key: str) -> str | None:
    """Where the default of a (flattened) setting comes from: the project_parameters.json key."""
    if key in _SETTING_SOURCES:
        return f"project_parameters.json {_SETTING_SOURCES[key]}"
    group, _, sub = key.partition(".")
    if group == "factors":
        return f"project_parameters.json productivity_factors.{sub}"
    if group == "margins":
        if sub == "Standard":
            return "project_parameters.json commercial.target_margin_pct"
        return f"project_parameters.json stretch_bid_optimization.scenario_margins_pct.{sub}"
    if group == "project_costs":
        src = _PROJECT_COST_SOURCES.get(sub)
        return f"project_parameters.json {src} (off by default)" if src else None
    if key in ("include_small_material", "include_supplier_contingency"):
        return "Off by default (Equans' golden examples use none)"
    return None


def merge_settings(settings: dict | None) -> dict:
    """Defaults overlaid with the given (possibly partial) settings; nested dicts merged one level deep."""
    out = default_settings()
    for k, v in (settings or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = {**out[k], **v}
        elif v is not None or k == "chosen":
            out[k] = copy.deepcopy(v)
    return out


# ---------------------------------------------------------------- import

def _versions_file() -> Path:
    return Path(REFERENCE_DIR) / "versions.json"


def reference_versions() -> list[dict]:
    f = _versions_file()
    if not f.exists():
        return []
    try:
        return json.loads(f.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []


def import_reference(kind: str, data: bytes, by: str = "You") -> dict:
    """Validate and save a new version of catalog | rules | parameters.

    The current file is archived to ``REFERENCE_DIR/history/`` and the change is
    appended to ``versions.json``. Raises ``ValueError`` with a plain message when
    the file is not usable (nothing is written in that case).
    """
    k = KIND_ALIASES.get((kind or "").lower())
    if not k:
        raise ValueError(f"Unknown reference kind '{kind}'. Use catalog, rules or parameters.")
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise ValueError("File must be UTF-8 text") from None

    if k == "catalog":
        parsed = _parse_catalog(text)
        rules = load_rules()
        unknown = sorted({r["install_code"] for r in parsed.values() if r["install_code"] and r["install_code"] not in rules})
        if unknown:
            raise ValueError(f"Catalogue uses install rules that do not exist: {', '.join(unknown)}")
        rows = len(parsed)
    elif k == "rules":
        parsed = _parse_rules(text, set(load_parameters()["productivity_factors"]))
        rows = len(parsed)
    else:
        parsed = _parse_parameters(text)
        used = {f for r in load_rules().values() for f in r["factor_keys"]}
        missing = sorted(used - set(parsed["productivity_factors"]))
        if missing:
            raise ValueError(f"Parameters are missing site factors used by install rules: {', '.join(missing)}")
        rows = sum(len(v) for v in parsed.values() if isinstance(v, dict))

    now = datetime.now()
    target = _path(k)
    hist = Path(REFERENCE_DIR) / "history"
    hist.mkdir(parents=True, exist_ok=True)
    archived = None
    if target.exists():
        archived = hist / f"{target.stem}_{now:%Y%m%d-%H%M%S}{target.suffix}"
        shutil.copy2(target, archived)
    target.write_text(text, encoding="utf-8")

    versions = reference_versions()
    entry = {"kind": k, "file": target.name, "rows": rows, "version": sum(1 for v in versions if v["kind"] == k) + 2,
             "saved_at": now.isoformat(timespec="seconds"), "by": by,
             "previous": archived.name if archived else None}
    versions.append(entry)
    _versions_file().write_text(json.dumps(versions, indent=1), encoding="utf-8")
    clear_cache()
    return entry
