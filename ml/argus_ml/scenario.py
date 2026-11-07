"""Generate reproducible synthetic mass-casualty scenarios as JSON scripts.

    python -m argus_ml.scenario --preset stadium --out ../scenarios/stadium_collapse.json

1. Injury archetypes give ranges for vitals, deterioration and resource use.
2. Arrivals are sampled in waves with a Poisson process whose rate spikes per wave.
3. Noise and a few "surprise" patients (sudden deterioration) give the forecast
   something to catch.
4. Each scenario is saved as JSON so the demo is replayable.

All ranges are illustrative placeholders.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from .archetypes import ARCHETYPES, Archetype


@dataclass(frozen=True)
class Wave:
    start: float
    end: float
    count: int
    mix: dict[str, float]  # archetype -> weight


@dataclass(frozen=True)
class Preset:
    name: str
    title: str
    length_min: float
    protocol: str
    resources: dict[str, float]
    waves: tuple[Wave, ...]
    surprises: int
    evac_slots: tuple[dict[str, Any], ...]
    resupply: tuple[dict[str, Any], ...] = ()
    pediatric_share: float = 0.08


PRESETS: dict[str, Preset] = {
    "stadium": Preset(
        name="stadium_collapse",
        title="Stadium collapse, Houston",
        length_min=120,
        protocol="SALT",
        resources={"beds": 20, "bloodUnits": 24, "o2Cylinders": 30, "vents": 3, "orTables": 2},
        waves=(
            Wave(0, 18, 10, {"blast_extremity": 1, "crush": 1.5, "fracture": 2.5, "minor_laceration": 4,
                             "inhalation": 1.5, "head_injury": 0.6}),
            # The second wave is larger than expected.
            Wave(28, 58, 21, {"penetrating_torso": 1.3, "blast_extremity": 1.6, "head_injury": 1.8,
                              "burns": 1.2, "crush": 1.3, "inhalation": 2, "minor_laceration": 3,
                              "fracture": 2}),
            Wave(72, 100, 9, {"minor_laceration": 3, "fracture": 2, "inhalation": 2, "crush": 1,
                              "head_injury": 1}),
        ),
        surprises=3,
        evac_slots=(
            {"atMin": 36, "mode": "ground", "callsign": "MEDIC 12", "seats": 2, "departInMin": 12,
             "destination": "Memorial Hermann–TMC", "capability": "trauma_surgery"},
            {"atMin": 70, "mode": "air", "callsign": "LIFE FLIGHT 2", "seats": 2, "departInMin": 15,
             "destination": "Ben Taub (Level I)", "capability": "trauma_surgery"},
            {"atMin": 96, "mode": "ground", "callsign": "MEDIC 31", "seats": 4, "departInMin": 14,
             "destination": "Houston Methodist", "capability": "general"},
        ),
    ),
    "forward": Preset(
        name="forward_station",
        title="Forward field station — evacuation delayed by weather",
        length_min=240,
        protocol="SALT",
        resources={"beds": 12, "bloodUnits": 14, "o2Cylinders": 14, "vents": 2, "orTables": 1},
        waves=(
            Wave(0, 30, 8, {"blast_extremity": 3, "penetrating_torso": 1.5, "head_injury": 1.5,
                            "burns": 1, "fracture": 1}),
            Wave(90, 130, 8, {"blast_extremity": 2, "head_injury": 2, "burns": 2, "inhalation": 2,
                              "penetrating_torso": 1}),
        ),
        surprises=2,
        evac_slots=(
            {"atMin": 165, "mode": "air", "callsign": "DUSTOFF 7", "seats": 3, "departInMin": 20,
             "destination": "Role 3 hospital", "capability": "trauma_surgery"},
        ),
        resupply=({"atMin": 60, "resourceType": "o2", "amount": 6, "etaMin": 200},),
        pediatric_share=0.0,
    ),
}


# Seeds tuned so the demo script lands (see README: blood amber near T+45, real
# exhaustion near T+100 without evacuation). Any seed produces a valid scenario.
DEMO_SEEDS = {"stadium": 37, "forward": 5}


def _u(rng: np.random.Generator, lo_hi: tuple[float, float]) -> float:
    lo, hi = lo_hi
    return float(lo if lo == hi else rng.uniform(lo, hi))


def _arrivals(rng: np.random.Generator, wave: Wave) -> np.ndarray:
    """Inhomogeneous Poisson arrivals: rate rises then falls inside the wave."""
    times: list[float] = []
    span = wave.end - wave.start
    while len(times) < wave.count:
        # Thinning with a triangular-ish intensity peaking early in the wave.
        t = rng.uniform(0, span)
        peak = 0.35 * span
        intensity = t / peak if t < peak else max(0.15, 1 - (t - peak) / (span - peak))
        if rng.uniform() < intensity:
            times.append(wave.start + t)
    return np.sort(np.array(times))


def _clamp_vitals(v: dict[str, float]) -> dict[str, float]:
    return {
        "hr": round(float(np.clip(v["hr"], 30, 190))),
        "sbp": round(float(np.clip(v["sbp"], 40, 200))),
        "rr": round(float(np.clip(v["rr"], 4, 50))),
        "spo2": round(float(np.clip(v["spo2"], 60, 100))),
        "gcs": int(np.clip(round(v["gcs"]), 3, 15)),
    }


def _casualty(rng: np.random.Generator, tag: str, arrival: float, arch: Archetype,
              pediatric: bool, surprise: bool, horizon: float) -> dict[str, Any]:
    vitals = {
        "hr": _u(rng, arch.hr) + rng.normal(0, 3),
        "sbp": _u(rng, arch.sbp) + rng.normal(0, 3),
        "rr": _u(rng, arch.rr) + rng.normal(0, 1),
        "spo2": _u(rng, arch.spo2) + rng.normal(0, 0.7),
        "gcs": rng.integers(arch.gcs[0], arch.gcs[1] + 1),
    }
    age = int(rng.integers(4, 8)) if pediatric else int(rng.integers(16, 78))
    if pediatric:
        vitals["hr"] += 20
        vitals["rr"] += 6
        vitals["sbp"] -= 12
    walks = bool(rng.uniform() < arch.walks_probability)
    hemorrhage_uncontrolled = bool(rng.uniform() < arch.hemorrhage_uncontrolled_probability)
    v0 = _clamp_vitals(vitals)

    # Vitals trajectory every ~15 min while on site; surprises crash suddenly.
    trajectory: list[dict[str, Any]] = []
    drift = dict(arch.drift_per_30)
    crash_at = float(rng.uniform(15, 35)) if surprise else None
    cur = dict(vitals)
    t = 0.0
    while arrival + t < horizon:
        t += 15 + rng.uniform(-3, 3)
        scale = 0.5 * rng.uniform(0.6, 1.4)
        for k, d in drift.items():
            cur[k] += d * scale + rng.normal(0, 1.0 if k != "gcs" else 0.2)
        if crash_at is not None and t >= crash_at:
            cur.update(hr=cur["hr"] + 30, sbp=cur["sbp"] - 32, rr=cur["rr"] + 9,
                       spo2=cur["spo2"] - 7, gcs=cur["gcs"] - 3)
            crash_at = None
        trajectory.append({"offsetMin": round(t, 1), "vitals": _clamp_vitals(cur)})

    needs = []
    for n in arch.needs:
        if rng.uniform() < n.probability:
            needs.append({
                "resource": n.resource,
                "amount": round(_u(rng, n.amount) * 2) / 2 if n.resource != "vent" and n.resource != "or_table" else 1,
                "offsetMin": round(_u(rng, n.offset_min), 1),
                "durationMin": round(_u(rng, n.duration_min), 0),
            })
    if surprise and not any(n["resource"] == "blood_unit" for n in needs):
        needs.append({"resource": "blood_unit", "amount": 3, "offsetMin": round(crash_at or 25, 1), "durationMin": 45})

    assessment: dict[str, Any] = {"walks": walks, "minorInjuriesOnly": arch.minor_only}
    if hemorrhage_uncontrolled:
        assessment["hemorrhageControlled"] = False

    return {
        "tag": tag,
        "arrivalMin": round(float(arrival), 1),
        "age": age,
        "injuryType": arch.key,
        "mechanism": arch.mechanism,
        "narrative": str(rng.choice(arch.narrative)) if arch.narrative else "",
        "vitals": v0,
        "assessment": assessment,
        "needs": needs,
        "trajectory": trajectory,
        "surprise": surprise,
    }


def generate(preset: Preset, seed: int = 7) -> dict[str, Any]:
    rng = np.random.default_rng(seed)
    casualties: list[dict[str, Any]] = []
    for wave in preset.waves:
        keys = list(wave.mix)
        p = np.array([wave.mix[k] for k in keys], dtype=float)
        p /= p.sum()
        for t in _arrivals(rng, wave):
            casualties.append({"t": float(t), "arch": ARCHETYPES[str(rng.choice(keys, p=p))]})
    casualties.sort(key=lambda c: c["t"])

    eligible = [i for i, c in enumerate(casualties)
                if c["arch"].key not in ("minor_laceration", "fracture", "inhalation")]
    surprise_idx = set(rng.choice(eligible, size=min(preset.surprises, len(eligible)), replace=False).tolist())

    out = []
    for i, c in enumerate(casualties):
        pediatric = bool(rng.uniform() < preset.pediatric_share)
        out.append(_casualty(rng, f"P{i + 1:03d}", c["t"], c["arch"], pediatric, i in surprise_idx,
                             preset.length_min))

    return {
        "name": preset.name,
        "title": preset.title,
        "lengthMin": preset.length_min,
        "protocol": preset.protocol,
        "seed": seed,
        "illustrative": True,
        "notice": "Synthetic scenario. All values are illustrative placeholders, not clinical evidence.",
        "resources": preset.resources,
        "casualties": out,
        "evacSlots": list(preset.evac_slots),
        "resupply": list(preset.resupply),
    }


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--preset", choices=sorted(PRESETS), default="stadium")
    ap.add_argument("--seed", type=int, default=None, help="default: the tuned seed for the preset")
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args(argv)
    seed = args.seed if args.seed is not None else DEMO_SEEDS[args.preset]
    scenario = generate(PRESETS[args.preset], seed)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(scenario, indent=2) + "\n")
    n = len(scenario["casualties"])
    print(f"wrote {args.out} — {scenario['title']}: {n} casualties, {len(scenario['evacSlots'])} evac slots")


if __name__ == "__main__":
    main()
