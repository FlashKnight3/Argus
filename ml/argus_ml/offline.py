"""In-memory stand-in for the SpacetimeDB module, for tests and scenario tuning.

It mirrors the module's resource accounting closely enough to replay a
scenario at full speed with no server, then hands the ML engines the same
``Board`` they would read live. The authoritative logic lives in
``server/src``; this is a test harness, not a second source of truth.

    python -m argus_ml.offline ../scenarios/stadium_collapse.json
"""

from __future__ import annotations

import argparse
import heapq
import json
from pathlib import Path
from typing import Any

from .board import Board
from .burndown import forecast_burndown
from .inflow import forecast_inflow
from .simulator import build_events

SURGICAL = {"penetrating_torso", "blast_extremity"}
CAPABILITY = {"penetrating_torso": "trauma_surgery", "blast_extremity": "trauma_surgery",
              "crush": "trauma_surgery", "burns": "burn", "head_injury": "neuro"}


def salt_lite(v: dict[str, float], a: dict[str, Any]) -> str:
    """Python mirror of server/src/protocols/triage.ts `salt` for offline use."""
    if v["rr"] <= 0:
        return "dead"
    ok = [
        a.get("obeysCommands", v["gcs"] >= 13),
        a.get("peripheralPulse", v["sbp"] >= 80 and v["hr"] > 0),
        not a.get("respiratoryDistress", v["rr"] > 30 or 0 < v["rr"] < 10 or v["spo2"] < 90),
        a.get("hemorrhageControlled", True),
    ]
    if all(ok):
        return "minimal" if a.get("minorInjuriesOnly") else "delayed"
    return "immediate"


def rts(v: dict[str, float]) -> float:
    g = 4 if v["gcs"] >= 13 else 3 if v["gcs"] >= 9 else 2 if v["gcs"] >= 6 else 1 if v["gcs"] >= 4 else 0
    s = 4 if v["sbp"] > 89 else 3 if v["sbp"] >= 76 else 2 if v["sbp"] >= 50 else 1 if v["sbp"] >= 1 else 0
    r = 3 if v["rr"] > 29 else 4 if v["rr"] >= 10 else 2 if v["rr"] >= 6 else 1 if v["rr"] >= 1 else 0
    return 0.9368 * g + 0.7326 * s + 0.2908 * r


class OfflineBoard:
    def __init__(self, scenario: dict[str, Any]) -> None:
        r = scenario["resources"]
        self.minute = 0.0
        self.state: dict[str, Any] = {
            "scenario_name": scenario["name"], "minute": 0.0, "what_if_surge": 0,
            "w_deterioration": 0.5, "w_resource_relief": 0.3, "w_destination_match": 0.2,
        }
        self.resources = {
            "bed": {"resource_type": "bed", "kind": "reusable", "capacity": float(r["beds"]), "in_use": 0.0},
            "blood_unit": {"resource_type": "blood_unit", "kind": "consumable",
                           "capacity": float(r["bloodUnits"]), "in_use": 0.0},
            "o2": {"resource_type": "o2", "kind": "consumable", "capacity": float(r["o2Cylinders"]), "in_use": 0.0},
            "vent": {"resource_type": "vent", "kind": "reusable", "capacity": float(r["vents"]), "in_use": 0.0},
            "or_table": {"resource_type": "or_table", "kind": "reusable", "capacity": float(r["orTables"]),
                         "in_use": 0.0},
        }
        for res in self.resources.values():
            res.update(resupply_eta_min=-1.0, resupply_amount=0.0)
        self.patients: list[dict[str, Any]] = []
        self.events: list[dict[str, Any]] = []
        self.slots: list[dict[str, Any]] = []
        self.queue = build_events(scenario)
        self.by_tag: dict[str, dict[str, Any]] = {}

    # ── module mirror ───────────────────────────────────────────────────────
    def _avail(self, r: str) -> float:
        return self.resources[r]["capacity"] - self.resources[r]["in_use"]

    def admit(self, c: dict[str, Any]) -> None:
        v = c["vitals"]
        cat = salt_lite(v, c.get("assessment", {}))
        prec = {"immediate": "B" if c["injuryType"] in SURGICAL else "A", "delayed": "C", "minimal": "D"}.get(cat, "")
        window = {"A": 120, "B": 120, "C": 240, "D": 1440}.get(prec)
        beds = self.resources["bed"]
        needs_bed = cat in ("immediate", "delayed", "expectant")
        bed_id = 0
        status = "ambulatory" if not needs_bed else "waiting"
        if cat == "dead":
            status = "deceased"
        elif needs_bed and beds["in_use"] < beds["capacity"]:
            beds["in_use"] += 1
            bed_id = int(beds["in_use"])
            status = "bedded"
        p = {
            "id": len(self.patients) + 1, "tag": c["tag"], "arrival_min": self.minute, "category": cat,
            "status": status, "bed_id": bed_id, "evac_precedence": prec,
            "precedence_deadline": self.minute + window if window else -1.0,
            "weighted_rts": rts(v), "rts_trend": 0.0, "vitals_min": self.minute,
            "capability": CAPABILITY.get(c["injuryType"], "general"),
        }
        self.patients.append(p)
        self.by_tag[c["tag"]] = p

    def consume(self, tag: str, rtype: str, amount: float, duration: float) -> None:
        p = self.by_tag.get(tag)
        if not p or p["status"] in ("evacuated", "deceased"):
            return
        res = self.resources[rtype]
        status = "active"
        if res["kind"] == "reusable":
            if self._avail(rtype) >= amount:
                res["in_use"] += amount
            else:
                status = "queued"
        self.events.append({"id": len(self.events) + 1, "patient_id": p["id"], "resource_type": rtype,
                            "amount": amount, "consumed": 0.0, "start_min": self.minute,
                            "duration_min": duration, "status": status})

    def vitals(self, tag: str, v: dict[str, float]) -> None:
        p = self.by_tag.get(tag)
        if not p:
            return
        w = rts(v)
        dt = max(1.0, self.minute - p["vitals_min"])
        p["rts_trend"] = (w - p["weighted_rts"]) / dt * 30
        p["weighted_rts"], p["vitals_min"] = w, self.minute

    def advance(self, minute: float) -> None:
        self.minute = self.state["minute"] = minute
        for e in self.events:
            if e["status"] != "active":
                continue
            res = self.resources[e["resource_type"]]
            if res["kind"] == "consumable":
                frac = 1.0 if e["duration_min"] <= 0 else min(1.0, (minute - e["start_min"]) / e["duration_min"])
                give = max(0.0, min(e["amount"] * frac - e["consumed"], self._avail(e["resource_type"])))
                res["in_use"] += give
                e["consumed"] += give
                if frac >= 1:
                    e["status"] = "done"
            elif e["duration_min"] > 0 and minute - e["start_min"] >= e["duration_min"]:
                res["in_use"] -= e["amount"]
                e["status"] = "done"
        for e in self.events:
            if e["status"] == "queued" and self._avail(e["resource_type"]) >= e["amount"]:
                e["status"], e["start_min"] = "active", minute
                self.resources[e["resource_type"]]["in_use"] += e["amount"]

    def run_until(self, minute: float, step: float = 1.0) -> None:
        t = self.minute
        while t < minute:
            t = min(minute, t + step)
            self.advance(t)
            while self.queue and self.queue[0].at <= t:
                ev = heapq.heappop(self.queue)
                d = ev.data
                if ev.kind == "admit":
                    self.admit(d)
                elif ev.kind == "need":
                    self.consume(d["tag"], d["resource"], float(d["amount"]), float(d["durationMin"]))
                elif ev.kind == "vitals":
                    self.vitals(d["tag"], d)
                elif ev.kind == "slot":
                    self.slots.append({"id": len(self.slots) + 1, "status": "open", "seats_filled": 0, 
                        "capability": d["capability"], "seats": d["seats"]})

    def board(self) -> Board:
        return Board(minute=self.minute, state=dict(self.state), patients=self.patients,
                     resources=self.resources, events=self.events, slots=self.slots, decisions=[])


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("scenario", type=Path)
    ap.add_argument("--every", type=float, default=15)
    args = ap.parse_args(argv)
    scenario = json.loads(args.scenario.read_text())
    ob = OfflineBoard(scenario)
    print(f"{scenario['title']} — offline replay (synthetic)")
    print(f"{'T+':>5} {'pts':>4} " + " ".join(f"{r:>18}" for r in ob.resources))
    t = 0.0
    while t < scenario["lengthMin"]:
        t += args.every
        ob.run_until(t)
        b = ob.board()
        inflow = forecast_inflow([p["arrival_min"] for p in b.patients], t)
        fc = forecast_burndown(b, inflow, seed=int(t))
        cells = []
        for f in fc.values():
            ttz = "  —" if f.ttz_median < 0 else f"{f.ttz_median:>3.0f}"
            cells.append(f"{f.available:>6.1f} ttz {ttz:>4}m".rjust(18))
        print(f"{t:>5.0f} {len(b.patients):>4} " + " ".join(cells))


if __name__ == "__main__":
    main()
