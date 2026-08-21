"""Selectable position estimators — "where is this transmitter, actually?"

Several different algorithms can answer that from the same raw observations,
and they disagree in informative ways: the centroid is robust but biased
toward wherever you happened to walk, multilateration is sharper but trusts a
distance model, and FTM is the only one measuring real distance rather than
inferring it. Rather than hardcoding one, this module makes the choice
explicit and comparable.

**All estimators live here, in Python only.** The frontend and Android
consume computed positions instead of each porting the maths. That's a
deliberate departure from the `weighted_centroid` / `geo.ts` / `Geo.kt`
three-way port: a centroid is ~8 lines and safe to triplicate (there's a
parity test), but a Gauss-Newton solver plus a path-loss model is not, and
three copies would drift. One implementation also means comparing estimators
can never be comparing subtly different code.
"""

import math

from .localization import haversine_m, solve_ap_position

CENTROID = "centroid"
STRONGEST = "strongest"
RSSI_MULTILATERATION = "rssi_multilateration"
FTM_MULTILATERATION = "ftm_multilateration"

DEFAULT_ESTIMATOR = CENTROID

ESTIMATORS = (CENTROID, STRONGEST, RSSI_MULTILATERATION, FTM_MULTILATERATION)

ESTIMATOR_LABELS = {
    CENTROID: "Signal-weighted centroid",
    STRONGEST: "Strongest reading",
    RSSI_MULTILATERATION: "RSSI multilateration (path loss)",
    FTM_MULTILATERATION: "FTM multilateration (Wi-Fi RTT)",
}

# Direct port of RANGE_MODEL in frontend/src/coverageConfig.ts — keep the two
# in step; there's a parity test pinning these exact numbers. LAN is absent on
# purpose: its weight is response time in ms, not a dBm signal, so no distance
# can be inferred from it.
RANGE_MODEL = {
    "wifi": {"ref_rssi_at_1m": -40.0, "path_loss_exponent": 2.7},
    "ble": {"ref_rssi_at_1m": -59.0, "path_loss_exponent": 2.2},
    "cellular": {"ref_rssi_at_1m": 10.0, "path_loss_exponent": 3.5},
}

# Also from coverageConfig.ts (RADIUS_CAP_METERS / MIN_RANGE_METERS /
# UNCAPPED_RANGE_CEILING_METERS). Cellular is uncapped there (a sector
# legitimately covers km-scale areas) and falls back to the ceiling.
RADIUS_CAP_METERS = {"wifi": 75.0, "ble": 20.0, "cellular": math.inf, "lan": 75.0}
MIN_RANGE_METERS = 3.0
UNCAPPED_RANGE_CEILING_METERS = 1500.0


def path_loss_distance_m(rssi, radio_kind, model=None):
    """Log-distance path loss, the standard single-reading range estimate:

        distance = 10 ^ ((ref_rssi_at_1m - rssi) / (10 * path_loss_exponent))

    Port of estimateRangeMeters() in frontend/src/coverageConfig.ts, including
    its clamping. Returns None for radio kinds with no signal model (LAN).

    Note the design doc's warning: RSSI should NOT primarily be treated as a
    distance measurement. It's used that way here only inside an estimator the
    user explicitly selects and can compare against FTM — which is precisely
    how you'd discover how wrong it is.
    """
    # `model` lets a caller pass a fitted model (see scans/calibration.py)
    # in place of the generic constants. The generic ones remain the
    # documented default and the fallback.
    model = model or RANGE_MODEL.get(radio_kind)
    if model is None or rssi is None or not math.isfinite(rssi):
        return None
    distance = 10 ** ((model["ref_rssi_at_1m"] - rssi) / (10 * model["path_loss_exponent"]))
    cap = RADIUS_CAP_METERS.get(radio_kind, math.inf)
    if not math.isfinite(cap):
        cap = UNCAPPED_RANGE_CEILING_METERS
    return min(max(distance, MIN_RANGE_METERS), cap)


# How far apart two readings of one transmitter can plausibly be and still
# describe the same physical thing. Generous — a survey legitimately spans a
# building or a street — but far below the continental distances that show up
# when one identifier is genuinely two different transmitters (a recycled
# BSSID, a randomized MAC collision, or two datasets merged in one database).
OUTLIER_CLUSTER_RADIUS_M = {"wifi": 2000.0, "ble": 2000.0, "cellular": 35000.0, "lan": 2000.0}


def reject_outlying_readings(points, radio_kind="wifi"):
    """Keep only the largest spatial cluster of readings, discarding the rest.

    One identifier observed in two places thousands of kilometres apart is not
    one transmitter that moved — it's two different transmitters sharing an
    identifier, or two datasets in one database. Estimating from both produces
    garbage: a centroid lands in the ocean between them, and multilateration,
    asked to satisfy mutually impossible constraints, diverges to coordinates
    that aren't on Earth at all.

    Greedy largest-cluster rather than a median/MAD cut, because the failure
    mode here is *bimodal*: with readings split between two continents the
    median sits between them and every reading looks equally deviant. Picking
    the densest cluster keeps whichever location the device was actually
    observed at most, and says how many readings that dropped.
    """
    if len(points) < 2:
        return points, 0

    radius = OUTLIER_CLUSTER_RADIUS_M.get(radio_kind, 2000.0)

    # Fast path for the overwhelmingly common case: if every reading already
    # fits inside the radius there are no outliers to find, and the O(n^2)
    # scan below would be wasted. The coverage endpoints run this for every
    # device on the map, so that matters.
    lats = [p["lat"] for p in points]
    lngs = [p["lng"] for p in points]
    if haversine_m(min(lats), min(lngs), max(lats), max(lngs)) <= radius:
        return points, 0

    best = None
    for candidate in points:
        near = [
            p for p in points
            if haversine_m(candidate["lat"], candidate["lng"], p["lat"], p["lng"]) <= radius
        ]
        if best is None or len(near) > len(best):
            best = near
    return best, len(points) - len(best)


def _is_plausible_position(lat, lng, points):
    """Whether a solved position is somewhere a transmitter could actually be.

    Unconstrained Gauss-Newton has no idea what a latitude is: handed
    mutually-inconsistent distances it happily walks off to lat 138, lng
    40253, which then renders as a marker somewhere near the pole. A solver
    result is only trustworthy if it's a real coordinate *and* it sits
    somewhere near the readings that produced it — a transmitter estimated
    hundreds of kilometres from every observation is a divergence, not a
    discovery.
    """
    if not all(math.isfinite(v) for v in (lat, lng)):
        return False
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        return False
    nearest = min(haversine_m(lat, lng, p["lat"], p["lng"]) for p in points)
    return nearest <= MAX_SOLVE_DISTANCE_FROM_READINGS_M


# A transmitter further than this from its own nearest observation isn't an
# estimate, it's a diverged solve. Deliberately loose (a cell sector really
# can be tens of km from where you heard it) while still excluding the
# continental-scale nonsense divergence produces.
MAX_SOLVE_DISTANCE_FROM_READINGS_M = 50000.0


def _weighted_centroid(points):
    """Signal-weighted centre of everywhere the device was heard.

    Identical formula to weighted_centroid() in views.py and weightedCentroid()
    in geo.ts/Geo.kt — the 0.1 floor means the weakest reading still counts for
    something, so a few strong readings can't collapse the centre onto
    themselves.
    """
    weights = [p["weight"] for p in points]
    min_w, max_w = min(weights), max(weights)
    spread = (max_w - min_w) or 1
    w = [0.1 + 0.9 * ((weight - min_w) / spread) for weight in weights]
    total = sum(w)
    return (
        sum(wi * p["lat"] for wi, p in zip(w, points)) / total,
        sum(wi * p["lng"] for wi, p in zip(w, points)) / total,
    )


def _unavailable(estimator, reason, points, radio_kind, discarded=0):
    """An estimator that can't run falls back to the centroid — but says so.
    Never silently substitute one algorithm's answer under another's name;
    the whole point of this module is knowing which one produced a number."""
    fallback = _weighted_centroid(points)
    return {
        "estimator": estimator,
        "available": False,
        "reason": reason,
        "fell_back_to": CENTROID,
        "lat": fallback[0],
        "lng": fallback[1],
        "sample_count": len(points),
        "discarded_outliers": discarded,
        "residuals": _distance_residuals(fallback[0], fallback[1], points),
    }


def _distance_residuals(lat, lng, points, predicted_key=None):
    """Per-reading agreement with the fitted position, worst first.

    For the multilateration estimators this is a true fit residual (predicted
    range minus measured range). For centroid/strongest there is no distance
    model, so it's plain distance-from-estimate — reported under its own
    `kind` rather than dressed up as a residual it isn't.
    """
    rows = []
    for point in points:
        distance_to_estimate = haversine_m(lat, lng, point["lat"], point["lng"])
        row = {
            "lat": point["lat"],
            "lng": point["lng"],
            "weight": point["weight"],
            "observed_at": point.get("observed_at"),
            "scan_session_id": point.get("scan_session_id"),
            "distance_to_estimate_m": distance_to_estimate,
        }
        if predicted_key is not None and point.get(predicted_key) is not None:
            row["measured_distance_m"] = point[predicted_key]
            row["residual_m"] = distance_to_estimate - point[predicted_key]
            row["kind"] = "fit_residual"
        else:
            row["residual_m"] = None
            row["kind"] = "distance_only"
        rows.append(row)

    # Worst first: a multipath outlier should be the first thing you see.
    rows.sort(key=lambda r: abs(r["residual_m"]) if r["residual_m"] is not None else r["distance_to_estimate_m"], reverse=True)
    return rows


def estimate_position(points, estimator=DEFAULT_ESTIMATOR, radio_kind="wifi", range_model=None):
    """Estimate a transmitter's position from its observations.

    points: [{"lat", "lng", "weight", ...}] where `weight` is the reading's
    signal (dBm for wifi/ble/cellular). Optionally `distance_m` per point for
    FTM_MULTILATERATION, and `observed_at`/`scan_session_id` which are passed
    through to the residual rows.

    Always returns a position (falling back to the centroid), plus whether the
    requested estimator actually ran.
    """
    if not points:
        return {
            "estimator": estimator,
            "available": False,
            "reason": "No geotagged observations for this device.",
            "lat": None,
            "lng": None,
            "sample_count": 0,
            "residuals": [],
        }

    if estimator not in ESTIMATORS:
        estimator = DEFAULT_ESTIMATOR

    # Drop readings that can't describe the same transmitter before any
    # algorithm sees them — otherwise every estimator is being asked to fit
    # impossible data, and each fails differently (see
    # reject_outlying_readings).
    points, discarded = reject_outlying_readings(points, radio_kind)
    if not points:
        return {
            "estimator": estimator,
            "available": False,
            "reason": "No readings left after discarding geographic outliers.",
            "lat": None,
            "lng": None,
            "sample_count": 0,
            "discarded_outliers": discarded,
            "residuals": [],
        }

    if estimator == CENTROID:
        lat, lng = _weighted_centroid(points)
        return {
            "estimator": CENTROID,
            "available": True,
            "discarded_outliers": discarded,
            "lat": lat,
            "lng": lng,
            "sample_count": len(points),
            "residuals": _distance_residuals(lat, lng, points),
        }

    if estimator == STRONGEST:
        best = max(points, key=lambda p: p["weight"])
        return {
            "estimator": STRONGEST,
            "available": True,
            "discarded_outliers": discarded,
            "lat": best["lat"],
            "lng": best["lng"],
            "sample_count": len(points),
            "residuals": _distance_residuals(best["lat"], best["lng"], points),
        }

    if estimator == RSSI_MULTILATERATION:
        if range_model is None and radio_kind not in RANGE_MODEL:
            return _unavailable(
                estimator,
                f"No signal-to-distance model for {radio_kind} — its readings aren't a dBm signal.",
                points,
                radio_kind,
                discarded,
            )
        ranged = []
        for point in points:
            distance = path_loss_distance_m(point["weight"], radio_kind, range_model)
            if distance is None:
                continue
            ranged.append({**point, "distance_m": distance, "weight": 1.0})
        if len(ranged) < 3 or len({(round(p["lat"], 6), round(p["lng"], 6)) for p in ranged}) < 2:
            return _unavailable(
                estimator,
                "Needs at least 3 readings from 2+ distinct positions to solve.",
                points,
                radio_kind,
                discarded,
            )
        solved = solve_ap_position(ranged)
        if not _is_plausible_position(solved["lat"], solved["lng"], ranged):
            return _unavailable(
                estimator,
                "The solver didn't converge on a position near these readings — they disagree too much "
                "to be one transmitter.",
                points,
                radio_kind,
                discarded,
            )
        return {
            "estimator": RSSI_MULTILATERATION,
            "available": True,
            "discarded_outliers": discarded,
            "lat": solved["lat"],
            "lng": solved["lng"],
            "rms_residual_m": solved["rms_residual_m"],
            "sample_count": len(ranged),
            "residuals": _distance_residuals(solved["lat"], solved["lng"], ranged, predicted_key="distance_m"),
        }

    # FTM_MULTILATERATION — only points carrying a real measured distance.
    ranged = [p for p in points if p.get("distance_m") is not None]
    if len(ranged) < 3 or len({p.get("scan_session_id") for p in ranged}) < 2:
        return _unavailable(
            estimator,
            "Needs at least 3 successful FTM readings from 2+ observer positions. "
            "Range this network from the Android app to collect them.",
            points,
            radio_kind,
            discarded,
        )
    solved = solve_ap_position(ranged)
    if not _is_plausible_position(solved["lat"], solved["lng"], ranged):
        return _unavailable(
            estimator,
            "The solver didn't converge on a position near these readings — the measured distances "
            "disagree too much to be one transmitter.",
            points,
            radio_kind,
            discarded,
        )
    return {
        "estimator": FTM_MULTILATERATION,
        "available": True,
        "discarded_outliers": discarded,
        "lat": solved["lat"],
        "lng": solved["lng"],
        "rms_residual_m": solved["rms_residual_m"],
        "sample_count": len(ranged),
        "residuals": _distance_residuals(solved["lat"], solved["lng"], ranged, predicted_key="distance_m"),
    }


def ranged_points_for(points, estimator, radio_kind="wifi", range_model=None):
    """Readings annotated with a distance, for the estimators that have one.

    The AP-position probability surface is a likelihood over candidate
    positions given *distances*, so it only means anything for the
    multilateration estimators. A centroid has no distance model and therefore
    no likelihood surface — returning an empty list here is what lets the
    caller say so instead of drawing a shape that implies maths it never did.
    """
    if estimator == FTM_MULTILATERATION:
        return [p for p in points if p.get("distance_m") is not None]
    if estimator == RSSI_MULTILATERATION and (range_model is not None or radio_kind in RANGE_MODEL):
        ranged = []
        for point in points:
            distance = path_loss_distance_m(point["weight"], radio_kind, range_model)
            if distance is not None:
                ranged.append({**point, "distance_m": distance, "weight": 1.0})
        return ranged
    return []


def compare_estimators(points, radio_kind="wifi", ftm_points=None, range_model=None):
    """Every estimator's answer for one device, plus how far apart they are.

    The disagreement matrix is the actual product here: two estimators landing
    3m apart means the position is well determined; 200m apart means at least
    one of them is being fooled, and which readings drive that is visible in
    each one's residuals.
    """
    results = {}
    for estimator in ESTIMATORS:
        source = points
        if estimator == FTM_MULTILATERATION and ftm_points is not None:
            source = ftm_points
        results[estimator] = estimate_position(source, estimator, radio_kind, range_model)

    available = {k: v for k, v in results.items() if v["available"] and v["lat"] is not None}
    disagreements = []
    names = sorted(available)
    for i, a in enumerate(names):
        for b in names[i + 1 :]:
            disagreements.append({
                "a": a,
                "b": b,
                "distance_m": haversine_m(
                    available[a]["lat"], available[a]["lng"], available[b]["lat"], available[b]["lng"]
                ),
            })

    return {
        "estimates": results,
        "disagreements": sorted(disagreements, key=lambda d: d["distance_m"], reverse=True),
        "labels": ESTIMATOR_LABELS,
    }
