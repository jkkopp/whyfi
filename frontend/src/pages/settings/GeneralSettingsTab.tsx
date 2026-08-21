import { useState } from "react";
import { getBackendUrlOverride, setBackendUrlOverride } from "../../api/client";
import {
  ESTIMATOR_DESCRIPTIONS,
  ESTIMATOR_LABELS,
  POSITION_ESTIMATORS,
  getEstimatorPreference,
  setEstimatorPreference,
  type PositionEstimator,
} from "../../estimatorPreference";
import { getThemePreference, setThemePreference, type ThemePreference } from "../../theme";

export function GeneralSettingsTab() {
  const [url, setUrl] = useState(getBackendUrlOverride() ?? "");
  const [saved, setSaved] = useState(false);
  const [theme, setTheme] = useState<ThemePreference>(getThemePreference());
  const [estimator, setEstimator] = useState<PositionEstimator>(getEstimatorPreference());

  function handleEstimatorChange(next: PositionEstimator) {
    setEstimator(next);
    setEstimatorPreference(next);
  }

  function handleSave() {
    setBackendUrlOverride(url.trim() || null);
    setSaved(true);
    setTimeout(() => window.location.reload(), 400);
  }

  function handleThemeChange(next: ThemePreference) {
    setTheme(next);
    setThemePreference(next);
  }

  return (
    <div>
      <h2>Appearance</h2>
      <div className="band-selector">
        {(["system", "light", "dark"] as const).map((option) => (
          <button
            key={option}
            className={theme === option ? "active" : ""}
            onClick={() => handleThemeChange(option)}
          >
            {option === "system" ? "System" : option === "light" ? "Light" : "Dark"}
          </button>
        ))}
      </div>

      <h2>Position estimator</h2>
      <p className="page-hint">
        How the estimated position of a transmitter is calculated, everywhere it's shown — the marker on the Heatmap,
        the estimated location on each WiFi/BLE/cell tower detail page, and the default on the Localization page.
        Changing this changes what those dots mean, so it's worth comparing them on one device you know the real
        position of before trusting any of them. The Localization page can show all four side by side.
      </p>

      <label className="field">
        <span>Algorithm</span>
        <select value={estimator} onChange={(e) => handleEstimatorChange(e.target.value as PositionEstimator)}>
          {POSITION_ESTIMATORS.map((option) => (
            <option key={option} value={option}>
              {ESTIMATOR_LABELS[option]}
            </option>
          ))}
        </select>
      </label>
      <p className="page-hint">{ESTIMATOR_DESCRIPTIONS[estimator]}</p>
      {estimator === "ftm_multilateration" && (
        <p className="page-hint">
          Note: only WiFi APs you've ranged from the Android app have FTM data. Anything else — every BLE device and
          cell tower, and any AP you haven't ranged — falls back to the weighted centroid, and says so where it's
          shown.
        </p>
      )}

      <h2>Backend</h2>
      <p className="page-hint">
        By default this PWA talks to the backend that served it. If you installed it to your home screen and want it
        to point at a different self-hosted whyfi instance on your LAN, set that here — note that login only works
        against the backend that served this page (same-origin session cookie); pointing at a different backend here
        currently means viewing data there won't be possible until you're served from that origin directly.
      </p>

      <label className="field">
        <span>Backend URL</span>
        <input
          type="url"
          placeholder="http://192.168.1.50:8000"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>

      <button onClick={handleSave}>Save &amp; reload</button>
      {saved && <p className="page-hint">Saved. Reloading…</p>}

      <h2>iOS note</h2>
      <p className="page-hint">
        This PWA can be installed on iOS, but iOS never exposes WiFi/cellular/Bluetooth scanning to any app, native or
        web. On iOS this is always a viewer of data an Android device collected — see docs/architecture.md.
      </p>
    </div>
  );
}
