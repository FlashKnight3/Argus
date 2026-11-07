"""Scenario simulator: replays a scenario JSON into SpacetimeDB on a clock.

    python -m argus_ml.simulator ../scenarios/stadium_collapse.json

It owns the scenario clock. Each tick it reads play/pause and speed from
``sim_state`` (set from the dashboard's top bar), advances the minute, and
fires due events through reducers: admit_patient, consume_resource,
update_vitals, open_evac_slot and schedule_resupply.
"""

from __future__ import annotations

import argparse
import heapq
import json
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .stdb import DEFAULT_DB, DEFAULT_HOST, ReducerError, SpacetimeClient

log = logging.getLogger("argus.sim")


@dataclass(order=True)
class Event:
    at: float
    seq: int
    kind: str = field(compare=False)
    data: dict[str, Any] = field(compare=False)


def build_events(scenario: dict[str, Any]) -> list[Event]:
    events: list[Event] = []
    seq = 0

    def push(at: float, kind: str, data: dict[str, Any]) -> None:
        nonlocal seq
        seq += 1
        events.append(Event(round(at, 2), seq, kind, data))

    for c in scenario["casualties"]:
        t0 = float(c["arrivalMin"])
        push(t0, "admit", c)
        for n in c.get("needs", []):
            push(t0 + float(n["offsetMin"]), "need", {"tag": c["tag"], **n})
        for v in c.get("trajectory", []):
            push(t0 + float(v["offsetMin"]), "vitals", {"tag": c["tag"], **v["vitals"]})
    for s in scenario.get("evacSlots", []):
        push(float(s["atMin"]), "slot", s)
    for r in scenario.get("resupply", []):
        push(float(r["atMin"]), "resupply", r)
    heapq.heapify(events)
    return events


def mist_from_casualty(c: dict[str, Any]) -> str:
    v = c["vitals"]
    return json.dumps({
        "mechanism": c["mechanism"],
        "injuries": c.get("narrative", ""),
        "signs": f"HR {v['hr']}, BP {v['sbp']} sys, RR {v['rr']}, SpO2 {v['spo2']}%, GCS {v['gcs']}",
        "treatment": "Tourniquet applied" if not c["assessment"].get("hemorrhageControlled", True) else "",
        "source": "simulator",
    })


class Simulator:
    def __init__(self, client: SpacetimeClient, scenario: dict[str, Any]) -> None:
        self.client = client
        self.scenario = scenario
        self.events = build_events(scenario)
        self.ids: dict[str, int] = {}

    def load(self) -> None:
        r = self.scenario["resources"]
        self.client.call(
            "load_scenario", self.scenario["name"], self.scenario["title"], float(self.scenario["lengthMin"]),
            int(r["beds"]), float(r["bloodUnits"]), float(r["o2Cylinders"]), int(r["vents"]), int(r["orTables"]),
            self.scenario.get("protocol", "SALT"),
        )
        log.info("loaded %s — %d casualties", self.scenario["title"], len(self.scenario["casualties"]))

    def skip_to(self, minute: float) -> None:
        """Resume mid-scenario: drop events already in the past and learn patient ids."""
        for p in self.client.table("patient"):
            self.ids[p["tag"]] = int(p["id"])
        while self.events and self.events[0].at <= minute:
            heapq.heappop(self.events)

    def _patient_id(self, tag: str) -> int | None:
        if tag not in self.ids:
            rows = self.client.sql(f"SELECT id FROM patient WHERE tag = '{tag}'")[0]
            if rows:
                self.ids[tag] = int(rows[0]["id"])
        return self.ids.get(tag)

    def fire(self, ev: Event) -> None:
        d = ev.data
        if ev.kind == "admit":
            v = d["vitals"]
            self.client.call(
                "admit_patient", d["tag"], "simulator", int(d["age"]), d["injuryType"], d["mechanism"],
                float(v["hr"]), float(v["sbp"]), float(v["rr"]), float(v["spo2"]), float(v["gcs"]),
                json.dumps(d.get("assessment", {})), "", mist_from_casualty(d),
            )
        elif ev.kind == "need":
            pid = self._patient_id(d["tag"])
            if pid is not None:
                self.client.call("consume_resource", pid, d["resource"], float(d["amount"]),
                                 float(d["durationMin"]))
        elif ev.kind == "vitals":
            pid = self._patient_id(d["tag"])
            if pid is not None:
                self.client.call("update_vitals", pid, float(d["hr"]), float(d["sbp"]), float(d["rr"]),
                                 float(d["spo2"]), float(d["gcs"]))
        elif ev.kind == "slot":
            self.client.call("open_evac_slot", d["mode"], d["callsign"], int(d["seats"]),
                             float(d["departInMin"]), d["destination"], d["capability"])
        elif ev.kind == "resupply":
            self.client.call("schedule_resupply", d["resourceType"], float(d["amount"]), float(d["etaMin"]))

    def run(self, tick_s: float = 0.25) -> None:
        last = time.monotonic()
        scenario_name = self.scenario["name"]
        while True:
            time.sleep(tick_s)
            now = time.monotonic()
            dt, last = now - last, now
            rows = self.client.table("sim_state")
            if not rows:
                log.warning("sim_state is empty — reloading scenario")
                self.events = build_events(self.scenario)
                self.ids.clear()
                self.load()
                continue
            s = rows[0]
            if s["scenario_name"] != scenario_name:
                log.info("another scenario was loaded (%s); exiting", s["scenario_name"])
                return
            if s["paused"]:
                continue
            minute = float(s["minute"]) + float(s["speed"]) * dt / 60.0
            minute = min(minute, float(self.scenario["lengthMin"]) + 60)
            self.client.call("advance_clock", round(minute, 3))
            while self.events and self.events[0].at <= minute:
                ev = heapq.heappop(self.events)
                try:
                    self.fire(ev)
                except ReducerError as e:
                    log.warning("%s at T+%.1f: %s", ev.kind, ev.at, e)


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("scenario", type=Path)
    ap.add_argument("--host", default=DEFAULT_HOST)
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--resume", action="store_true", help="continue the loaded scenario instead of resetting")
    ap.add_argument("--play", action="store_true", help="start playing immediately (default: paused)")
    ap.add_argument("--speed", type=float, default=30.0)
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s sim      %(message)s", datefmt="%H:%M:%S")

    scenario = json.loads(args.scenario.read_text())
    client = SpacetimeClient(args.host, args.db)
    while not client.ping():
        log.info("waiting for SpacetimeDB at %s (db %s)…", args.host, args.db)
        time.sleep(2)
    try:
        client.login()
    except ReducerError:
        log.warning("could not obtain an identity token; continuing anonymously")

    sim = Simulator(client, scenario)
    state = client.table("sim_state")
    if args.resume and state and state[0]["scenario_name"] == scenario["name"]:
        sim.skip_to(float(state[0]["minute"]))
        log.info("resuming at T+%.1f", float(state[0]["minute"]))
    else:
        sim.load()
    client.call("set_playback", not args.play, args.speed)
    log.info("ready — press play on the dashboard" if not args.play else "playing")
    sim.run()


if __name__ == "__main__":
    main()
