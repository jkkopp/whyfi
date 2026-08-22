import { useState } from "react";
import { api } from "../api/client";
import { ESTIMATOR_LABELS, POSITION_ESTIMATORS, type PositionEstimator } from "../estimatorPreference";
import { usePolling } from "../hooks/usePolling";
import type { CalibrationFit } from "../api/types";

/**
 * Scoreboard + calibration, both driven by pinned true positions.
 *
 * The scoreboard answers "which estimator should I trust here", which is a
 * different question from "which estimators disagree" — you can only answer it
 * against a surveyed reference.
 *
 * Calibration goes one step further and fits the path-loss constants to this
 * environment instead of the generic indoor-survey defaults. Applying a fit is
 * deliberately a separate, explicit action from computing one: it changes what
 * every RSSI-derived distance in the app means, so it shouldn't happen as a
 * side effect of looking at the numbers.
 */
export function CalibrationPanel() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [fit, setFit] = useState<CalibrationFit | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const benchmark = usePolling(() => api.localizationBenchmark(), 30000, [refreshKey]);
  const calibration = usePolling(() => api.calibration(), 60000, [refreshKey]);

  const fitted = calibration.data?.fitted?.find((f) => f.radio_kind === "wifi");
  const generic = calibration.data?.generic?.wifi;

  async function runFit() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.fitCalibration(false);
      setFit(result.fit);
      setRefreshKey((k) => k + 1);
    } catch {
      setError("Not enough pinned access points to fit a model yet — pin a few and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function setActive(isActive: boolean) {
    setBusy(true);
    setError(null);
    try {
      await api.setCalibrationActive(isActive);
      setRefreshKey((k) => k + 1);
    } catch {
      setError("Could not change the active model.");
    } finally {
      setBusy(false);
    }
  }

  const summary = benchmark.data?.summary ?? {};
  const scored = benchmark.data?.scored_ap_count ?? 0;

  return (
    <>
      <section>
        <h2>Estimator scoreboard</h2>
        <p className="page-hint">
          Every access point you've pinned a true position for, scored under all four estimators. This is the only
          thing here that says which algorithm is <em>right</em> rather than merely different — everything else can
          only show disagreement.
        </p>

        {scored === 0 ? (
          <p className="empty-state">
            No pinned access points yet. On the Localization page, select a network, then use “Pin true position” and
            click the map where the access point actually is.
          </p>
        ) : (
          <>
            <p className="page-hint">
              Scored across {scored} pinned access point{scored === 1 ? "" : "s"}. Median matters more than mean here:
              one badly surveyed pin can dominate the mean and flip the ranking.
            </p>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Algorithm</th>
                  <th>Median error</th>
                  <th>Mean error</th>
                  <th>Best</th>
                  <th>Worst</th>
                  <th>APs scored</th>
                </tr>
              </thead>
              <tbody>
                {POSITION_ESTIMATORS.map((name) => {
                  const row = summary[name];
                  return (
                    <tr key={name}>
                      <td>{ESTIMATOR_LABELS[name as PositionEstimator]}</td>
                      <td>{row ? `${row.median_error_m.toFixed(1)} m` : "—"}</td>
                      <td>{row ? `${row.mean_error_m.toFixed(1)} m` : "—"}</td>
                      <td>{row ? `${row.best_error_m.toFixed(1)} m` : "—"}</td>
                      <td>{row ? `${row.worst_error_m.toFixed(1)} m` : "—"}</td>
                      <td>{row?.scored_aps ?? 0}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
      </section>

      <section>
        <h2>Path-loss calibration</h2>
        <p className="page-hint">
          RSSI multilateration converts signal strength to distance with a propagation model. The default constants
          describe a generic building, not yours. With pinned access points the true distance to every reading is
          known, so the model can be fitted to this environment — which should improve RSSI multilateration
          everywhere it's used.
        </p>

        <table className="data-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Reference RSSI @ 1 m</th>
              <th>Path-loss exponent</th>
              <th>Fit quality (R²)</th>
              <th>Fitted over</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Generic default</td>
              <td>{generic ? `${generic.ref_rssi_at_1m} dBm` : "—"}</td>
              <td>{generic ? generic.path_loss_exponent : "—"}</td>
              <td>—</td>
              <td>—</td>
              <td>{fitted?.is_active ? "not in use" : "in use"}</td>
            </tr>
            {fitted && (
              <tr>
                <td>Fitted to your data</td>
                <td>{fitted.ref_rssi_at_1m.toFixed(1)} dBm</td>
                <td>{fitted.path_loss_exponent.toFixed(2)}</td>
                <td>{fitted.r_squared.toFixed(3)}</td>
                <td>
                  {fitted.min_distance_m.toFixed(0)}–{fitted.max_distance_m.toFixed(0)} m, {fitted.sample_count}{" "}
                  readings
                </td>
                <td>{fitted.is_active ? "in use" : "stored, not in use"}</td>
              </tr>
            )}
          </tbody>
        </table>

        {fitted && (
          <p className="page-hint">
            A fit is only meaningful across the distances it was fitted over ({fitted.min_distance_m.toFixed(0)}–
            {fitted.max_distance_m.toFixed(0)} m here). An R² well below ~0.5 means signal strength isn't predicting
            distance well in this environment — which is itself a useful finding, and a reason to trust FTM over RSSI
            rather than to apply the fit.
          </p>
        )}

        <div className="control-row print-hide">
          <button onClick={runFit} disabled={busy || scored === 0}>
            {busy ? "Working…" : "Fit model to pinned APs"}
          </button>
          {fitted && !fitted.is_active && (
            <button onClick={() => setActive(true)} disabled={busy || fitted.path_loss_exponent <= 0}>
              Use fitted model
            </button>
          )}
          {fitted?.is_active && (
            <button onClick={() => setActive(false)} disabled={busy}>
              Revert to generic model
            </button>
          )}
        </div>

        {fit && !fit.available && <p className="warning-text">{fit.reason}</p>}
        {fit?.available && fit.plausible === false && (
          <p className="warning-text">
            That fit has a negative path-loss exponent, which would mean signal getting stronger with distance. It's
            being driven by noise rather than propagation — collect readings across a wider spread of distances before
            applying it.
          </p>
        )}
        {error && <p className="error-text">{error}</p>}
      </section>
    </>
  );
}
