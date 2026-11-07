"""ML sidecar: subscribe → compute → write back, once per simulated minute.

    python -m argus_ml.sidecar            # against ws://127.0.0.1:3000, db "argus"

Every tick it reads the live board from SpacetimeDB, then writes
  * the inflow forecast            → write_inflow
  * burn-down per resource         → write_forecast   (the module raises amber/red alerts)
  * top-5 ranking per open slot    → write_ranking    (the module re-checks the tier rule)
  * precedence-window breaches     → flag_precedence_breach
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import time

from .board import Board
from .burndown import forecast_burndown
from .inflow import forecast_inflow
from .ranker import rank_for_slot
from .stdb import DEFAULT_DB, DEFAULT_HOST, ReducerError, SpacetimeClient

log = logging.getLogger("argus.sidecar")


def _signature(board: Board) -> str:
    """Recompute when the minute or any input that affects the output changes."""
    s = board.state
    key = json.dumps([
        round(board.minute, 1), s.get("w_deterioration"), s.get("w_resource_relief"),
        s.get("w_destination_match"), s.get("what_if_surge"),
        sorted((r["resource_type"], r["capacity"], r["in_use"]) for r in board.resources.values()),
        sorted((p["id"], p["status"], p["category"]) for p in board.patients),
        sorted((sl["id"], sl["status"], sl["seats_filled"]) for sl in board.slots),
        len(board.decisions),
    ], default=str)
    return hashlib.sha1(key.encode()).hexdigest()


class Sidecar:
    def __init__(self, client: SpacetimeClient) -> None:
        self.client = client
        self.breached: set[int] = set()
        self.last_sig = ""
        self.scenario = ""

    def tick(self) -> bool:
        board = Board.fetch(self.client)
        if board is None:
            return False
        if board.state.get("scenario_name") != self.scenario:
            self.scenario = board.state.get("scenario_name", "")
            self.breached.clear()
        sig = _signature(board)
        if sig == self.last_sig:
            return False
        self.last_sig = sig
        seed = int(board.minute * 10)

        inflow = forecast_inflow([float(p["arrival_min"]) for p in board.patients], board.minute,
                                 int(board.state.get("what_if_surge", 0) or 0))
        h = inflow.horizons
        self.client.call("write_inflow", inflow.rate_per_hour, *h[30], *h[60], *h[90])

        for f in forecast_burndown(board, inflow, seed=seed).values():
            self.client.call("write_forecast", f.resource_type, f.available, f.capacity, f.ttz_median,
                             f.ttz_p10, f.ttz_p90, f.burn_per_hour, json.dumps(f.curve))

        # Re-read forecasts so ranking uses the scarcity we just wrote.
        board = Board.fetch(self.client) or board
        for slot in board.open_slots:
            ranked = rank_for_slot(board, slot)
            payload = [r.to_json(i + 1) for i, r in enumerate(ranked)]
            self.client.call("write_ranking", int(slot["id"]), json.dumps(payload))

        for p in board.on_site:
            pid = int(p["id"])
            deadline = float(p["precedence_deadline"])
            if deadline >= 0 and board.minute > deadline and pid not in self.breached:
                self.breached.add(pid)
                self.client.call("flag_precedence_breach", pid)
        return True


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default=DEFAULT_HOST)
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--interval", type=float, default=0.75, help="seconds between polls")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s sidecar  %(message)s", datefmt="%H:%M:%S")

    client = SpacetimeClient(args.host, args.db)
    while not client.ping():
        log.info("waiting for SpacetimeDB at %s (db %s)…", args.host, args.db)
        time.sleep(2)
    try:
        client.login()
    except ReducerError:
        log.warning("could not obtain an identity token; continuing anonymously")
    log.info("connected — forecasting every %.2fs", args.interval)

    sidecar = Sidecar(client)
    while True:
        t0 = time.monotonic()
        try:
            if sidecar.tick():
                log.debug("updated")
        except ReducerError as e:
            log.warning("%s", e)
        except OSError as e:
            log.warning("connection problem: %s", e)
            time.sleep(1)
        time.sleep(max(0.05, args.interval - (time.monotonic() - t0)))


if __name__ == "__main__":
    main()
