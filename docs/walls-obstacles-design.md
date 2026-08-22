# Walls and obstacles from floor plans

## Context

Everything built so far treats the home as empty space: `RANGE_MODEL` in
`scans/estimators.py` is a single path-loss exponent, which says signal decays
the same way in every direction. Indoors that's the dominant error — a wall
between you and the router costs more than several metres of open air, which
is exactly why the fitted calibration against real data came out at R² 0.027.
The model isn't slightly off; it's missing the main variable.

Modelling walls fixes three things at once:

1. **Position estimates** stop being fooled by attenuation that looks like
   distance.
2. **Coverage prediction** becomes possible in rooms never walked through —
   honestly, from physics, rather than by extrapolating measurements.
3. **AP placement advice** (currently "the middle of the weak cluster") can
   account for what's actually blocking the signal.

## The architectural consequence, up front

**Walls break the current estimator pipeline, and that's the main thing this
work has to confront.** `rssi_multilateration` works by converting each
reading's RSSI to a distance (`path_loss_distance_m`) and then solving. With
walls, RSSI can't be inverted to a distance at all — the attenuation depends
on which walls lie between transmitter and receiver, which depends on where
the transmitter is, which is the unknown being solved for.

The fix is to stop inverting and start **predicting**: for each candidate
position, predict the RSSI at every measurement point (path loss + the walls
that candidate's signal would cross) and score how well those predictions
match what was measured. That's a likelihood surface, and the codebase already
has that shape in `localization.position_probability_grid` — this reuses its
structure rather than inventing a new one.

So: a new `wall_aware` estimator alongside the existing four, not a
modification of them. The current estimators keep working untouched and stay
comparable against it on the scoreboard, which is the only way to find out
whether wall modelling actually helps *here*.

## Data model

**`FloorPlanObstacle`** — `floor_plan` FK, `kind` (choices below), `points`
(JSON list of `{image_x, image_y}`, a polyline so one wall can bend),
`attenuation_db_override` (nullable), `label`.

Material presets with typical 2.4 GHz attenuation, kept as a module constant
next to `RANGE_MODEL` so the two calibratable models sit together:

| kind | dB | notes |
|---|---|---|
| `DRYWALL` | 3 | interior stud wall |
| `WOOD` | 4 | doors, thin partitions |
| `GLASS` | 2 | windows, internal glazing |
| `BRICK` | 8 | typical interior masonry |
| `CONCRETE` | 12 | structural, floors |
| `METAL` | 20 | appliances, mirrors, foil-backed insulation |

Per-band values differ (5 GHz attenuates more than 2.4), so the table is keyed
by band as well — using one set for both would systematically overestimate
2.4 GHz coverage, which is the band people actually rely on at range.

## Backend

**New `backend/scans/obstacles.py`**
- `segments_crossed(x1, y1, x2, y2, obstacles) -> list[hit]` — straight-line
  ray from transmitter to receiver in *pixel* space, standard segment-segment
  intersection. Pure Python, no dependency, same posture as everything else
  here.
- `wall_attenuation_db(hits, band) -> float` — sum of per-material costs.
- `predict_rssi(tx_xy, rx_xy, plan, obstacles, band, model) -> float` —
  path loss over the real distance (via `plan.meters_per_pixel`) plus wall
  attenuation.

**`scans/estimators.py`** — a fifth estimator, `WALL_AWARE`, available only
when the device has a floor plan with obstacles. It grid-searches candidate
positions over the plan, scoring each by summed squared error between
predicted and measured RSSI, and returns the best plus a likelihood surface.
Reports itself unavailable (falling back to centroid, as the others do) when
there's no plan or no walls drawn — never silently degrading to the
wall-free model under the wall-aware name.

**Calibration** — extend `scans/calibration.py` to fit per-material
attenuation alongside the path-loss constants, from pinned AP positions plus
drawn walls: each reading gives a measured RSSI, a known distance and a known
set of crossed materials, so the material costs are another linear
least-squares fit (one column per material). Needs meaningfully more ground
truth than the current fit; report sample counts per material and decline
anything under-determined rather than producing a confident-looking number
from two readings.

**Predicted coverage** — `GET /floor-plans/{id}/predicted-coverage/`: for each
placed AP, predict RSSI across the grid, take the best per cell. This is what
finally fills the blank areas the IDW heatmap deliberately leaves empty — and
it must be returned as a *separate layer*, never merged into the measured
one.

## Auto-detecting walls from the plan image

Drawing 20–40 wall segments by hand is the thing most likely to kill this
feature, so the plan is to **generate candidate walls automatically and let
you correct them** — never to require hand-drawing from scratch.

**Where it runs: the browser.** OpenCV is the obvious tool and is out — it's a
large dependency and this backend deliberately has no numpy, scipy or even
Pillow; a Hough transform in pure Python over a multi-megapixel image would
take minutes. But the plan image is already loaded in a `<canvas>` on the
floor-plan page, `getImageData` gives free pixel access, and the detection
below is fast in JS. Zero new dependencies on either side.

**How it works** (`frontend/src/floorplanWalls.ts`, new):
1. Downscale to ~1200 px on the long edge and binarize — walls are the dark,
   solid ink on a light background.
2. Find horizontal runs of dark pixels longer than a minimum length, and the
   same down columns. Home plans are overwhelmingly axis-aligned, so
   run-length detection catches most walls without a general line detector.
3. Merge adjacent parallel runs into single segments, and record each run's
   **thickness**.
4. Emit candidate polylines in image-pixel coordinates — exactly the shape
   `FloorPlanObstacle.points` already expects.

**Thickness picks the default material.** Architectural plans conventionally
draw structural walls thicker than partitions, so thick runs default to
`BRICK`/`CONCRETE` and thin ones to `DRYWALL`. A default, not a claim — every
candidate stays editable.

**What it will get wrong**, and must say so in the UI rather than quietly
producing a wrong model:
- Scanned or hand-drawn plans (uneven ink, skew) — poor results.
- Furniture symbols, hatching, dimension lines and text — false positives.
- Doors and windows — read as gaps in a wall, or missed entirely.
- Diagonal and curved walls — missed by run-length detection; drawn by hand.

So the flow is **detect → review → correct**, with every candidate selectable,
re-materialable and deletable, and a plain "these were guessed from the image"
label. Diagonals are why manual drawing has to exist anyway; auto-detection
just means you start from 80% rather than nothing on a clean plan.

If run-length detection proves too weak on real plans, the fallback is a
proper Hough transform in JS — more code, still no dependency — but it's worth
trying the simple thing first against an actual plan of yours.

## Frontend

- **Wall drawing** on the floor plan: click to start, click to add vertices,
  double-click to finish; pick a material; drag vertices to adjust. Reuses the
  existing pixel-space click mapping (`clickToImagePixels`) and the overlay
  pattern already used for pins.
- **A wall layer** on the plan, colour-coded by material.
- **Predicted vs measured** as separate, clearly-labelled toggles. Predicted
  coverage is rendered visibly differently (hatched, or lower opacity with a
  legend entry saying "modelled, not measured"). A model-derived surface that
  looks identical to measured data is the single biggest way this feature
  could mislead — you'd trust a prediction about a room you never entered as
  though you'd stood in it.
- **Wall-aware estimator** appears in the existing estimator dropdown and
  scoreboard, so it can be compared against the other four on real pins rather
  than assumed better.

## Phasing

Worth building in this order, since each stage is independently useful and the
later ones are only worth doing if the earlier ones pay off:

1. **Auto-detect + edit walls**, ray casting, and wall-aware **coverage
   prediction**. Immediately useful for "where should the AP go", and needs no
   estimator changes. Auto-detection lands here rather than later precisely
   because it decides whether the feature is usable at all.
2. The `wall_aware` **estimator** + scoreboard comparison. Tells you whether
   the wall model actually improves position estimates in your home.
3. **Per-material calibration**, only if stage 2 shows the model is close
   enough to be worth tuning.

## Risks worth stating plainly

- **Wall entry is the make-or-break UX.** A house is 20–40 segments; if that
  has to be done by hand the feature won't get used, and no amount of model
  quality saves it. Auto-detection is the mitigation, but it only works well
  on clean vector-style plans — worth testing against your actual plan early,
  because if detection is poor on it the honest answer may be that this
  feature isn't worth building.
- **Textbook attenuation values are rough.** Real walls have pipes, wiring and
  insulation. Stage 3 exists precisely because the presets are a starting
  point, not an answer.
- **Straight-line ray casting ignores reflection and diffraction**, which
  indoors are not negligible — signal goes around corners and through
  doorways. The model will be systematically pessimistic behind thick walls.
  It's still far better than assuming empty space, but it is a model, and the
  scoreboard is what keeps that honest.

## Verification

- Detection is tested against a synthetic plan image generated in the test
  (a known rectangle of rooms), asserting the expected segment count and
  thickness classification — a real plan can't be an assertion, but a
  generated one can.
- `manage.py test scans`: ray casting (a ray crossing two walls counts two; a
  ray parallel to a wall counts none; a ray ending exactly on a wall doesn't
  double-count), attenuation summing per band, `predict_rssi` against
  hand-computed values, and the wall-aware estimator reporting itself
  unavailable with no walls drawn.
- Against real data: draw the walls of one floor, then check on the scoreboard
  whether `wall_aware` beats the existing four on pinned APs. That comparison
  is the actual acceptance test — if it doesn't win, the model isn't earning
  its complexity and stages 2–3 should stop.
- Confirm predicted coverage is visually distinguishable from measured at a
  glance, including in print.
