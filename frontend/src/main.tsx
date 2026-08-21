import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App";
import { applyTheme, watchSystemTheme } from "./theme";
import "./index.css";

applyTheme();
watchSystemTheme();

// The generated service worker calls skipWaiting()/clientsClaim() on its
// own (registerType: "autoUpdate" in vite.config.ts), but that only takes
// over *future* network requests — it never reloads a tab that's already
// open, so an installed PWA left running silently keeps executing the old
// JS bundle indefinitely, forever "not seeing" any fix. Forcing a reload
// the moment a new version is detected is what actually makes
// "autoUpdate" live up to its name. See MEMORY.md.
//
// That "moment a new version is detected" still depended on the browser's
// own SW-update check, which only runs on a real top-level navigation to
// this document (a fresh load or hard refresh) — never on in-app
// react-router route changes, and never on a timer by itself. A tab left
// open across a deploy, only ever navigated within the SPA, could sit on
// a stale bundle indefinitely despite this whole mechanism existing —
// exactly the "I fixed it and the user still sees the bug" trap this file
// already has one round of history with (see MEMORY.md). Polling
// registration.update() closes that gap: it re-fetches sw.js byte-for-byte
// on an interval and whenever the tab regains focus, so a long-lived tab
// converges on its own instead of requiring a manual hard refresh.
const UPDATE_CHECK_INTERVAL_MS = 60_000;
registerSW({
  immediate: true,
  onNeedRefresh: () => window.location.reload(),
  onRegisteredSW(_url, registration) {
    if (!registration) return;
    setInterval(() => registration.update(), UPDATE_CHECK_INTERVAL_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") registration.update();
    });
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
