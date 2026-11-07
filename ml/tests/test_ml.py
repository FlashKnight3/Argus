import json
from pathlib import Path

import numpy as np
import pytest

from argus_ml.board import Board
from argus_ml.burndown import forecast_burndown
from argus_ml.inflow import forecast_inflow
from argus_ml.offline import OfflineBoard
from argus_ml.ranker import TIER, rank_for_slot
from argus_ml.scenario import PRESETS, generate
from argus_ml.simulator import build_events
from argus_ml.stdb import rows_from_result

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module")
def stadium():
    return json.loads((ROOT / "scenarios" / "stadium_collapse.json").read_text())


def test_generator_is_reproducible():
    a = generate(PRESETS["stadium"], 37)
    b = generate(PRESETS["stadium"], 37)
    assert a == b
    assert len(a["casualties"]) == 40
    assert a["illustrative"] is True


def test_committed_scenario_matches_generator(stadium):
    assert stadium == generate(PRESETS["stadium"], 37)


def test_arrivals_come_in_three_waves(stadium):
    times = [c["arrivalMin"] for c in stadium["casualties"]]
    assert sum(t < 20 for t in times) == 10
    assert sum(28 <= t <= 58 for t in times) == 21  # the larger-than-expected second wave
    assert sum(t >= 72 for t in times) == 9


def test_events_are_time_ordered(stadium):
    import heapq
    evs = build_events(stadium)
    ordered = [heapq.heappop(evs).at for _ in range(len(evs))]
    assert ordered == sorted(ordered)


def test_inflow_tracks_rate_and_gives_a_range():
    arrivals = list(np.linspace(0, 30, 31))  # ~1/min
    f = forecast_inflow(arrivals, 30)
    exp, lo, hi = f.horizons[60]
    assert 20 < exp < 70
    assert lo <= exp <= hi
    surged = forecast_inflow(arrivals, 30, surge_extra=10)
    assert surged.horizons[60][0] == pytest.approx(exp + 10, abs=0.2)


def test_inflow_with_no_data_uses_prior():
    f = forecast_inflow([], 0)
    assert 0 < f.rate_per_hour < 20


def test_demo_story_blood_warning_near_t45(stadium):
    ob = OfflineBoard(stadium)
    ob.run_until(45)
    b = ob.board()
    fc = forecast_burndown(b, forecast_inflow([p["arrival_min"] for p in b.patients], 45), seed=45)
    blood = fc["blood_unit"]
    assert 30 <= blood.ttz_median < 90, blood  # amber: "~50 min to zero"
    assert blood.ttz_p10 <= blood.ttz_median
    assert blood.curve[0][0] == 0


def test_burndown_is_quiet_on_an_empty_board(stadium):
    ob = OfflineBoard(stadium)
    b = ob.board()
    fc = forecast_burndown(b, forecast_inflow([], 0), seed=1)
    assert fc["o2"].ttz_median == -1 or fc["o2"].ttz_median > 90


def test_lose_a_vent_moves_the_forecast(stadium):
    ob = OfflineBoard(stadium)
    ob.run_until(70)
    b = ob.board()
    inflow = forecast_inflow([p["arrival_min"] for p in b.patients], 70)
    before = forecast_burndown(b, inflow, seed=70)["vent"]
    b.resources["vent"]["capacity"] -= 1
    after = forecast_burndown(b, inflow, seed=70)["vent"]
    as_num = lambda t: 1e9 if t < 0 else t
    assert as_num(after.ttz_median) <= as_num(before.ttz_median)


def _ranked_board(stadium):
    ob = OfflineBoard(stadium)
    ob.run_until(70)
    b = ob.board()
    slot = {"id": 1, "status": "open", "capability": "trauma_surgery", "seats": 2, "seats_filled": 0}
    b.slots = [slot]
    return b, slot


def test_ranker_never_breaks_precedence_tiers(stadium):
    b, slot = _ranked_board(stadium)
    for w in [(1, 0, 0), (0, 1, 0), (0, 0, 1), (0.5, 0.3, 0.2)]:
        b.state.update(w_deterioration=w[0], w_resource_relief=w[1], w_destination_match=w[2])
        ranked = rank_for_slot(b, slot)
        tiers = [r.tier for r in ranked]
        assert tiers == sorted(tiers)
        assert all(r.precedence in TIER for r in ranked)
        assert len(ranked) <= 5


def test_ranker_explains_with_two_factors(stadium):
    b, slot = _ranked_board(stadium)
    top = rank_for_slot(b, slot)[0]
    j = top.to_json(1)
    assert j["reason"].count("·") == 1
    assert j["factors"][0]["value"] >= j["factors"][-1]["value"]


def test_ranker_skips_overridden_patients(stadium):
    b, slot = _ranked_board(stadium)
    first = rank_for_slot(b, slot)[0]
    b.decisions = [{"slot_id": 1, "patient_id": first.patient_id, "accepted": False}]
    assert first.patient_id not in [r.patient_id for r in rank_for_slot(b, slot)]


def test_ranker_never_ranks_expectant_or_dead(stadium):
    b, slot = _ranked_board(stadium)
    for p in b.patients[:5]:
        p["category"], p["evac_precedence"] = "expectant", ""
    ids = {p["id"] for p in b.patients[:5]}
    assert not ids & {r.patient_id for r in rank_for_slot(b, slot)}


def test_sql_rows_are_decoded():
    result = {
        "schema": {"elements": [{"name": {"some": "id"}}, {"name": {"some": "at"}}]},
        "rows": [[1, {"__timestamp_micros_since_unix_epoch__": 5}]],
    }
    assert rows_from_result(result) == [{"id": 1, "at": 5}]


def test_board_weights_default():
    b = Board(minute=0, state={})
    assert b.weights() == (0.5, 0.3, 0.2)
