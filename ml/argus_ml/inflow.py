"""Inflow forecaster.

A Poisson rate model with a conjugate Gamma posterior, updated every simulated
minute with exponentially weighted arrival counts (recent minutes count more).
Prophet would be overkill for two hours of data.

Output: expected arrivals in the next 30 / 60 / 90 minutes with an 80% range
(10th–90th percentile of the Gamma–Poisson predictive distribution).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

# Weak prior: ~6 casualties/hour until data says otherwise.
PRIOR_SHAPE = 1.0
PRIOR_RATE_MIN = 10.0  # pseudo-minutes of exposure
HALF_LIFE_MIN = 15.0
BUCKET_MIN = 1.0


@dataclass(frozen=True)
class InflowForecast:
    rate_per_hour: float
    shape: float  # Gamma posterior over the per-minute rate
    rate: float
    horizons: dict[int, tuple[float, float, float]]  # h -> (expected, p10, p90)

    def sample_rates(self, rng: np.random.Generator, n: int) -> np.ndarray:
        """Per-minute arrival rates drawn from the posterior (for Monte Carlo)."""
        return rng.gamma(self.shape, 1.0 / self.rate, size=n)


def forecast_inflow(arrival_minutes: list[float], now: float, surge_extra: int = 0,
                    rng: np.random.Generator | None = None,
                    horizons: tuple[int, ...] = (30, 60, 90)) -> InflowForecast:
    rng = rng or np.random.default_rng(0)
    now = max(now, 0.0)
    arrivals = np.asarray([a for a in arrival_minutes if a <= now], dtype=float)

    # Exponentially weighted count and exposure.
    decay = np.log(2) / HALF_LIFE_MIN
    if now > 0:
        edges = np.arange(0.0, now + BUCKET_MIN, BUCKET_MIN)
        counts, _ = np.histogram(arrivals, bins=edges) if len(edges) > 1 else (np.array([]), None)
        centers = edges[:-1] + BUCKET_MIN / 2
        w = np.exp(-decay * (now - centers))
        eff_count = float((w * counts).sum())
        eff_exposure = float((w * BUCKET_MIN).sum())
    else:
        eff_count, eff_exposure = 0.0, 0.0

    shape = PRIOR_SHAPE + eff_count
    rate = PRIOR_RATE_MIN + eff_exposure
    lam = shape / rate  # posterior mean, per minute

    out: dict[int, tuple[float, float, float]] = {}
    lam_samples = rng.gamma(shape, 1.0 / rate, size=4000)
    for h in horizons:
        surge = surge_extra * min(h, 60) / 60.0
        draws = rng.poisson(lam_samples * h) + surge
        out[h] = (round(lam * h + surge, 1), float(np.percentile(draws, 10)), float(np.percentile(draws, 90)))
    return InflowForecast(rate_per_hour=round(lam * 60, 2), shape=shape, rate=rate, horizons=out)
