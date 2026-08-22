"""AP position estimation from Wi-Fi RTT/FTM ranging samples — V4 of
ap-localization-design.md. Given known observer positions and measured
distances to one BSSID, estimate the BSSID's own position by minimizing
weighted ranging error:

    argmin(x,y) sum(w_i * (distance(P_i, AP) - d_i)^2)

rather than literal circle intersections, which real (noisy, multipath-prone)
measurements don't support. No numpy/scipy dependency — two unknowns (lat,
lng) is small enough for a hand-rolled weighted Gauss-Newton iteration with a
finite-difference Jacobian and a direct 2x2 linear solve per step.
"""

import math

EARTH_RADIUS_M = 6371008.8  # mean Earth radius (IUGG), metres
# Matches frontend/src/geo.ts and mission/Geo.kt's own constant, so a metre
# offset means the same thing in all three places.
METERS_PER_DEGREE_LAT = 111320.0

# Finite-difference step for the Jacobian, in degrees — small enough to
# approximate the local derivative well, large enough not to vanish in
# float64 subtraction (haversine_m distances are metres, ~1e-6 deg is ~0.1m).
_JACOBIAN_STEP_DEG = 1e-6
_MAX_ITERATIONS = 25
# Stop once an iteration's (dlat, dlng) update is smaller than this, in
# degrees — well under GPS accuracy, so further iterations wouldn't move the
# answer by anything measurable.
_CONVERGENCE_TOL_DEG = 1e-9


def haversine_m(lat1, lng1, lat2, lng2):
    """Great-circle distance in metres. Real spherical maths rather than a
    flat-plane approximation — matters once positions are more than a few
    tens of metres apart, which ranging baselines routinely are."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(a))


def _residual(lat, lng, obs):
    """Weighted residual for one observation at candidate (lat, lng) — the
    quantity Gauss-Newton drives toward zero. Pre-multiplying by sqrt(weight)
    turns the weighted least-squares problem into a plain (unweighted) least
    squares problem in the residuals actually being minimized."""
    return math.sqrt(obs["weight"]) * (haversine_m(lat, lng, obs["lat"], obs["lng"]) - obs["distance_m"])


def _jacobian(lat, lng, observations):
    """Finite-difference Jacobian of the weighted residuals w.r.t. (lat, lng),
    in degrees. Shared by the solver and the covariance estimate so the two
    can never disagree about the geometry they're describing."""
    residuals = [_residual(lat, lng, o) for o in observations]
    d_lat = [
        (_residual(lat + _JACOBIAN_STEP_DEG, lng, o) - r) / _JACOBIAN_STEP_DEG
        for r, o in zip(residuals, observations)
    ]
    d_lng = [
        (_residual(lat, lng + _JACOBIAN_STEP_DEG, o) - r) / _JACOBIAN_STEP_DEG
        for r, o in zip(residuals, observations)
    ]
    return residuals, d_lat, d_lng


def solve_ap_position(observations: list[dict]) -> dict:
    """observations: [{"lat", "lng", "distance_m", "weight"}, ...] — at least
    2, ideally 3+ from geometrically diverse positions (this function itself
    doesn't enforce a minimum; callers decide what's trustworthy enough to
    show, see AccessPointViewSet.ftm_position).

    Returns {"lat", "lng", "rms_residual_m", "iterations"} — the best-fit
    position plus a plain fit-quality number (not a real uncertainty
    estimate; that's V5's confidence ellipse/probability surface, a
    separate, harder problem building on this point estimate).
    """
    total_weight = sum(o["weight"] for o in observations)
    lat = sum(o["weight"] * o["lat"] for o in observations) / total_weight
    lng = sum(o["weight"] * o["lng"] for o in observations) / total_weight

    iterations = 0
    for iterations in range(1, _MAX_ITERATIONS + 1):
        residuals, d_lat, d_lng = _jacobian(lat, lng, observations)

        # Gauss-Newton normal equations, J^T J * delta = -J^T r, for the 2x2
        # case — solved directly via Cramer's rule rather than pulling in a
        # linear-algebra library for a single 2x2 system.
        a11 = sum(x * x for x in d_lat)
        a12 = sum(x * y for x, y in zip(d_lat, d_lng))
        a22 = sum(y * y for y in d_lng)
        b1 = -sum(x * r for x, r in zip(d_lat, residuals))
        b2 = -sum(y * r for y, r in zip(d_lng, residuals))

        det = a11 * a22 - a12 * a12
        if abs(det) < 1e-30:
            break  # degenerate Jacobian (e.g. every observer at ~the same spot) — stop where we are

        delta_lat = (b1 * a22 - b2 * a12) / det
        delta_lng = (a11 * b2 - a12 * b1) / det
        lat += delta_lat
        lng += delta_lng

        if abs(delta_lat) < _CONVERGENCE_TOL_DEG and abs(delta_lng) < _CONVERGENCE_TOL_DEG:
            break

    rms_residual_m = math.sqrt(sum(r * r for r in residuals) / len(residuals))
    return {"lat": lat, "lng": lng, "rms_residual_m": rms_residual_m, "iterations": iterations}


def meters_per_degree(lat):
    """Local metres-per-degree for (lat, lng), used to turn a covariance
    expressed in degrees into one expressed in metres."""
    return METERS_PER_DEGREE_LAT, METERS_PER_DEGREE_LAT * max(math.cos(math.radians(lat)), 0.01)


def position_covariance(lat, lng, observations: list[dict]) -> dict | None:
    """Parameter covariance of a solved position, as a confidence ellipse in
    metres — V5 of ap-localization-design.md.

    Standard weighted-least-squares result: cov = s^2 * (J^T W J)^-1, where
    s^2 is the reduced chi-square (sum of squared residuals over degrees of
    freedom). The sqrt(weight) is already folded into the residuals (see
    [_residual]), so J^T J here *is* J^T W J. Scaling by s^2 rather than
    trusting (J^T W J)^-1 alone means a set of readings that disagree with
    each other honestly widens the ellipse, instead of reporting whatever
    precision the reported per-reading stddevs claimed.

    Returns None when there aren't enough observations to have any degrees of
    freedom left (n <= 2 for 2 unknowns), or when the geometry is degenerate
    — an honest "can't say", not a fabricated ellipse.
    """
    dof = len(observations) - 2
    if dof <= 0:
        return None

    residuals, d_lat, d_lng = _jacobian(lat, lng, observations)
    a11 = sum(x * x for x in d_lat)
    a12 = sum(x * y for x, y in zip(d_lat, d_lng))
    a22 = sum(y * y for y in d_lng)
    det = a11 * a22 - a12 * a12
    if abs(det) < 1e-30:
        return None  # collinear/coincident observers — no unique ellipse

    s2 = sum(r * r for r in residuals) / dof
    # inv([[a11,a12],[a12,a22]]) = 1/det * [[a22,-a12],[-a12,a11]]
    c_lat_lat = s2 * a22 / det
    c_lat_lng = s2 * -a12 / det
    c_lng_lng = s2 * a11 / det

    m_lat, m_lng = meters_per_degree(lat)
    # Degrees^2 -> metres^2, per axis (the cross term picks up both scales).
    a = c_lat_lat * m_lat * m_lat  # north variance
    b = c_lat_lng * m_lat * m_lng  # north/east covariance
    c = c_lng_lng * m_lng * m_lng  # east variance

    # Closed-form eigenvalues of the symmetric 2x2 [[a,b],[b,c]].
    mean = (a + c) / 2
    diff = math.sqrt(((a - c) / 2) ** 2 + b * b)
    major_var = max(mean + diff, 0.0)
    minor_var = max(mean - diff, 0.0)

    # 95% coverage for 2 degrees of freedom: chi-square critical value 5.991.
    scale = math.sqrt(5.991)
    # Orientation as a compass bearing: the metre-space axes are (north,
    # east), so the eigenvector angle measured from the north axis toward
    # east is already a bearing. Normalized to [0, 180) — an ellipse axis has
    # no "direction", so 200 deg and 20 deg describe the same shape.
    orientation = math.degrees(0.5 * math.atan2(2 * b, a - c)) % 180.0

    return {
        "semi_major_m": math.sqrt(major_var) * scale,
        "semi_minor_m": math.sqrt(minor_var) * scale,
        "orientation_deg": orientation,
        "confidence": 0.95,
        # A single "how well do we know this" number for UI copy, rather than
        # making every caller reason about an ellipse.
        "rms_uncertainty_m": math.sqrt((major_var + minor_var) / 2),
    }


def position_probability_grid(
    observations: list[dict],
    center_lat: float,
    center_lng: float,
    span_m: float = 120.0,
    steps: int = 25,
) -> dict:
    """AP position probability surface — the design doc's *first* heatmap
    ("where is this AP most likely physically located?"), derived from FTM
    geometry. Deliberately not the coverage heatmap, which answers a
    different question from RSSI (see HeatmapPage.tsx); the design doc is
    explicit that the two must not be conflated.

    For every candidate cell, how well do all the ranging observations agree
    that the AP is *there*: chi2 = sum(w_i * (predicted - measured)^2). Values
    are reported as relative likelihood peak-normalized to 1.0 — the natural
    scale for shading a heatmap, and honest about being relative rather than
    an absolute probability mass.
    """
    steps = max(3, min(steps, 61))  # keep the response a sane size
    m_lat, m_lng = meters_per_degree(center_lat)
    half = span_m / 2

    cells = []
    min_chi2 = None
    for i in range(steps):
        for j in range(steps):
            offset_n = -half + (span_m * i / (steps - 1))
            offset_e = -half + (span_m * j / (steps - 1))
            lat = center_lat + offset_n / m_lat
            lng = center_lng + offset_e / m_lng
            chi2 = sum(
                o["weight"] * (haversine_m(lat, lng, o["lat"], o["lng"]) - o["distance_m"]) ** 2
                for o in observations
            )
            min_chi2 = chi2 if min_chi2 is None else min(min_chi2, chi2)
            cells.append({"lat": lat, "lng": lng, "chi2": chi2})

    for cell in cells:
        # Subtracting the minimum first keeps exp() from underflowing to a
        # uniformly-zero surface when chi2 values are large.
        cell["relative_likelihood"] = math.exp(-0.5 * (cell.pop("chi2") - min_chi2))

    return {"span_m": span_m, "steps": steps, "cells": cells}


# Two BSSIDs must clear this combined score to be called one physical unit.
# Set above what proximity alone can ever contribute (0.45), because
# co-location is emphatically *not* sufficient evidence: readings taken from
# a single spot give every AP in earshot the same estimated centroid, so a
# proximity-only rule would merge a whole apartment block into one "mesh
# node". Corroborating identity evidence (vendor OUI, consecutive MACs) is
# therefore required, not optional.
_MIN_LINK_CONFIDENCE = 0.6


def _mac_octets(bssid):
    try:
        return [int(part, 16) for part in bssid.split(":")]
    except (ValueError, AttributeError):
        return None


def _radios_look_like_one_node(a, b, radius_m):
    """Evidence that two BSSIDs are two radios inside one physical box,
    scored as (is_same_node, confidence, reasons). Deliberately returns a
    confidence rather than a boolean verdict — see [cluster_ap_hypotheses].
    """
    reasons = []
    score = 0.0

    distance_m = haversine_m(a["lat"], a["lng"], b["lat"], b["lng"])
    if distance_m > radius_m:
        return False, 0.0, []
    # Position is the primary evidence: two radios in one box are in the
    # same place, and nothing else here is worth much without that.
    score += 0.45 * (1 - distance_m / radius_m)
    reasons.append(f"estimated positions agree to {distance_m:.0f}m")

    if a["vendor_oui"] and a["vendor_oui"] == b["vendor_oui"]:
        score += 0.2
        reasons.append("same vendor OUI")

    oct_a, oct_b = _mac_octets(a["bssid"]), _mac_octets(b["bssid"])
    if oct_a and oct_b and len(oct_a) == 6 and len(oct_b) == 6:
        if oct_a[:5] == oct_b[:5] and abs(oct_a[5] - oct_b[5]) <= 8:
            # Vendors overwhelmingly assign one physical unit a small block
            # of consecutive MACs, one per radio — the single strongest
            # non-positional hint that two BSSIDs are one box.
            score += 0.25
            reasons.append("consecutive MAC addresses")
        elif oct_a[:3] == oct_b[:3]:
            score += 0.05
            reasons.append("same MAC prefix block")

    if a["ssid"] and a["ssid"] == b["ssid"]:
        score += 0.05
        reasons.append("same SSID")

    # Different bands is evidence *for* one node with several radios, rather
    # than two separate units that happen to be close together.
    if a["band"] and b["band"] and a["band"] != b["band"]:
        score += 0.05
        reasons.append("different bands (2.4/5/6GHz radios of one unit)")

    score = min(score, 1.0)
    return score >= _MIN_LINK_CONFIDENCE, score, reasons


def cluster_ap_hypotheses(candidates: list[dict], radius_m: float = 15.0) -> list[dict]:
    """Group BSSIDs that may be radios of the same physical access point —
    V8 of ap-localization-design.md.

    candidates: [{"bssid", "ssid", "vendor_oui", "band", "lat", "lng"}, ...]

    The design doc is emphatic that BSSID != physical AP and that the result
    must stay probabilistic. So this returns *hypotheses* carrying a
    confidence and the specific evidence behind them, never a hard claim:
    single-linkage grouping on position proximity, with the confidence of a
    group set by its weakest link (the least-certain pairing is what actually
    limits how much you should trust the whole group).

    Single-linkage (rather than requiring every member to be within radius of
    every other) matches the physical reality of a mesh node's radios being
    estimated at slightly different spots, chaining through a shared middle.
    """
    groups = []  # list of {"members": [...], "links": [(confidence, reasons)]}
    for candidate in candidates:
        joined = None
        for group in groups:
            for member in group["members"]:
                linked, confidence, reasons = _radios_look_like_one_node(candidate, member, radius_m)
                if linked:
                    group["members"].append(candidate)
                    group["links"].append((confidence, reasons))
                    joined = group
                    break
            if joined:
                break
        if joined is None:
            groups.append({"members": [candidate], "links": []})

    hypotheses = []
    for index, group in enumerate(groups, start=1):
        members = group["members"]
        # Weakest link, not the average: a group is only as trustworthy as
        # its least convincing pairing.
        confidence = min((c for c, _ in group["links"]), default=1.0) if len(members) > 1 else 1.0
        reasons = sorted({r for _, rs in group["links"] for r in rs})
        hypotheses.append({
            "hypothesis_id": index,
            "lat": sum(m["lat"] for m in members) / len(members),
            "lng": sum(m["lng"] for m in members) / len(members),
            "radio_count": len(members),
            # A lone BSSID is a trivially-certain "hypothesis" of one radio;
            # say so plainly rather than implying a mesh finding.
            "confidence": confidence,
            "is_multi_radio": len(members) > 1,
            "evidence": reasons,
            "ssids": sorted({m["ssid"] for m in members if m["ssid"]}),
            "bssids": sorted(m["bssid"] for m in members),
        })
    return sorted(hypotheses, key=lambda h: (-h["radio_count"], h["bssids"][0]))


def initial_bearing_deg(lat1, lng1, lat2, lng2):
    """Compass bearing (degrees clockwise from north) from point 1 to 2."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lng2 - lng1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return math.degrees(math.atan2(y, x)) % 360.0


def offset_position(lat, lng, bearing_deg, distance_m):
    """Destination point given a start, a bearing and a distance — the
    spherical formula, matching [haversine_m]'s model rather than a
    flat-plane approximation."""
    ang = distance_m / EARTH_RADIUS_M
    p1, l1 = math.radians(lat), math.radians(lng)
    brg = math.radians(bearing_deg)
    p2 = math.asin(math.sin(p1) * math.cos(ang) + math.cos(p1) * math.sin(ang) * math.cos(brg))
    l2 = l1 + math.atan2(
        math.sin(brg) * math.sin(ang) * math.cos(p1),
        math.cos(ang) - math.sin(p1) * math.sin(p2),
    )
    return math.degrees(p2), (math.degrees(l2) + 540) % 360 - 180


def suggest_next_positions(
    estimate_lat: float,
    estimate_lng: float,
    observer_positions: list[tuple],
    count: int = 3,
) -> list[dict]:
    """Where to measure from next, to shrink the position uncertainty — V6 of
    ap-localization-design.md.

    This is the doc's explicitly-sanctioned *initial* geometric heuristic, not
    an information-gain calculation (that's the "later implementation" it
    describes): readings clustered on one side of an AP constrain its
    position well along that bearing and badly across it, so the most
    valuable next measurement is in the widest unobserved angular gap as seen
    from the AP. Measuring from the bisector of the biggest gap is what
    breaks collinearity and adds an orthogonal baseline.

    Distance from the AP is the median of the existing observation distances
    — a radius already demonstrated to produce usable readings here, rather
    than an invented number.
    """
    if not observer_positions:
        return []

    bearings = sorted(initial_bearing_deg(estimate_lat, estimate_lng, lat, lng) for lat, lng in observer_positions)
    distances = sorted(haversine_m(estimate_lat, estimate_lng, lat, lng) for lat, lng in observer_positions)
    radius_m = distances[len(distances) // 2]

    # Angular gaps between consecutive bearings, including the wrap-around
    # from the last back to the first. A single observation degenerates to
    # one full-circle gap, which correctly suggests "go anywhere else".
    gaps = []
    if len(bearings) == 1:
        gaps.append((360.0, bearings[0]))
    else:
        for i, bearing in enumerate(bearings):
            nxt = bearings[(i + 1) % len(bearings)]
            size = (nxt - bearing) % 360.0
            gaps.append((size, bearing))

    gaps.sort(key=lambda g: g[0], reverse=True)
    suggestions = []
    for size, start_bearing in gaps[:count]:
        bearing = (start_bearing + size / 2) % 360.0
        lat, lng = offset_position(estimate_lat, estimate_lng, bearing, radius_m)
        suggestions.append({
            "lat": lat,
            "lng": lng,
            "bearing_deg": bearing,
            "distance_m": radius_m,
            "gap_deg": size,
            "rationale": (
                f"Widest unmeasured direction ({size:.0f} deg of open angle). "
                "Adds a baseline across the existing readings rather than along them."
            ),
        })
    return suggestions
