"""Fitting the path-loss model to this deployment's own measurements.

`estimators.RANGE_MODEL` ships generic indoor-survey constants — a reasonable
guess about a generic building, and wrong about any specific one. Given
ground-truth AP positions, the true distance to every reading is known, so the
two constants can be fitted to the environment actually being surveyed.

The maths is deliberately simple. The log-distance path-loss model

    rssi = ref - 10 * n * log10(d)

is *linear in log10(d)*, so fitting it is ordinary least squares on
(log10(d), rssi): the intercept is `ref`, and the slope is `-10n`. No numpy
required, matching this project's no-new-dependency posture.
"""

import math

# Below this many samples a fit is curve-fitting noise, not measuring an
# environment. Two points define a line exactly and tell you nothing about
# whether the model holds.
MIN_CALIBRATION_SAMPLES = 8

# A reading at (or inside) 1m makes log10(d) zero or negative and contributes
# nothing but leverage; sub-metre "distances" are also almost always a GPS
# artefact rather than a real measurement.
MIN_CALIBRATION_DISTANCE_M = 1.5


def fit_path_loss(samples: list[dict]) -> dict:
    """Least-squares fit of (ref_rssi_at_1m, path_loss_exponent).

    samples: [{"rssi": float, "distance_m": float}, ...] — `distance_m` being
    the *true* distance, from a ground-truth AP position to where the reading
    was taken.

    Returns the fitted constants plus the context needed to judge them:
    `r_squared`, `sample_count`, and the distance range fitted over. That
    range matters — constants derived entirely from 5-10m readings say nothing
    trustworthy about 60m, and a caller that hides it invites exactly that
    mistake.

    Returns `{"available": False, "reason": ...}` rather than a fit when
    there's too little data or too little spread to support one.
    """
    usable = [
        s for s in samples
        if s.get("distance_m") is not None
        and s["distance_m"] >= MIN_CALIBRATION_DISTANCE_M
        and s.get("rssi") is not None
        and math.isfinite(s["rssi"])
    ]
    if len(usable) < MIN_CALIBRATION_SAMPLES:
        return {
            "available": False,
            "reason": (
                f"Needs at least {MIN_CALIBRATION_SAMPLES} readings more than "
                f"{MIN_CALIBRATION_DISTANCE_M}m from a pinned access point; have {len(usable)}."
            ),
            "sample_count": len(usable),
        }

    xs = [math.log10(s["distance_m"]) for s in usable]
    ys = [float(s["rssi"]) for s in usable]
    n = len(xs)
    mean_x = sum(xs) / n
    mean_y = sum(ys) / n

    sxx = sum((x - mean_x) ** 2 for x in xs)
    if sxx < 1e-12:
        # Every reading at effectively one distance: a horizontal line fits
        # perfectly and says nothing about how signal falls off.
        return {
            "available": False,
            "reason": "All readings are at nearly the same distance — no falloff to fit against.",
            "sample_count": n,
        }

    sxy = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys))
    slope = sxy / sxx
    intercept = mean_y - slope * mean_x

    ss_tot = sum((y - mean_y) ** 2 for y in ys)
    ss_res = sum((y - (intercept + slope * x)) ** 2 for x, y in zip(xs, ys))
    r_squared = 1 - (ss_res / ss_tot) if ss_tot > 0 else 0.0

    distances = [s["distance_m"] for s in usable]
    exponent = -slope / 10

    return {
        "available": True,
        "ref_rssi_at_1m": intercept,
        # A negative exponent would mean signal getting *stronger* with
        # distance — real data never does that, so it means the fit is being
        # driven by noise rather than propagation. Reported, not silently
        # clamped, so the caller can see it and decline.
        "path_loss_exponent": exponent,
        "plausible": exponent > 0,
        "r_squared": r_squared,
        "sample_count": n,
        "min_distance_m": min(distances),
        "max_distance_m": max(distances),
    }
