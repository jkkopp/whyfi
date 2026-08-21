"""Backfills meters_per_pixel/bearing_deg for plans calibrated before those
fields existed.

Calibration used to be derived from the two anchor pairs on every lookup.
Storing the transform instead (so the bearing can be nudged by hand) changed
`FloorPlan.is_calibrated` to read the stored values — which meant a plan
calibrated under the old scheme suddenly reported itself uncalibrated, with
its measurement placements stranded, until it was anchored again.

The anchors are still there, so nothing is lost: derive once and store.
"""

import math

from django.db import migrations

METERS_PER_DEGREE_LAT = 111320.0


def derive(plan):
    """Standalone copy of scans.floorplan.derive_scale_and_bearing.

    Deliberately not imported: a migration has to keep working against the
    schema as it was at this point in history, and application code is free to
    change (or delete) that helper later.
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

    m_per_lng = METERS_PER_DEGREE_LAT * max(math.cos(math.radians(plan.anchor1_lat)), 0.01)
    east = (plan.anchor2_lng - plan.anchor1_lng) * m_per_lng
    north = (plan.anchor2_lat - plan.anchor1_lat) * METERS_PER_DEGREE_LAT
    world_distance = math.hypot(east, north)
    if world_distance < 1e-9:
        return None

    rotation = math.atan2(north, east) - math.atan2(dy, dx)
    return world_distance / pixel_distance, (-math.degrees(rotation)) % 360


def backfill(apps, schema_editor):
    FloorPlan = apps.get_model("scans", "FloorPlan")
    for plan in FloorPlan.objects.filter(meters_per_pixel__isnull=True):
        derived = derive(plan)
        if derived is None:
            continue
        plan.meters_per_pixel, plan.bearing_deg = derived
        plan.save(update_fields=["meters_per_pixel", "bearing_deg"])


def noop(apps, schema_editor):
    """Reversing this would only re-strand the same plans; the columns
    themselves are removed by reversing 0016."""


class Migration(migrations.Migration):

    dependencies = [("scans", "0016_floorplan_bearing_deg_floorplan_meters_per_pixel")]

    operations = [migrations.RunPython(backfill, noop)]
