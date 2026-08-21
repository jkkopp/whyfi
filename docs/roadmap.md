# Roadmap

## v1 (this repo's current target)

- WiFi scanning (WifiManager) + visualization (dashboard, per-network signal
  history, channel congestion).
- Cellular serving/neighbor-cell info (TelephonyManager) — phone's own radio
  only, no SDR, no spectrum scanning.
- BLE device discovery — passive observation log with informational device
  type badges (e.g. "possible AirTag/Tile"). No alerting, no correlation, no
  "dismiss"/"mark as mine" workflow.
- GNSS satellite view (per-satellite Cn0/elevation/azimuth/used-in-fix) plus
  derived location (lat/lon, accuracy, provider).
- LAN device discovery (TCP-connect subnet sweep + common-port probe) — its
  own explicit "Scan LAN" action, not part of the regular radio pass.
- Geotagging + heatmap/map visualization across all of the above.
- Self-hosted Android build pipeline (Docker, no Android Studio/emulator) and
  self-hosted APK distribution + update-check via the backend's Download
  page.
- Scanning is always user-armed: either tapped on the phone, or remotely
  started from the PWA *after* the phone's owner has switched on Remote
  control in the app. Nothing scans unattended without that opt-in, and the
  foreground-service notification is visible the whole time.
- Zero offensive capability (the LAN scanner's TCP-connect probes are the
  one active exception — see `DISCLAIMER.md`).

## AP localization track (see `ap-localization-design.md`)

Locating physical access points from measurements taken at known positions,
rather than only mapping where signal was heard. Shipped:

- **V1-V2** — WiFi scanning, per-BSSID favouriting, scan sessions anchored to
  an observer position (these predate the design doc; it built on them).
- **V3** — Wi-Fi RTT/FTM ranging (`WifiRttManager`) against 802.11mc-responder
  APs, triggered per-BSSID from the app's scan detail screen, stored as
  `FtmRangingObservation` and uploaded through the normal offline outbox.
- **V4** — weighted least-squares multilateration solver
  (`backend/scans/localization.py`), no numpy/scipy dependency.
- **V5** — 95% confidence ellipse from the solve's covariance, plus an AP
  *position* probability surface. Distinct from the RSSI coverage heatmap
  below; the design doc is explicit that conflating the two is a mistake.
- **V6** — next-best-measurement suggestions (geometric heuristic: measure
  from the widest unobserved bearing). Information-gain/entropy-reduction is
  the intended later replacement.
- **V7** — RSSI coverage heatmap. Already existed as the Heatmap page.
- **V8** — probabilistic mesh/BSSID clustering into physical-AP hypotheses.
  Never asserts a verdict, and never merges on co-location alone.
- **V9** — printable localization report (PWA Localization page).

Layered on top of that track: the position estimator is **selectable**
(`centroid`, `strongest`, `rssi_multilateration`, `ftm_multilateration`), with
a global default in both the PWA Settings page and the Android app, applied to
every transceiver type. All four live in one place — `backend/scans/estimators.py`
— rather than being ported into TypeScript and Kotlin, so "compare estimators"
can never be comparing subtly different implementations. The Localization page
shows all four side by side with their disagreement and per-reading residuals;
Mission view shows the same comparison in the field.

Not done: **V10** (ESP32 CSI sensors) — needs real hardware and firmware to
develop against, and the design doc itself scopes CSI out of the first
implementation.

## Requested, not yet built

- ~~**Per-scan measurement points in the UI.**~~ **Shipped** as floor-plan
  surveying (`/floor-plans`): upload a plan, anchor it with two reference
  points, then click where each scan was taken. Placements are ordinary
  `OBSERVER` ground-truth pins, so they also correct the input to every
  estimator elsewhere in the app. Original note kept below for context.

- **(done) Per-scan measurement points in the UI.** Indoors GPS is unusable, so a
  survey needs the operator to place each measurement point by hand: pick a
  scan (the map's time/scan slider position), say "I was standing *here*", and
  have every estimate recomputed from the corrected position. The backend and
  data model already support this — `GroundTruthPosition` with
  `kind=OBSERVER` is keyed by scan session id and overrides that session's GPS
  fix for every estimator (`ground_truth_overrides` in `scans/views.py`) —
  but nothing in the PWA sends one yet, so the capability is currently
  unreachable. AP pins are deliberately the other shape: one per BSSID,
  applied across every measurement of that AP.

- **Export, delete, re-import as one safe workflow.** Export
  (`/scan-sessions/export/`) and bulk delete both exist, but aren't joined up:
  clearing out a survey while keeping the ability to restore it means
  exporting, verifying the file, then deleting, by hand and in the right
  order. Wanted as a guided flow filtered by SSID, date/time or location.
  Note a known bug to fix alongside it: export applies its `limit` slice
  *before* the area filter, so a location-filtered export silently searches
  only the newest N sessions rather than the whole area.

- **Walls and obstacles from floor plans** — designed, not built. See
  `docs/walls-obstacles-design.md`. Would replace the single path-loss
  exponent with a multi-wall model, enabling predicted (not just interpolated)
  coverage and a wall-aware estimator. Includes browser-side auto-detection of
  wall candidates from the plan image, since hand-drawing 20-40 segments is
  the thing most likely to make the feature go unused. Phased so each stage is
  independently useful, with an explicit stop condition: if the wall-aware
  estimator doesn't beat the existing four on pinned APs, the later stages
  aren't worth building.

## v-next (deferred, not forgotten)

- Matter/smart-home device discovery (BLE commissioning adverts + mDNS
  service records) — schema left open, not designed yet.
- Watch a *specific* WiFi/BLE/LAN device and alert when it comes online or
  goes offline. Remote scanning control (shipped) is a reasonable foundation
  — the backend already knows what each phone should be doing and hears from
  it regularly — but this needs its own watch-list model and a per-device
  notion of "seen recently".
- SDR/external-hardware sensor track (Kali Linux box, RTL-SDR/HackRF)
  contributing via the same sensor-agnostic ingest API — the actual path to
  monitor-mode WiFi capture and packet crafting, kept off the phone.
- Multi-user authentication / per-user data isolation.
- WebSocket/live-push updates (v1 is request/poll-based).
- Self-hosted offline map tiles for fully air-gapped deployments.
- Server-managed/updatable BLE signature reference list (v1 ships a static
  bundled asset).

## Explicitly not planned

- Anti-stalking tracker correlation/alerting — designed, then rejected
  outright by the maintainer. See `MEMORY.md`.
- Play Store distribution — this project is self-hosted-distribution-only by
  design.
- NFC tag reads — built, then removed entirely (no dedicated screen ever
  existed, it was tap-while-app-happens-to-be-open only, and the maintainer
  chose to cut it rather than give it a proper UI). See `MEMORY.md`.
