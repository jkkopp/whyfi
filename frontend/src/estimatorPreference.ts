/**
 * Which position-estimation algorithm this browser uses by default, for every
 * transceiver type (WiFi APs, BLE devices, cell towers).
 *
 * Stored in localStorage rather than on the server, matching `theme.ts` — the
 * app has no server-side user-settings model, and a per-browser view
 * preference doesn't justify inventing one. The Android app keeps its own
 * equivalent in SettingsRepository, same as it does for theme.
 *
 * The estimators themselves live server-side (backend/scans/estimators.py);
 * this only records which one to ask for.
 */
export type PositionEstimator = "centroid" | "strongest" | "rssi_multilateration" | "ftm_multilateration";

export const POSITION_ESTIMATORS: PositionEstimator[] = [
  "centroid",
  "strongest",
  "rssi_multilateration",
  "ftm_multilateration",
];

export const ESTIMATOR_LABELS: Record<PositionEstimator, string> = {
  centroid: "Signal-weighted centroid",
  strongest: "Strongest reading",
  rssi_multilateration: "RSSI multilateration (path loss)",
  ftm_multilateration: "FTM multilateration (Wi-Fi RTT)",
};

export const ESTIMATOR_DESCRIPTIONS: Record<PositionEstimator, string> = {
  centroid:
    "The signal-weighted centre of everywhere the device was heard. Robust and always available, but biased toward wherever you happened to walk.",
  strongest:
    "Simply the position of the strongest reading. A deliberately dumb baseline — useful because it can't be fooled by a bad distance model.",
  rssi_multilateration:
    "Converts each reading's signal strength to a distance (log-distance path loss), then solves for the position that best fits them. Sharper than a centroid, but only as good as the propagation assumption — walls and multipath break it.",
  ftm_multilateration:
    "Solves from real measured distances (Wi-Fi RTT/FTM) instead of inferring them from signal strength. The most accurate option, but only for WiFi APs you've explicitly ranged from the Android app.",
};

const STORAGE_KEY = "whyfi-position-estimator";
const DEFAULT_ESTIMATOR: PositionEstimator = "centroid";

export function getEstimatorPreference(): PositionEstimator {
  const stored = localStorage.getItem(STORAGE_KEY);
  return POSITION_ESTIMATORS.includes(stored as PositionEstimator)
    ? (stored as PositionEstimator)
    : DEFAULT_ESTIMATOR;
}

export function setEstimatorPreference(preference: PositionEstimator): void {
  if (preference === DEFAULT_ESTIMATOR) {
    localStorage.removeItem(STORAGE_KEY);
  } else {
    localStorage.setItem(STORAGE_KEY, preference);
  }
}
