"""Resource burn-down: Monte Carlo over arrival and consumption uncertainty.

For each of 500 runs we draw
  * an arrival rate from the inflow posterior (+ any what-if surge),
  * a triage-category mix from a Dirichlet posterior over observed arrivals,
  * per-patient resource use from per-category means learned on the fly
    (a prior blended with what this incident has actually consumed),
  * noise on the remaining demand of every active consumption event,
and project availability forward in 5-minute steps for 4 hours.

Output per resource: median time-to-zero with a 10th–90th percentile band,
and the projected availability curve that the dashboard draws. Consumables hit
"zero" when stock runs out; reusables (vents, OR tables, beds) hit "zero" when
demand exceeds capacity and a queue forms. The projection is conservative: it
assumes no further evacuations or resupply beyond what is already scheduled.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .board import Board
from .inflow import InflowForecast

STEP_MIN = 5.0
HORIZON_MIN = 240.0
RUNS = 500
CURVE_EVERY_MIN = 10.0
NEVER = 1e9

CATEGORIES = ("immediate", "delayed", "minimal", "expectant", "dead")
MIX_PRIOR = np.array([1.0, 1.5, 1.5, 0.1, 0.1])

# Illustrative per-arrival priors.  Consumables: mean amount per patient.
# Reusables: probability a patient needs one unit.
PRIOR_USE: dict[str, dict[str, float]] = {
    "blood_unit": {"immediate": 3.6, "delayed": 0.8, "minimal": 0.0, "expectant": 0.5, "dead": 0.0},
    "o2": {"immediate": 1.2, "delayed": 0.6, "minimal": 0.1, "expectant": 1.0, "dead": 0.0},
    "vent": {"immediate": 0.25, "delayed": 0.05, "minimal": 0.0, "expectant": 0.1, "dead": 0.0},
    "or_table": {"immediate": 0.6, "delayed": 0.25, "minimal": 0.0, "expectant": 0.0, "dead": 0.0},
    "bed": {"immediate": 1.0, "delayed": 1.0, "minimal": 0.0, "expectant": 1.0, "dead": 0.0},
}
PRIOR_STRENGTH = 4.0  # pseudo-patients behind each prior
CONSUMABLE_CV = 0.5
# Reusable holds: (delay after arrival, duration); duration None = held past horizon.
HOLD_SHAPE: dict[str, tuple[float, float | None]] = {
    "or_table": (20.0, 90.0),
    "vent": (25.0, None),
    "bed": (0.0, None),
}
CONSUMPTION_DELAY_MIN = 5.0
CONSUMPTION_SPREAD_MIN = 60.0


@dataclass(frozen=True)
class ResourceForecast:
    resource_type: str
    available: float
    capacity: float
    ttz_median: float  # -1 = beyond horizon
    ttz_p10: float
    ttz_p90: float
    burn_per_hour: float
    curve: list[list[float]]  # [minutesAhead, p10, p50, p90]


def _steps() -> np.ndarray:
    return np.arange(0.0, HORIZON_MIN + STEP_MIN, STEP_MIN)


def learned_use(board: Board) -> dict[str, dict[str, float]]:
    """Blend priors with what this incident has actually used, per category."""
    by_patient: dict[int, dict[str, float]] = {}
    for e in board.events:
        d = by_patient.setdefault(int(e["patient_id"]), {})
        amt = float(e["amount"])
        d[e["resource_type"]] = d.get(e["resource_type"], 0.0) + amt
    # Only learn from patients who have been on site long enough for needs to show.
    mature = [p for p in board.patients if board.minute - float(p["arrival_min"]) >= 25]
    out: dict[str, dict[str, float]] = {}
    for r, prior in PRIOR_USE.items():
        out[r] = {}
        for c in CATEGORIES:
            group = [p for p in mature if p["category"] == c]
            n = len(group)
            if r == "bed" or n == 0:
                out[r][c] = prior[c]
                continue
            if r in HOLD_SHAPE:
                obs = sum(1.0 for p in group if by_patient.get(int(p["id"]), {}).get(r, 0) > 0) / n
            else:
                obs = sum(by_patient.get(int(p["id"]), {}).get(r, 0.0) for p in group) / n
            out[r][c] = (PRIOR_STRENGTH * prior[c] + n * obs) / (PRIOR_STRENGTH + n)
    return out


def _mix_posterior(board: Board) -> np.ndarray:
    counts = np.array([sum(1 for p in board.patients if p["category"] == c) for c in CATEGORIES], float)
    return MIX_PRIOR + counts


def _future_arrivals(rng: np.random.Generator, inflow: InflowForecast, surge: int,
                     mix_alpha: np.ndarray, n_steps: int) -> np.ndarray:
    """Arrivals per run, step and category: shape (RUNS, n_steps, K)."""
    lam = inflow.sample_rates(rng, RUNS)[:, None] * STEP_MIN  # per-step expected
    expected = np.repeat(lam, n_steps, axis=1)
    if surge > 0:
        surge_steps = int(60 / STEP_MIN)
        expected[:, 1 : 1 + surge_steps] += surge / surge_steps
    counts = rng.poisson(expected)
    counts[:, 0] = 0  # step 0 is "now"
    mix = rng.dirichlet(mix_alpha, size=RUNS)  # (RUNS, K)
    return rng.multinomial(counts, mix[:, None, :])


def _spread_kernel(n_steps: int, delay: float, spread: float) -> np.ndarray:
    k = np.zeros(n_steps)
    a = round(delay / STEP_MIN) + 1
    b = a + max(1, round(spread / STEP_MIN))
    k[a:min(b, n_steps)] = 1.0 / max(1, b - a)
    return k


def _convolve_rows(x: np.ndarray, kernel: np.ndarray) -> np.ndarray:
    n = x.shape[1]
    out = np.zeros_like(x, dtype=float)
    for lag in np.nonzero(kernel)[0]:
        out[:, lag:] += x[:, : n - lag] * kernel[lag]
    return out


def _ttz(available: np.ndarray, steps: np.ndarray, strict: bool) -> np.ndarray:
    """First step where availability hits zero (≤0) or goes negative (strict)."""
    hit = available < -1e-9 if strict else available <= 1e-9
    any_hit = hit.any(axis=1)
    first = hit.argmax(axis=1)
    return np.where(any_hit, steps[first], NEVER)


def _summarise(rtype: str, available0: float, capacity: float, avail: np.ndarray, steps: np.ndarray,
               ttz: np.ndarray, burn: np.ndarray) -> ResourceForecast:
    def pct(q: float) -> float:
        v = float(np.percentile(ttz, q, method="nearest"))
        return -1.0 if v >= NEVER else round(v, 1)

    every = int(CURVE_EVERY_MIN / STEP_MIN)
    curve = []
    for i in range(0, len(steps), every):
        col = avail[:, i]
        curve.append([float(steps[i]), round(float(np.percentile(col, 10)), 2),
                      round(float(np.percentile(col, 50)), 2), round(float(np.percentile(col, 90)), 2)])
    return ResourceForecast(
        resource_type=rtype,
        available=round(available0, 2),
        capacity=capacity,
        ttz_median=pct(50),
        ttz_p10=pct(10),
        ttz_p90=pct(90),
        burn_per_hour=round(float(np.median(burn)), 2),
        curve=curve,
    )


def forecast_burndown(board: Board, inflow: InflowForecast, seed: int = 0) -> dict[str, ResourceForecast]:
    rng = np.random.default_rng(seed)
    steps = _steps()
    n = len(steps)
    now = board.minute
    surge = int(board.state.get("what_if_surge", 0) or 0)
    use = learned_use(board)
    arrivals = _future_arrivals(rng, inflow, surge, _mix_posterior(board), n)  # (R, n, K)
    hour = int(60 / STEP_MIN)
    out: dict[str, ResourceForecast] = {}

    for rtype, res in board.resources.items():
        capacity = float(res["capacity"])
        in_use = float(res["in_use"])
        kind = res["kind"]
        cat_use = np.array([use.get(rtype, {}).get(c, 0.0) for c in CATEGORIES])

        resupply = np.zeros(n)
        eta = float(res.get("resupply_eta_min", -1))
        if eta >= 0 and eta - now <= HORIZON_MIN:
            resupply[int(max(0.0, eta - now) // STEP_MIN):] = float(res.get("resupply_amount", 0))

        if kind == "consumable":
            available0 = capacity - in_use
            demand = np.zeros((RUNS, n))
            # Remaining demand of active events.
            for e in board.events:
                if e["resource_type"] != rtype or e["status"] != "active":
                    continue
                remaining = float(e["amount"]) - float(e["consumed"])
                if remaining <= 0:
                    continue
                end = float(e["start_min"]) + float(e["duration_min"]) - now
                k = max(1, int(np.ceil(max(end, STEP_MIN) / STEP_MIN)))
                noise = rng.lognormal(0.0, 0.15, size=(RUNS, 1))
                demand[:, 1 : 1 + min(k, n - 1)] += (remaining / k) * noise
            # Recently arrived patients whose needs have not started yet.
            started = {(int(e["patient_id"])) for e in board.events if e["resource_type"] == rtype}
            pending = sum(
                use[rtype].get(p["category"], 0.0) * 0.6
                for p in board.on_site
                if now - float(p["arrival_min"]) < 15 and int(p["id"]) not in started
            )
            if pending > 0:
                demand += pending * _spread_kernel(n, 0, 40)[None, :]
            # Future arrivals.
            new_amount_mean = (arrivals * cat_use[None, None, :]).sum(axis=2)  # (R, n)
            shape = np.maximum(new_amount_mean, 1e-9) / (CONSUMABLE_CV**2 * np.maximum(cat_use.max(), 1e-9))
            new_amount = np.where(new_amount_mean > 0,
                                  rng.gamma(shape, new_amount_mean / np.maximum(shape, 1e-9)), 0.0)
            demand += _convolve_rows(new_amount, _spread_kernel(n, CONSUMPTION_DELAY_MIN, CONSUMPTION_SPREAD_MIN))

            avail = available0 + resupply[None, :] - np.cumsum(demand, axis=1)
            ttz = _ttz(avail, steps, strict=False) if available0 > 1e-9 else np.zeros(RUNS)
            burn = demand[:, 1 : 1 + hour].sum(axis=1)
            out[rtype] = _summarise(rtype, available0, capacity, avail, steps, ttz, burn)
            continue

        # Reusable: occupancy over time.
        occ = np.full((RUNS, n), in_use)
        queued = 0.0
        for e in board.events:
            if e["resource_type"] != rtype:
                continue
            if e["status"] == "active" and float(e["duration_min"]) > 0:
                release = float(e["start_min"]) + float(e["duration_min"]) - now
                jitter = rng.normal(0, 8, size=RUNS)
                idx = np.clip(np.ceil((release + jitter) / STEP_MIN), 0, n).astype(int)
                mask = np.arange(n)[None, :] >= idx[:, None]
                occ -= float(e["amount"]) * mask
            elif e["status"] == "queued":
                queued += float(e["amount"])
        if rtype == "bed":
            queued += sum(1 for p in board.patients if p["status"] == "waiting")
        occ += queued

        new_holds = rng.binomial(arrivals, np.clip(cat_use, 0, 1)[None, None, :]).sum(axis=2).astype(float)
        delay, duration = HOLD_SHAPE.get(rtype, (0.0, None))
        d = round(delay / STEP_MIN)
        shifted = np.zeros_like(new_holds)
        if d < n:
            shifted[:, d:] = new_holds[:, : n - d]
        if duration is None:
            occ += np.cumsum(shifted, axis=1)
        else:
            dur = max(1, round(duration / STEP_MIN))
            c = np.cumsum(shifted, axis=1)
            lagged = np.zeros_like(c)
            if dur < n:
                lagged[:, dur:] = c[:, : n - dur]
            occ += c - lagged

        avail = capacity - occ
        ttz = _ttz(avail, steps, strict=True)
        burn = new_holds[:, 1 : 1 + hour].sum(axis=1)
        out[rtype] = _summarise(rtype, capacity - in_use, capacity, avail, steps, ttz, burn)

    return out
