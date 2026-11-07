"""Evacuation ranker.

1. Sort by MEDEVAC precedence tier first. This is a fixed rule the model can
   never override: no Priority patient is ever placed above an Urgent one.
2. Inside each tier, order by a transparent weighted score

       EvacScore = w1·DeteriorationRisk + w2·ResourceRelief + w3·DestinationMatch

   with weights set by hand and exposed as sliders on the dashboard.
3. Return the top 5 with the two largest contributing factors as the reason.

Expectant and Dead patients carry no precedence and are never auto-ranked.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .board import Board

WEIGHTED_RTS_MAX = 7.8408
TIER = {"A": 0, "B": 0, "C": 1, "D": 2, "E": 3}
WINDOW = {"A": 120, "B": 120, "C": 240, "D": 1440, "E": 2880}
PRECEDENCE_LABEL = {"A": "Urgent", "B": "Urgent-Surgical", "C": "Priority", "D": "Routine", "E": "Convenience"}
CAPABILITY_LABEL = {
    "trauma_surgery": "trauma surgery",
    "burn": "burn care",
    "neuro": "neurosurgery",
    "general": "general care",
}
# How much freeing one unit of each resource helps, before scarcity scaling.
RELIEF_UNIT = {"vent": 1.0, "blood_unit": 0.25, "o2": 0.3, "or_table": 0.6, "bed": 0.5}
RESOURCE_NAME = {"vent": "ventilator", "blood_unit": "blood", "o2": "oxygen", "or_table": "OR table",
                 "bed": "bed"}
TOP_N = 5


@dataclass
class Factor:
    key: str
    label: str
    value: float  # contribution to the final score


@dataclass
class Ranked:
    patient_id: int
    tag: str
    tier: int
    precedence: str
    score: float
    factors: list[Factor] = field(default_factory=list)

    #: Mean contribution of each factor across this patient's tier, set by the ranker.
    baseline: dict[str, float] = field(default_factory=dict)

    @property
    def reason(self) -> str:
        """The two factors that most set this patient apart from others in the tier."""
        def lift(f: Factor) -> float:
            return f.value - self.baseline.get(f.key, 0.0)
        distinctive = [f for f in sorted(self.factors, key=lift, reverse=True) if lift(f) > 1e-6 and f.value > 0]
        top = distinctive[:2]
        if len(top) < 2:
            rest = [f for f in sorted(self.factors, key=lambda f: f.value, reverse=True) if f not in top and f.value > 0]
            top += rest[: 2 - len(top)]
        return " · ".join(f.label for f in top) or "Lowest overall risk in tier"

    def to_json(self, rank: int) -> dict[str, Any]:
        return {
            "patientId": self.patient_id,
            "rank": rank,
            "score": round(self.score, 4),
            "tier": self.tier,
            "precedence": self.precedence,
            "reason": self.reason,
            "factors": [{"key": f.key, "label": f.label, "value": round(f.value, 4)}
                        for f in sorted(self.factors, key=lambda f: f.value, reverse=True)],
        }


def _clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


def scarcity(board: Board, rtype: str) -> float:
    """0 = plentiful, 1 = about to run out, from the latest burn-down forecast."""
    f = board.forecasts.get(rtype)
    if f is not None:
        ttz = float(f["ttz_median"])
        if ttz >= 0:
            return _clamp(1 - ttz / 180.0)
    r = board.resources.get(rtype)
    if r and float(r["capacity"]) > 0:
        return _clamp(float(r["in_use"]) / float(r["capacity"])) * 0.4
    return 0.0


def destination_match(patient_cap: str, slot_cap: str) -> float:
    if patient_cap == slot_cap:
        return 1.0
    if slot_cap == "trauma_surgery":
        return 0.6  # a Level I centre can take most things
    if patient_cap == "general":
        return 0.7
    if slot_cap == "general":
        return 0.2
    return 0.1


def score_patient(board: Board, p: dict[str, Any], slot: dict[str, Any],
                  weights: tuple[float, float, float]) -> Ranked:
    w_det, w_rel, w_dst = weights
    now = board.minute
    prec = p["evac_precedence"]

    # Deterioration risk: physiologic severity, trend, and window pressure.
    # A weighted RTS 4 points below normal is treated as maximal severity.
    severity = _clamp((WEIGHTED_RTS_MAX - float(p["weighted_rts"])) / 4.0)
    trend = _clamp(-float(p["rts_trend"]) / 0.6)
    deadline = float(p["precedence_deadline"])
    left = deadline - now
    window = _clamp(1 - left / WINDOW[prec]) if deadline >= 0 else 0.0

    factors = [
        Factor("severity", f"Severity: weighted RTS {float(p['weighted_rts']):.1f}/7.84",
               w_det * 0.5 * severity),
        Factor("trend", f"Deteriorating {float(p['rts_trend']):+.1f} RTS/30 min", w_det * 0.25 * trend),
        Factor("window",
               (f"{PRECEDENCE_LABEL[prec]} window: {max(0, round(left))} min left" if left > 0
                else f"{PRECEDENCE_LABEL[prec]} window passed"),
               w_det * 0.25 * window),
    ]

    # Resource relief: what evacuating this patient frees, weighted by scarcity.
    held: dict[str, float] = {}
    pid = int(p["id"])
    for e in board.events:
        if int(e["patient_id"]) != pid or e["status"] == "done":
            continue
        r = e["resource_type"]
        if r == "or_table" and e["status"] == "active":
            continue  # mid-surgery; not moving them off the table
        amount = float(e["amount"]) - float(e.get("consumed", 0.0)) if r in ("blood_unit", "o2") else float(e["amount"])
        held[r] = held.get(r, 0.0) + max(0.0, amount)
    if int(p["bed_id"]) != 0:
        held["bed"] = 1.0
    best_rel, best_label, total_rel = 0.0, "", 0.0
    for r, amt in held.items():
        rel = RELIEF_UNIT.get(r, 0.2) * amt * scarcity(board, r)
        total_rel += rel
        if rel > best_rel:
            best_rel = rel
            unit = "" if r in ("vent", "bed", "or_table") else f" (~{amt:.0f} units pending)"
            best_label = f"Frees {RESOURCE_NAME.get(r, r)}{unit}"
    relief = _clamp(total_rel)
    factors.append(Factor("relief", best_label or "Holds no scarce resources", w_rel * relief))

    # Destination match.
    dm = destination_match(p["capability"], slot["capability"])
    factors.append(Factor(
        "destination",
        f"Destination fit: {CAPABILITY_LABEL.get(slot['capability'], slot['capability'])}"
        + ("" if dm >= 1 else f" (needs {CAPABILITY_LABEL.get(p['capability'], p['capability'])})"),
        w_dst * dm,
    ))

    score = sum(f.value for f in factors)
    return Ranked(pid, p["tag"], TIER[prec], prec, score, factors)


def rank_for_slot(board: Board, slot: dict[str, Any], top_n: int = TOP_N) -> list[Ranked]:
    overridden = {int(d["patient_id"]) for d in board.decisions
                  if int(d["slot_id"]) == int(slot["id"]) and not d["accepted"]}
    candidates = [p for p in board.on_site
                  if p["evac_precedence"] in TIER and int(p["id"]) not in overridden]
    weights = board.weights()
    ranked = [score_patient(board, p, slot, weights) for p in candidates]
    for tier in {r.tier for r in ranked}:
        peers = [r for r in ranked if r.tier == tier]
        keys = {f.key for r in peers for f in r.factors}
        baseline = {k: sum(f.value for r in peers for f in r.factors if f.key == k) / len(peers) for k in keys}
        for r in peers:
            r.baseline = baseline
    # Hard rule: tier first. Score only orders within a tier.
    ranked.sort(key=lambda r: (r.tier, -r.score, r.patient_id))
    return ranked[:top_n]
