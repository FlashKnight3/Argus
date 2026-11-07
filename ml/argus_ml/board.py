"""A read-only snapshot of the live board, built from SpacetimeDB rows.

Column names are SpacetimeDB's canonical snake_case names (the module's
camelCase fields are converted by the default case-conversion policy).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .stdb import SpacetimeClient

TABLES = ("sim_state", "patient", "resource", "consumption_event", "evac_slot", "decision", "forecast")

ON_SITE = ("waiting", "bedded", "ambulatory")


@dataclass
class Board:
    minute: float
    state: dict[str, Any]
    patients: list[dict[str, Any]] = field(default_factory=list)
    resources: dict[str, dict[str, Any]] = field(default_factory=dict)
    events: list[dict[str, Any]] = field(default_factory=list)
    slots: list[dict[str, Any]] = field(default_factory=list)
    decisions: list[dict[str, Any]] = field(default_factory=list)
    forecasts: dict[str, dict[str, Any]] = field(default_factory=dict)

    @property
    def on_site(self) -> list[dict[str, Any]]:
        return [p for p in self.patients if p["status"] in ON_SITE]

    @property
    def open_slots(self) -> list[dict[str, Any]]:
        return [s for s in self.slots if s["status"] == "open"]

    def weights(self) -> tuple[float, float, float]:
        s = self.state
        return (float(s.get("w_deterioration", 0.5)), float(s.get("w_resource_relief", 0.3)),
                float(s.get("w_destination_match", 0.2)))

    @classmethod
    def fetch(cls, client: SpacetimeClient) -> Board | None:
        results = client.sql("; ".join(f"SELECT * FROM {t}" for t in TABLES))
        by = dict(zip(TABLES, results))
        if not by["sim_state"]:
            return None
        state = by["sim_state"][0]
        return cls(
            minute=float(state["minute"]),
            state=state,
            patients=by["patient"],
            resources={r["resource_type"]: r for r in by["resource"]},
            events=by["consumption_event"],
            slots=by["evac_slot"],
            decisions=by["decision"],
            forecasts={f["resource_type"]: f for f in by["forecast"]},
        )
