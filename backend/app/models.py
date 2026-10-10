"""Pydantic request bodies for the API. Responses are plain dicts (see docs/SPEC.md).

PATCH-style bodies distinguish "not sent" from "sent as null": use
`body.model_dump(exclude_unset=True)` so that `{"quantity": null}` clears an override
while an omitted field is left alone.
"""
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

Status = Literal[
    "calculated",
    "supplier_quote_required",
    "assumption_applied",
    "review_required",
    "insufficient_information",
    "out_of_scope",
    "non_priceable",
]


class PositionPatch(BaseModel):
    # NaN/Infinity would be stored and then break every JSON response for the tender
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    quantity: float | None = None
    product_id: str | None = None
    unit_price: float | None = None
    hours: float | None = None
    install_code: str | None = None
    variant_reason: str | None = None
    status: Status | None = None
    # Supplier quote typed on the line (N04b "enter quote"); null clears it.
    quote_unit_price: float | None = None
    quote_source: str | None = None
    reset: bool | None = None
    confirm: bool | None = None
    unconfirm: bool | None = None
    flag: bool | None = None


class InstructionPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    state: Literal["open", "confirmed", "not_relevant"] | None = None
    kind: Literal["cost", "risk", "scope", "covered"] | None = None
    applies_to: list[str] | None = None


class PricingUpdate(BaseModel):
    """Partial PricingSettings. Nested dicts are merged key by key. Unknown keys are kept
    (pricing.py may define more settings than listed here)."""

    model_config = ConfigDict(extra="allow", allow_inf_nan=False)

    competition: float | None = None
    appetite: float | None = None
    sensitivity: float | None = None
    ref_win: float | None = None
    margins: dict[str, float] | None = None
    overhead_pct: float | None = None
    transport_pct: float | None = None
    material_waste_pct: float | None = None
    small_material_pct: float | None = None
    supplier_contingency_pct: float | None = None
    include_small_material: bool | None = None
    include_supplier_contingency: bool | None = None
    factors: dict[str, float] | None = None
    project_costs: dict[str, bool] | None = None
    chosen: str | None = None
    notes: dict[str, str] | None = None


class Outcome(BaseModel):
    model_config = ConfigDict(extra="allow", allow_inf_nan=False)

    simap_no: str | None = None
    award_date: str | None = None
    result: Literal["won", "lost", "open", "cancelled"] | None = None
    winner: str | None = None
    winning_price: float | None = None
    bidders: int | None = None
    rank: int | None = None
    reason: str | None = None


class AssistCommand(BaseModel):
    text: str = Field(min_length=1)
    scope: Literal["line", "tender"] = "tender"
    lv_id: str | None = None


class QuoteProposal(BaseModel):
    model_config = ConfigDict(extra="allow", allow_inf_nan=False)

    lv_id: str
    unit_price: float
    source: str | None = None


class QuoteApply(BaseModel):
    proposals: list[QuoteProposal]
    proposal_id: str | None = None  # the tray proposal these came from, closed when applied


class QuoteChoose(BaseModel):
    """Pick among competing supplier offers: one line (lv_id + proposal_id), or a request (group) with
    one supplier for all its lines, or the cheapest offer for each line."""
    lv_id: str | None = None
    proposal_id: str | None = None
    group: str | None = None
    supplier: str | None = None
    cheapest: bool = False


class TenderPatch(BaseModel):
    """Edit tender meta (N02 fields). Fields set here are never overwritten by the pipeline."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    client: str | None = None
    trade: str | None = None
    due_at: str | None = None
    profile: Literal["school", "sports_hall"] | None = None


class ReviewBody(BaseModel):
    """Senior review of a logged change (Changes screen); "reopened" takes an approval back."""

    verdict: Literal["approved", "reverted", "comment", "reopened"]
    note: str | None = Field(None, max_length=500)


class ReviewMany(ReviewBody):
    log_ids: list[str] = Field(..., max_length=1000)


def unset_dump(model: BaseModel) -> dict[str, Any]:
    return model.model_dump(exclude_unset=True)
