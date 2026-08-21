import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { CalibrationPanel } from "../components/CalibrationPanel";
import { PrintReportButton } from "../components/PrintReportButton";
import { RadioMap } from "../components/RadioMap";
import type { CoveragePolygon, MapPoint } from "../components/RadioMap";
import { ReportHeader } from "../components/ReportHeader";
import type { ReportField } from "../components/ReportHeader";
import { useFilter } from "../context/FilterContext";
import {
  ESTIMATOR_DESCRIPTIONS,
  ESTIMATOR_LABELS,
  POSITION_ESTIMATORS,
  getEstimatorPreference,
  type PositionEstimator,
} from "../estimatorPreference";
import { useReportPrinting, useReportViewSettings } from "../hooks/useDeviceReport";
import { usePolling } from "../hooks/usePolling";
import { formatCoords, osmLink } from "../reportLinks";
import type { GroundTruthPosition, MeshHypothesis, ProbabilityGrid } from "../api/types";

// 25x25 = 625 cells: enough to read a shape at building scale without making
// the response or the map layer heavy.
const GRID_STEPS = 25;
const GRID_SPAN_M = 120;

const ESTIMATE_COLOR = "#c084fc";
const HYPOTHESIS_COLOR = "#f472b6";
const TRUTH_COLOR = "#22c55e";

/** A small ring around a point, for marking an estimate on the map. Flat-plane
 * approximation, which is fine at these radii. */
function ring(lat: number, lng: number, radiusM: number, segments = 40): { lat: number; lng: number }[] {
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
  return Array.from({ length: segments }, (_, i) => {
    const t = (2 * Math.PI * i) / segments;
    return { lat: lat + (radiusM * Math.sin(t)) / mPerDegLat, lng: lng + (radiusM * Math.cos(t)) / mPerDegLng };
  });
}

/** The probability surface as map points. Already peak-normalized by the
 * backend, so the map doesn't rescale it against the rest of the batch. */
function gridPoints(grid: ProbabilityGrid): MapPoint[] {
  return grid.cells
    // Near-zero cells are most of the grid and add nothing but layer count.
    .filter((cell) => cell.relative_likelihood > 0.01)
    .map((cell) => ({
      lat: cell.lat,
      lng: cell.lng,
      weight: cell.relative_likelihood,
      normalizedWeight: cell.relative_likelihood,
    }));
}

export function LocalizationPage() {
  const filter = useFilter();
  const [searchParams, setSearchParams] = useSearchParams();
  const ssid = searchParams.get("ssid") ?? "";
  const focusBssid = searchParams.get("bssid") ?? "";
  const [showGrid, setShowGrid] = useState(true);
  // Seeded from the global setting but overridable here — comparing
  // estimators is this page's whole purpose, so having to change a global
  // preference to look at one would be backwards.
  const [estimator, setEstimator] = useState<PositionEstimator>(getEstimatorPreference());
  // "Click the map to say where this AP really is." Armed explicitly, and
  // one-shot, so an ordinary map click can't move a survey pin by accident.
  const [pinning, setPinning] = useState(false);
  const [useGroundTruth, setUseGroundTruth] = useState(true);
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinVersion, setPinVersion] = useState(0);
  const { printing, onMapReady, printButtonProps } = useReportPrinting();

  const windowOpts = {
    since: filter.since,
    until: filter.until,
    sessionLimit: filter.sessionLimit,
    estimator,
    ...(useGroundTruth ? {} : { use_ground_truth: "0" }),
  };

  // One request covers every BSSID under this SSID, each already carrying its
  // estimated position — a mesh network is several BSSIDs, and asking
  // per-BSSID would be a round trip each.
  const coverage = usePolling(
    () => (ssid ? api.accessPointsCoverage({ ...windowOpts, ssidExact: ssid }) : Promise.resolve(null)),
    20000,
    [ssid, filter.since, filter.until, filter.sessionLimit, estimator, useGroundTruth],
    { paused: printing },
  );

  const devices = useMemo(() => coverage.data?.results ?? [], [coverage.data]);

  // Default the detail panels to the BSSID with the most readings — the one
  // most likely to have a usable estimate.
  const selectedBssid = useMemo(() => {
    if (focusBssid && devices.some((d) => d.bssid === focusBssid)) return focusBssid;
    return [...devices].sort((a, b) => b.points.length - a.points.length)[0]?.bssid ?? "";
  }, [devices, focusBssid]);

  const detail = usePolling(
    () =>
      selectedBssid
        ? api.accessPointPositionGrid(selectedBssid, { ...windowOpts, gridSteps: GRID_STEPS, gridSpanM: GRID_SPAN_M })
        : Promise.resolve(null),
    20000,
    [selectedBssid, filter.since, filter.until, filter.sessionLimit, estimator, useGroundTruth],
    { paused: printing },
  );

  const comparison = usePolling(
    () => (selectedBssid ? api.accessPointPositionComparison(selectedBssid, windowOpts) : Promise.resolve(null)),
    20000,
    [selectedBssid, filter.since, filter.until, filter.sessionLimit, useGroundTruth],
    { paused: printing },
  );

  const mesh = usePolling(
    () => api.meshGroups({ ...windowOpts, ssidExact: ssid || undefined }),
    30000,
    [ssid, filter.since, filter.until, filter.sessionLimit],
    { paused: printing },
  );

  // Distinct SSIDs for the picker.
  const ssidList = usePolling(() => api.accessPoints("?limit=500"), 60000, [], { paused: printing });
  const ssidOptions = useMemo(() => {
    const seen = new Set<string>();
    (ssidList.data?.results ?? []).forEach((ap) => {
      if (ap.ssid) seen.add(ap.ssid);
    });
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [ssidList.data]);

  const truthPins = usePolling(
    () => api.groundTruth("?kind=AP&limit=500"),
    60000,
    [pinVersion],
    { paused: printing },
  );
  const pinByBssid = useMemo(() => {
    const map = new Map<string, GroundTruthPosition>();
    (truthPins.data?.results ?? []).forEach((pin) => map.set(pin.target_key, pin));
    return map;
  }, [truthPins.data]);

  const meshGroups: MeshHypothesis[] = mesh.data?.results ?? [];
  const multiRadioGroups = meshGroups.filter((g) => g.is_multi_radio);

  // Clear a stale ?bssid= that doesn't belong to the selected SSID, so the
  // focus dropdown can't point at a network that isn't on screen.
  useEffect(() => {
    if (focusBssid && ssid && devices.length > 0 && !devices.some((d) => d.bssid === focusBssid)) {
      setSearchParams({ ssid });
    }
  }, [ssid, devices, focusBssid, setSearchParams]);

  const { points, polygons } = useMemo(() => {
    const pts: MapPoint[] = [];
    const polys: CoveragePolygon[] = [];

    // Probability surface for the focused BSSID, when the chosen estimator
    // models distance at all.
    if (showGrid && detail.data?.probability_grid) pts.push(...gridPoints(detail.data.probability_grid));

    // Every BSSID of this SSID, at its estimated position.
    devices.forEach((device) => {
      const est = device.estimated_position;
      if (!est) return;
      const isFocused = device.bssid === selectedBssid;
      polys.push({
        points: ring(est.lat, est.lng, isFocused ? 12 : 8),
        color: ESTIMATE_COLOR,
        label: `${device.bssid}${isFocused ? " (focused)" : ""} — ${ESTIMATOR_LABELS[estimator]}`,
        detailPath: device.detail_path,
        gradientCenter: { lat: est.lat, lng: est.lng },
        centerIconType: "wifi",
      });
    });

    // Physical-AP hypotheses: one ring per group of BSSIDs believed to be
    // radios of the same box.
    multiRadioGroups.forEach((group) => {
      polys.push({
        points: ring(group.lat, group.lng, 25, 56),
        color: HYPOTHESIS_COLOR,
        label:
          `AP hypothesis #${group.hypothesis_id}: ${group.radio_count} radios, ` +
          `${(group.confidence * 100).toFixed(0)}% confidence — ${group.evidence.join("; ")}`,
      });
    });

    // Surveyed true positions, drawn distinctly from estimates — this is the
    // thing everything else is measured against.
    devices.forEach((device) => {
      const pin = pinByBssid.get(device.bssid);
      if (!pin) return;
      polys.push({
        points: ring(pin.latitude, pin.longitude, 10, 4),
        color: TRUTH_COLOR,
        label: `Surveyed position of ${device.bssid}${pin.label ? ` (${pin.label})` : ""}`,
      });
    });

    return { points: pts, polygons: polys };
  }, [devices, selectedBssid, multiRadioGroups, detail.data, showGrid, estimator, pinByBssid]);

  async function handleMapClick(lat: number, lng: number) {
    if (!selectedBssid) return;
    setPinning(false);
    setPinError(null);
    try {
      await api.saveGroundTruth({ kind: "AP", target_key: selectedBssid, latitude: lat, longitude: lng });
      setPinVersion((v) => v + 1);
    } catch {
      setPinError("Could not save that pin.");
    }
  }

  async function clearPin() {
    const pin = pinByBssid.get(selectedBssid);
    if (!pin) return;
    await api.deleteGroundTruth(pin.id).catch(() => setPinError("Could not remove that pin."));
    setPinVersion((v) => v + 1);
  }

  const estimate = detail.data;
  const summary: ReportField[] = [
    { label: "SSID", value: ssid || "None selected" },
    { label: "BSSIDs under this SSID", value: devices.length },
    { label: "Estimator", value: ESTIMATOR_LABELS[estimator] },
    {
      label: "Estimated position",
      value: estimate?.lat != null && estimate?.lng != null ? formatCoords(estimate.lat, estimate.lng) : "—",
    },
    { label: "Readings used", value: estimate?.sample_count ?? 0 },
    { label: "Discarded outliers", value: estimate?.discarded_outliers ?? 0 },
    { label: "Multi-radio AP hypotheses", value: multiRadioGroups.length },
  ];

  const viewSettings = useReportViewSettings(null);

  return (
    <section>
      <ReportHeader title="AP localization report" summary={summary} viewSettings={viewSettings} />

      <div className="page-title-row print-hide">
        <h1>AP Localization</h1>
        <PrintReportButton {...printButtonProps} />
      </div>

      <p className="page-hint print-hide">
        Estimates where a network physically is, from readings taken at known positions. Pick a network by name — a
        mesh shows up as several BSSIDs, all mapped together.
      </p>

      <div className="control-row print-hide">
        <label>
          Network (SSID){" "}
          <select value={ssid} onChange={(e) => setSearchParams(e.target.value ? { ssid: e.target.value } : {})}>
            <option value="">Select a network…</option>
            {ssidOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Estimator{" "}
          <select value={estimator} onChange={(e) => setEstimator(e.target.value as PositionEstimator)}>
            {POSITION_ESTIMATORS.map((option) => (
              <option key={option} value={option}>
                {ESTIMATOR_LABELS[option]}
              </option>
            ))}
          </select>
        </label>
        {devices.length > 1 && (
          <label>
            Focus BSSID{" "}
            <select value={selectedBssid} onChange={(e) => setSearchParams({ ssid, bssid: e.target.value })}>
              {devices.map((d) => (
                <option key={d.bssid} value={d.bssid}>
                  {d.bssid} ({d.points.length} readings)
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          <input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} /> Probability
          heatmap
        </label>
        <label>
          <input
            type="checkbox"
            checked={useGroundTruth}
            onChange={(e) => setUseGroundTruth(e.target.checked)}
          />{" "}
          Use pinned observer positions
        </label>
      </div>

      {ssid && selectedBssid && (
        <div className="control-row print-hide">
          <button onClick={() => setPinning((p) => !p)} disabled={!selectedBssid}>
            {pinning ? "Click the map…" : `Pin true position of ${selectedBssid}`}
          </button>
          {pinByBssid.has(selectedBssid) && <button onClick={clearPin}>Remove pin</button>}
          {pinError && <span className="error-text">{pinError}</span>}
        </div>
      )}

      <p className="page-hint print-hide">{ESTIMATOR_DESCRIPTIONS[estimator]}</p>

      {!ssid && <p className="empty-state">Pick a network above to see where it is.</p>}

      {ssid && devices.length === 0 && !coverage.loading && (
        <p className="empty-state">No geotagged readings for this network in the selected range.</p>
      )}

      {ssid && devices.length > 0 && (
        <>
                    <RadioMap
            points={points}
            polygons={polygons}
            onReady={onMapReady}
            onMapClick={pinning ? handleMapClick : null}
          />

          {showGrid && !detail.data?.probability_grid && (
            <p className="page-hint">
              No probability heatmap for {ESTIMATOR_LABELS[estimator]} — a likelihood surface needs a distance model,
              which only the two multilateration estimators have. Switch to one of those to see it.
            </p>
          )}

          {(estimate?.discarded_outliers ?? 0) > 0 && (
            <p className="warning-text">
              Ignored {estimate?.discarded_outliers} reading(s) recorded far from the rest. The same identifier
              appearing in widely separated places is two different transmitters, not one that moved — averaging them
              produces a position that's nowhere near either.
            </p>
          )}

          <section>
            <h2>Position estimate — {ESTIMATOR_LABELS[estimator]}</h2>
            {estimate && !estimate.available && <p className="warning-text">{estimate.reason}</p>}
            <dl className="detail-list">
              <div>
                <dt>Estimated position</dt>
                <dd>
                  {estimate?.lat != null && estimate?.lng != null ? (
                    <a href={osmLink(estimate.lat, estimate.lng)} target="_blank" rel="noreferrer">
                      {formatCoords(estimate.lat, estimate.lng)}
                    </a>
                  ) : (
                    "—"
                  )}
                </dd>
              </div>
              <div>
                <dt>Readings used</dt>
                <dd>{estimate?.sample_count ?? 0}</dd>
              </div>
              {estimate?.rms_residual_m != null && (
                <div>
                  <dt>Fit residual (RMS)</dt>
                  <dd>{estimate.rms_residual_m.toFixed(2)} m</dd>
                </div>
              )}
            </dl>
          </section>

          {comparison.data && (
            <section>
              <h2>Estimator comparison — {selectedBssid}</h2>
              <p className="page-hint">
                The same readings solved four ways. Close agreement means the position is well determined; a wide
                spread means at least one algorithm is being misled, and the per-reading table below usually shows
                which measurement is responsible.
                {!pinByBssid.has(selectedBssid) &&
                  " Pin this AP's real position above to turn the comparison into an actual error in metres."}
              </p>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Algorithm</th>
                    <th>Status</th>
                    <th>Estimated position</th>
                    <th>Readings</th>
                    <th>Fit residual (RMS)</th>
                    <th>Error vs pin</th>
                  </tr>
                </thead>
                <tbody>
                  {POSITION_ESTIMATORS.map((name) => {
                    const est = comparison.data?.estimates[name];
                    if (!est) return null;
                    return (
                      <tr key={name}>
                        <td>{ESTIMATOR_LABELS[name]}</td>
                        <td>
                          {est.available ? "ran" : <span title={est.reason}>unavailable → {est.fell_back_to}</span>}
                        </td>
                        <td>
                          {est.lat != null && est.lng != null ? (
                            <a href={osmLink(est.lat, est.lng)} target="_blank" rel="noreferrer">
                              {formatCoords(est.lat, est.lng)}
                            </a>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td>{est.sample_count}</td>
                        <td>{est.rms_residual_m != null ? `${est.rms_residual_m.toFixed(2)} m` : "—"}</td>
                        <td>
                          {est.error_m != null ? `${est.error_m.toFixed(1)} m` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {(comparison.data?.disagreements ?? []).length > 0 && (
                <>
                  <h3>How far apart they land</h3>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Pair</th>
                        <th>Disagreement</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(comparison.data?.disagreements ?? []).map((d) => (
                        <tr key={`${d.a}-${d.b}`}>
                          <td>
                            {ESTIMATOR_LABELS[d.a as PositionEstimator] ?? d.a} vs{" "}
                            {ESTIMATOR_LABELS[d.b as PositionEstimator] ?? d.b}
                          </td>
                          <td>{d.distance_m.toFixed(1)} m</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </section>
          )}

          {(comparison.data?.estimates[estimator]?.residuals?.length ?? 0) > 0 && (
            <section>
              <h2>Per-reading quality — {ESTIMATOR_LABELS[estimator]}</h2>
              <p className="page-hint">
                Worst-disagreeing reading first. For the multilateration estimators the residual is predicted range
                minus measured range, so a large value means that reading disagrees with the rest — usually multipath,
                a reflection, or a bad GPS fix where you were standing. The centroid and strongest-reading estimators
                have no distance model, so they can only report how far each reading sat from the estimate.
              </p>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Observed</th>
                    <th>Observer position</th>
                    <th>Signal / weight</th>
                    <th>Measured distance</th>
                    <th>Distance to estimate</th>
                    <th>Residual</th>
                  </tr>
                </thead>
                <tbody>
                  {(comparison.data?.estimates[estimator]?.residuals ?? []).slice(0, 100).map((r, i) => (
                    <tr key={`${r.scan_session_id ?? i}-${i}`}>
                      <td>{r.observed_at ? new Date(r.observed_at).toLocaleString() : "—"}</td>
                      <td>{formatCoords(r.lat, r.lng)}</td>
                      <td>{r.weight.toFixed(1)}</td>
                      <td>{r.measured_distance_m != null ? `${r.measured_distance_m.toFixed(1)} m` : "—"}</td>
                      <td>{r.distance_to_estimate_m.toFixed(1)} m</td>
                      <td>
                        {r.residual_m != null ? `${r.residual_m > 0 ? "+" : ""}${r.residual_m.toFixed(1)} m` : "n/a"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}

      <CalibrationPanel />

      <section>
        <h2>Physical AP hypotheses</h2>
        <p className="page-hint">
          A BSSID is a radio, not a box. These are groups of BSSIDs that look like radios of one physical access
          point, with the evidence behind each — a hypothesis, not a verdict. Each is drawn on the map above as a pink
          ring.
        </p>
        {mesh.data?.truncated && (
          <p className="warning-text">
            Showing a partial result — the observation cap ({mesh.data.observation_limit}) was reached. Narrow the
            time range for a complete answer.
          </p>
        )}
        {multiRadioGroups.length === 0 ? (
          <p className="empty-state">No multi-radio access points identified{ssid ? ` for ${ssid}` : ""} in this range.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Radios</th>
                <th>SSIDs</th>
                <th>BSSIDs</th>
                <th>Confidence</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {multiRadioGroups.map((group) => (
                <tr key={group.hypothesis_id}>
                  <td>{group.hypothesis_id}</td>
                  <td>{group.radio_count}</td>
                  <td>{group.ssids.join(", ") || "(hidden)"}</td>
                  <td>
                    {group.bssids.map((b) => (
                      <div key={b}>
                        <Link to={`/networks/${encodeURIComponent(b)}`}>{b}</Link>
                      </div>
                    ))}
                  </td>
                  <td>{(group.confidence * 100).toFixed(0)}%</td>
                  <td>{group.evidence.join("; ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </section>
  );
}
