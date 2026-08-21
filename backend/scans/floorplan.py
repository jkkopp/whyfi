"""Mapping floor-plan pixels to real-world coordinates.

A home survey needs the operator to say precisely where they were standing,
and GPS can't do that indoors. So measurement points get placed on an uploaded
floor plan instead — which means turning a click at pixel (x, y) into a real
latitude/longitude, so the reading joins the same pipeline as everything else
rather than living in a private coordinate system.

The mapping is a similarity transform — uniform scale, rotation, translation,
no shear — which is exactly what a correctly-drawn plan needs. It's stored as
an origin (one anchor), a scale (metres per pixel) and a bearing (which way
the top of the plan points).

Two anchor pairs are how those are first *derived*: identify one recognisable
spot on the plan and the same spot in the world, twice. But the derived values
are then stored and used directly, so they stay adjustable — clicking two
points on a map at house scale is imprecise, and nudging a bearing by a couple
of degrees is far easier than re-clicking anchors until the rotation happens
to come out right.

The one genuinely error-prone part is that image *y* grows downward while
world *north* grows upward, so the y axis is flipped exactly once. Flipping it
zero times or twice produces a plan that's mirrored — which looks plausible
until every measurement lands in the wrong room.
"""

import math

from .localization import METERS_PER_DEGREE_LAT


def _meters_per_degree_lng(lat):
    return METERS_PER_DEGREE_LAT * max(math.cos(math.radians(lat)), 0.01)


def derive_scale_and_bearing(plan) -> dict | None:
    """Scale and bearing implied by a plan's two anchor pairs.

    Only used when calibrating; the results are stored on the plan and it's
    those stored values every later lookup reads (see [solve_transform]), so
    the operator can adjust them afterwards without the adjustment being
    silently overwritten by a re-derivation.

    Returns None for coincident anchors, which fix neither scale nor rotation.
    """
    required = (
        plan.anchor1_image_x, plan.anchor1_image_y, plan.anchor1_lat, plan.anchor1_lng,
        plan.anchor2_image_x, plan.anchor2_image_y, plan.anchor2_lat, plan.anchor2_lng,
    )
    if any(value is None for value in required):
        return None

    dx = plan.anchor2_image_x - plan.anchor1_image_x
    dy = -(plan.anchor2_image_y - plan.anchor1_image_y)
    pixel_distance = math.hypot(dx, dy)
    if pixel_distance < 1e-9:
        return None

    m_per_lng = _meters_per_degree_lng(plan.anchor1_lat)
    east = (plan.anchor2_lng - plan.anchor1_lng) * m_per_lng
    north = (plan.anchor2_lat - plan.anchor1_lat) * METERS_PER_DEGREE_LAT
    world_distance = math.hypot(east, north)
    if world_distance < 1e-9:
        return None

    # Rotation that takes the (y-up) pixel frame onto east/north...
    rotation = math.atan2(north, east) - math.atan2(dy, dx)
    # ...re-expressed as the compass bearing of the plan's "up" direction,
    # which is what a person can actually reason about and adjust. A plan
    # whose top points north is bearing 0. The sign flips because compass
    # bearings run clockwise from north while the rotation above is a
    # standard anticlockwise angle.
    bearing = (-math.degrees(rotation)) % 360
    return {
        "meters_per_pixel": world_distance / pixel_distance,
        "bearing_deg": bearing,
    }


def solve_transform(plan) -> dict | None:
    """The plan's stored transform, or None when it isn't calibrated."""
    required = (
        plan.anchor1_image_x, plan.anchor1_image_y, plan.anchor1_lat, plan.anchor1_lng,
        plan.meters_per_pixel, plan.bearing_deg,
    )
    if any(value is None for value in required):
        return None
    if plan.meters_per_pixel <= 0:
        return None

    return {
        "meters_per_pixel": plan.meters_per_pixel,
        # Inverse of the bearing convention in derive_scale_and_bearing.
        "rotation_rad": math.radians(-plan.bearing_deg),
        "meters_per_degree_lng": _meters_per_degree_lng(plan.anchor1_lat),
    }


def image_to_world(plan, image_x, image_y):
    """Pixel (x, y) on `plan` -> (lat, lng). None when uncalibrated."""
    transform = solve_transform(plan)
    if transform is None:
        return None

    vx = image_x - plan.anchor1_image_x
    vy = -(image_y - plan.anchor1_image_y)  # y-down -> y-up, exactly once

    cos_t = math.cos(transform["rotation_rad"])
    sin_t = math.sin(transform["rotation_rad"])
    scale = transform["meters_per_pixel"]
    east = scale * (vx * cos_t - vy * sin_t)
    north = scale * (vx * sin_t + vy * cos_t)

    lat = plan.anchor1_lat + north / METERS_PER_DEGREE_LAT
    lng = plan.anchor1_lng + east / transform["meters_per_degree_lng"]
    return lat, lng


def world_to_image(plan, lat, lng):
    """Inverse of [image_to_world] — (lat, lng) back to pixel (x, y).

    Used to place something that only has real-world coordinates (an estimated
    AP position, say) onto the plan, and by the round-trip test that keeps the
    forward transform honest.
    """
    transform = solve_transform(plan)
    if transform is None:
        return None

    east = (lng - plan.anchor1_lng) * transform["meters_per_degree_lng"]
    north = (lat - plan.anchor1_lat) * METERS_PER_DEGREE_LAT

    cos_t = math.cos(-transform["rotation_rad"])
    sin_t = math.sin(-transform["rotation_rad"])
    scale = transform["meters_per_pixel"]
    vx = (east * cos_t - north * sin_t) / scale
    vy = (east * sin_t + north * cos_t) / scale

    return plan.anchor1_image_x + vx, plan.anchor1_image_y - vy


# How far a measurement's influence reaches, as a fraction of the plan's
# diagonal. Beyond this a cell is left blank rather than coloured: an
# interpolated surface is a claim about places you *didn't* measure, and
# painting the whole plan from three readings in the hallway would invent
# coverage nobody ever observed.
IDW_MAX_INFLUENCE_FRACTION = 0.22
# Inverse-distance weighting exponent. 2 is the conventional choice: high
# enough that a nearby reading dominates a distant one, low enough that the
# surface doesn't collapse into flat plateaus around each sample.
IDW_POWER = 2.0


def interpolate_coverage(points, width_px, height_px, steps=40, outline=None):
    """Inverse-distance-weighted signal surface over a floor plan.

    `points`: [{"image_x", "image_y", "rssi"}] — the measured spots.
    `outline`: optional [(x, y)] pixel polygon of the building's footprint.

    Returns grid cells in *pixel* coordinates, each with an interpolated dBm
    and the distance to the nearest real measurement. Cells further than
    [IDW_MAX_INFLUENCE_FRACTION] of the plan diagonal from any measurement get
    `rssi: None`, so the caller draws nothing there.

    That blanking is the important part. Interpolation between measurements is
    a reasonable inference; extrapolation beyond them is fabrication, and a
    heatmap that fills the whole plan regardless of where you actually walked
    would be confidently wrong in exactly the rooms you most want to know
    about.

    The outline is the same principle applied to space rather than distance.
    A plan image is a rectangle, but the building inside it usually isn't:
    without clipping, an L-shaped house gets coverage painted across the
    corner it doesn't occupy — over the garden, or the neighbour's kitchen —
    purely because those pixels sit near a measurement. Cells outside the
    traced footprint are dropped entirely rather than returned as null, since
    unlike an out-of-influence cell there is no sense in which they are part
    of the surveyed area at all.
    """
    measured = [p for p in points if p.get("rssi") is not None]
    if not measured:
        return {"cells": [], "steps": 0, "max_influence_px": 0.0}

    steps = max(4, min(steps, 80))
    max_influence = math.hypot(width_px, height_px) * IDW_MAX_INFLUENCE_FRACTION

    cells = []
    for row in range(steps):
        for col in range(steps):
            x = (col + 0.5) * width_px / steps
            y = (row + 0.5) * height_px / steps

            if outline is not None and not point_in_outline(x, y, outline):
                continue

            nearest = None
            weighted_sum = 0.0
            weight_total = 0.0
            exact = None
            for point in measured:
                distance = math.hypot(x - point["image_x"], y - point["image_y"])
                nearest = distance if nearest is None else min(nearest, distance)
                if distance < 1e-6:
                    # Sitting exactly on a measurement: use it directly rather
                    # than dividing by zero.
                    exact = point["rssi"]
                    break
                weight = 1.0 / (distance ** IDW_POWER)
                weighted_sum += weight * point["rssi"]
                weight_total += weight

            if nearest is not None and nearest > max_influence:
                cells.append({"image_x": x, "image_y": y, "rssi": None, "distance_px": nearest})
                continue

            value = exact if exact is not None else (weighted_sum / weight_total if weight_total else None)
            cells.append({
                "image_x": x,
                "image_y": y,
                "rssi": None if value is None else round(value, 1),
                "distance_px": nearest,
            })

    return {"cells": cells, "steps": steps, "max_influence_px": max_influence}


MIN_OUTLINE_VERTICES = 3


def outline_pixels(plan):
    """The traced footprint as a list of (x, y) image pixels, or None.

    Anything under three vertices isn't an area, so it's treated as untraced
    rather than as a degenerate polygon — a half-finished trace must not
    silently start clipping the heatmap to a line.
    """
    raw = plan.outline_points or []
    points = []
    for point in raw:
        try:
            points.append((float(point["x"]), float(point["y"])))
        except (TypeError, KeyError, ValueError):
            return None
    return points if len(points) >= MIN_OUTLINE_VERTICES else None


def point_in_outline(x, y, outline):
    """Standard even-odd ray cast, in pixel space.

    Runs once per heatmap cell, so it stays dependency-free arithmetic rather
    than reaching for shapely — the same reasoning as everywhere else in this
    module. Points exactly on an edge may land either way; for deciding
    whether to paint a heatmap cell that ambiguity is not worth code to
    resolve.
    """
    inside = False
    count = len(outline)
    for i in range(count):
        x1, y1 = outline[i]
        x2, y2 = outline[(i + 1) % count]
        # Does the edge straddle the horizontal ray through y, and if so is
        # the crossing to the right of x?
        if (y1 > y) != (y2 > y):
            t = (y - y1) / (y2 - y1)
            if x < x1 + t * (x2 - x1):
                inside = not inside
    return inside


def plan_corners(plan):
    """The plan's footprint as real-world coordinates.

    The traced outline when there is one, otherwise the image's own four
    corners, clockwise from the top-left.

    Drawn on the map so the operator can see whether the plan's position,
    scale and rotation actually line up with the building — which is far
    easier to judge against a shape on a map than by reading a bearing in
    degrees. A bounding box is a poor thing to judge against on any building
    that isn't a plain rectangle, which is what the traced outline fixes.
    """
    if solve_transform(plan) is None:
        return None
    pixel_corners = outline_pixels(plan) or [
        (0, 0),
        (plan.image_width_px, 0),
        (plan.image_width_px, plan.image_height_px),
        (0, plan.image_height_px),
    ]
    corners = []
    for x, y in pixel_corners:
        lat, lng = image_to_world(plan, x, y)
        corners.append({"lat": lat, "lng": lng})
    return corners


def suggest_ap_placements(weak_points, existing_aps, plan, max_suggestions=3):
    """Where to move or add an access point to fix the measured weak spots.

    A deliberately simple, explainable heuristic rather than an optimiser:
    cluster the weak measurements, then propose a position at the centre of
    each cluster. The honest justification is that a weak area is weak because
    no radio is near enough to it, and the middle of that area is where a
    radio would help most of it at once.

    For each cluster it also names the nearest existing access point and how
    far away it is, so the operator can tell "move that one closer" apart from
    "you need another one here" — which is a judgement about furniture, power
    sockets and Ethernet runs that no algorithm here should be making.
    """
    weak = [p for p in weak_points if p.get("is_weak")]
    if not weak or plan.meters_per_pixel is None:
        return []

    # Greedy clustering in pixel space, at a radius scaled to the plan so the
    # grouping means the same thing on a studio flat and a large house.
    radius_px = math.hypot(plan.image_width_px, plan.image_height_px) * 0.18
    remaining = list(weak)
    clusters = []
    while remaining and len(clusters) < max_suggestions:
        seed = remaining[0]
        members = [
            p for p in remaining
            if math.hypot(p["image_x"] - seed["image_x"], p["image_y"] - seed["image_y"]) <= radius_px
        ]
        clusters.append(members)
        remaining = [p for p in remaining if p not in members]

    suggestions = []
    for index, members in enumerate(clusters, start=1):
        cx = sum(p["image_x"] for p in members) / len(members)
        cy = sum(p["image_y"] for p in members) / len(members)

        nearest_ap, nearest_px = None, None
        for ap in existing_aps:
            distance = math.hypot(cx - ap["image_x"], cy - ap["image_y"])
            if nearest_px is None or distance < nearest_px:
                nearest_ap, nearest_px = ap, distance

        nearest_m = None if nearest_px is None else nearest_px * plan.meters_per_pixel
        worst = min((p["rssi"] for p in members if p.get("rssi") is not None), default=None)
        dead = sum(1 for p in members if p.get("no_coverage"))

        if nearest_m is None:
            action = "add"
            rationale = "No access point placed yet, so there's nothing to move — put one here."
        elif nearest_m > 12:
            action = "add"
            rationale = (
                f"Nearest access point is {nearest_m:.0f} m away. That's far enough that moving it would likely "
                "just trade this weak area for a new one — an extra node here is the safer fix."
            )
        else:
            action = "move"
            rationale = (
                f"Nearest access point ({nearest_ap['bssid']}) is only {nearest_m:.0f} m away, so moving it "
                "toward this area should cover it without opening a gap elsewhere."
            )

        suggestions.append({
            "rank": index,
            "action": action,
            "image_x": cx,
            "image_y": cy,
            "weak_point_count": len(members),
            "dead_point_count": dead,
            "worst_rssi": worst,
            "nearest_ap_bssid": None if nearest_ap is None else nearest_ap["bssid"],
            "nearest_ap_distance_m": nearest_m,
            "rationale": rationale,
        })

    suggestions.sort(key=lambda s: (-s["weak_point_count"], s["worst_rssi"] if s["worst_rssi"] is not None else 0))
    for rank, suggestion in enumerate(suggestions, start=1):
        suggestion["rank"] = rank
    return suggestions
