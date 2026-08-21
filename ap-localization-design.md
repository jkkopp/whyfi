# AP Localization Design

## Goal

Develop an Android-based measurement system for detecting, distinguishing,
localizing and documenting Wi-Fi access points, especially multiple APs of
mesh systems.

The AP positions are NOT known beforehand.

The observer performs measurements from multiple known measurement positions.
The AP position is inferred from those observations.

## Workflow

1. Detect Wi-Fi SSIDs.
2. Show all BSSIDs belonging to an SSID.
3. Allow selected BSSIDs to be marked as measurement targets/favorites.
4. Perform systematic measurements from multiple known observer positions.
5. Estimate AP positions.
6. Estimate uncertainty of each AP position.
7. Suggest additional measurement positions that maximize information gain.
8. Detect additional interesting APs/BSSIDs in similar direction or distance.
9. Attempt to group BSSIDs that may belong to the same physical mesh node.
10. Generate:
    - AP position probability heatmap
    - signal coverage heatmap
    - measurement protocol/report

## Measurements

For every measurement point store at least:

- timestamp
- observer x/y/z position
- optional geographic coordinates
- SSID
- BSSID
- frequency
- channel
- band
- RSSI
- Wi-Fi capabilities
- FTM/RTT support
- FTM distance if available
- FTM distance standard deviation / quality
- successful/failed ranging attempts

Take multiple samples per measurement point.

Do not treat a single RSSI or FTM result as authoritative.

## FTM / Wi-Fi RTT

Where supported, Android WifiRttManager should be used to measure distance
from the Android device to an FTM responder AP.

The AP position is unknown.

Known observer positions:

P_i = (x_i, y_i)

Measured AP distances:

d_i

Estimate the unknown AP position:

AP = (x, y)

by minimizing weighted ranging error:

argmin(x,y) Σ w_i * (distance(P_i, AP) - d_i)^2

Use measurement uncertainty to derive weights.

Do not rely on literal geometric circle intersections because real measurements
contain noise and multipath errors.

## Position Probability

In addition to the best-fit AP position, calculate a likelihood/probability
surface over the measurement area.

For each candidate position calculate how well all FTM observations agree with
that candidate.

Output:

- estimated AP position
- confidence / uncertainty
- confidence ellipse if useful
- probability heatmap

## Next Best Measurement

After an initial position estimate, the application should recommend additional
measurement locations.

The objective is to reduce position uncertainty.

Initial implementation may use geometric heuristics:
- avoid collinear measurement positions
- prefer positions orthogonal to previous baselines
- increase geometric diversity around the estimated AP

Later implementation should use information gain / expected entropy reduction.

## RSSI

RSSI should NOT primarily be converted directly into distance.

Use RSSI for:

- supporting AP discrimination
- coverage mapping
- relative signal comparison
- identifying spatial trends
- additional probabilistic evidence

FTM primarily estimates geometry.

RSSI primarily describes observed coverage.

## Mesh / BSSID Handling

Do not assume:

BSSID == physical access point.

Maintain separate concepts:

SSID
BSSID / radio identity
physical AP hypothesis
mesh system

Potential features for grouping BSSIDs:

- same SSID
- estimated physical position
- OUI/vendor
- supported bands
- channels
- capabilities
- RSN/security parameters
- beacon characteristics
- FTM capability
- RSSI spatial pattern
- temporal correlation

The result should be probabilistic, not a hard assumption.

Example:

BSSID A -> AP hypothesis 1
BSSID B -> AP hypothesis 1
BSSID C -> AP hypothesis 2

## Heatmaps

Implement two distinct heatmaps.

### AP Position Probability Heatmap

Answers:

"Where is this AP most likely physically located?"

Derived primarily from FTM measurements and their uncertainty.

### Coverage Heatmap

Answers:

"How does the AP signal propagate through the measured area?"

Derived primarily from RSSI observations/interpolation.

Do not confuse these two concepts.

## Data Model

Recommended conceptual model:

MeasurementSession
  -> MeasurementPoint
      -> Observation
          -> BSSID / RadioIdentity

BSSID / RadioIdentity
  -> PhysicalApHypothesis

PhysicalApHypothesis
  -> SSID / MeshSystem

Observation should be immutable raw measurement data.

Derived estimates should be stored separately so algorithms can later be
re-run against the original measurements.

## Future Extensions

Architecture should allow later addition of:

- ESP32 CSI sensors
- CSI feature extraction
- AoA / direction finding
- multiple fixed sensors
- Bluetooth observations
- Wi-Fi/BLE device correlation
- Kalman/particle filtering
- PostgreSQL/PostGIS backend
- FastAPI backend
- probabilistic device/AP identity models

CSI is NOT required for the first implementation.

## Development Priority

V1:
Wi-Fi scanning + SSID/BSSID selection

V2:
measurement sessions + known measurement points

V3:
Android Wi-Fi RTT / FTM measurements

V4:
AP multilateration solver

V5:
uncertainty + AP position probability heatmap

V6:
next-best-measurement recommendation

V7:
RSSI coverage heatmap

V8:
mesh/BSSID clustering

V9:
measurement protocol/report

V10:
ESP32 CSI integration