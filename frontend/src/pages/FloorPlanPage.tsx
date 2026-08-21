import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { PrintReportButton } from "../components/PrintReportButton";
import { RadioMap } from "../components/RadioMap";
import { ReportHeader } from "../components/ReportHeader";
import type { ReportField } from "../components/ReportHeader";
import { usePolling } from "../hooks/usePolling";
import { formatCoords } from "../reportLinks";
import { signalStrengthColor } from "../signalColor";
import type { FloorPlan, FloorPlanCoveragePoint, GroundTruthPosition } from "../api/types";

/** Where a click on the plan image landed, in the image's own pixel space.
 *
 * The image is displayed scaled to fit, so a click's offset within the
 * element has to be scaled back up to natural pixels — otherwise every
 * placement would be wrong by the display ratio, and wrong by a different
 * amount on a phone than on a desktop. */
function clickToImagePixels(event: React.MouseEvent<HTMLImageElement>, plan: FloorPlan) {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * plan.image_width_px,
    y: ((event.clientY - rect.top) / rect.height) * plan.image_height_px,
  };
}

type Mode = "place" | "calibrate" | "place-ap" | "outline";

const WEAK_DEFAULT_DBM = -70;

export function FloorPlanPage() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [mode, setMode] = useState<Mode>("place");
  // Several, because a router commonly names its 2.4 and 5GHz radios
  // differently — they're one network for coverage purposes.
  const [ssids, setSsids] = useState<string[]>([]);
  // Which coverage surface is on the plan. These answer different questions
  // and are mutually exclusive on purpose: overlaying a model output on top
  // of measured data, in the same colours, is the fastest way to end up
  // trusting a prediction about a room you never entered.
  //   measured  — IDW between the points you actually placed.
  //   predicted — path loss radiating out from each placed access point.
  const [layer, setLayer] = useState<"measured" | "predicted" | "none">("measured");
  const showHeatmap = layer === "measured";
  const showPrediction = layer === "predicted";
  // Multi-select, because one physical box has a 2.4 and a 5GHz radio with
  // different BSSIDs at the *same* place — placing them one at a time would
  // mean clicking the same pixel twice and hoping.
  const [apBssids, setApBssids] = useState<string[]>([]);
  // Candidates the operator has said aren't interesting. Kept per plan in
  // localStorage rather than in the database: it's a view preference about
  // which of the neighbourhood's networks clutter *this* survey, not a fact
  // about the network worth storing centrally.
  const [dismissed, setDismissed] = useState<string[]>([]);
  // Browser geolocation, so the calibration map opens where you are rather
  // than on a hardcoded default city.
  const [here, setHere] = useState<[number, number] | null>(null);
  // A placed point selected for fine adjustment, and the arm-then-confirm
  // state for destructive actions (matching ManageScansPage's pattern —
  // deleting a survey shouldn't be one stray click away).
  const [selectedPin, setSelectedPin] = useState<GroundTruthPosition | null>(null);
  const [armedDeletePlan, setArmedDeletePlan] = useState(false);
  const [showAlignment, setShowAlignment] = useState(false);
  // Sliders are driven by local drafts, not by the server value. Binding them
  // straight to `plan.*` meant every drag event fired a POST and then snapped
  // the handle back to the stale value until the refetch landed — the control
  // fought you the whole way. Drafts update instantly; the server is told
  // once you stop moving.
  const [bearingDraft, setBearingDraft] = useState<number | null>(null);
  const [widthDraft, setWidthDraft] = useState<number | null>(null);
  const adjustTimer = useRef<number | null>(null);
  // Same draft-plus-debounce shape as the bearing/width sliders: this one
  // drives a server round-trip (the whole coverage + heatmap payload is
  // recomputed against it), so committing on every pixel of travel would fire
  // a request per frame and make the handle fight the hand.
  const [threshold, setThreshold] = useState(WEAK_DEFAULT_DBM);
  const [thresholdDraft, setThresholdDraft] = useState<number | null>(null);
  const thresholdTimer = useRef<number | null>(null);
  const thresholdShown = thresholdDraft ?? threshold;

  function changeThreshold(next: number) {
    setThresholdDraft(next);
    if (thresholdTimer.current) window.clearTimeout(thresholdTimer.current);
    thresholdTimer.current = window.setTimeout(() => {
      setThreshold(next);
      setThresholdDraft(null);
    }, 250);
  }
  const [sessionId, setSessionId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Calibration is four clicks: plan point, world point, twice. Held here
  // until both pairs exist, then posted as one atomic calibration.
  const [pendingPlanPoint, setPendingPlanPoint] = useState<{ x: number; y: number } | null>(null);
  const [anchors, setAnchors] = useState<
    { imageX: number; imageY: number; lat: number; lng: number }[]
  >([]);

  useEffect(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => setHere([pos.coords.latitude, pos.coords.longitude]),
      // Silent: an unavailable fix just means the map opens on its default,
      // which is a cosmetic loss, not something to interrupt the user over.
      () => undefined,
      { enableHighAccuracy: true, timeout: 8000 },
    );
  }, []);

  const fileRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  // The plan image itself, so a drag anywhere on the page can still resolve
  // pointer coordinates against the image's box.
  const imageRef = useRef<HTMLImageElement>(null);
  const moveTimer = useRef<number | null>(null);
  const dragging = useRef<{ pin: GroundTruthPosition; pointerId: number; moved: boolean } | null>(null);
  // Where a pin is being dragged to right now, before anything is saved.
  // Rendering from this rather than from the server copy is what makes the
  // marker track the finger instead of lagging a request behind.
  const [pinDraft, setPinDraft] = useState<{ id: number; x: number; y: number } | null>(null);

  // The outline being traced, in image pixels. Held locally and saved as one
  // shape on "Done" rather than per vertex: a half-drawn polygon isn't a
  // meaningful footprint, and saving each click would have the heatmap
  // re-clip itself to a growing sliver while you're still drawing it.
  const [outlineDraft, setOutlineDraft] = useState<{ x: number; y: number }[] | null>(null);
  // Where the outline is being traced. On the plan drawing you're following
  // the architect's lines; on the map you're following your actual roof,
  // which is the better reference when the two disagree — and the plan image
  // is usually a crop or a sketch, so they often do. Either way the stored
  // form is pixels: the backend converts, so the polygon survives the plan
  // later being rotated or rescaled exactly as placed pins do.
  const [outlineOn, setOutlineOn] = useState<"plan" | "map">("plan");
  const [outlineWorldDraft, setOutlineWorldDraft] = useState<{ lat: number; lng: number }[]>([]);
  const outlineDragging = useRef<{ index: number; pointerId: number; moved: boolean } | null>(null);
  // A drag ends with a click on the same element, and this element's click
  // *deletes* the corner — so without this, moving a corner destroyed it.
  const suppressVertexClick = useRef(false);

  const plans = usePolling(() => api.floorPlans(), 60000, [refreshKey]);
  // Deliberately NOT keyed on refreshKey. Placing a pin doesn't create or
  // change a scan session, so re-reading all 500 of them after every single
  // placement bought nothing and re-paid the most expensive request on the
  // page each time. Its own 60s poll picks up scans that arrive from the
  // phone while you're surveying, which is the only way this list changes.
  const sessions = usePolling(() => api.scanSessions("?limit=500"), 60000, []);
  const accessPoints = usePolling(() => api.accessPoints("?limit=500"), 120000, []);
  const pins = usePolling(() => api.groundTruth("?kind=OBSERVER&limit=1000"), 30000, [refreshKey]);

  const plan = useMemo(
    () => (plans.data?.results ?? []).find((p) => p.id === selectedId) ?? null,
    [plans.data, selectedId],
  );

  const coverage = usePolling(
    () =>
      plan && ssids.length
        ? api.floorPlanCoverage(plan.id, ssids, threshold, {
            includeHeatmap: showHeatmap,
            includePrediction: showPrediction,
            heatmapSteps: 44,
          })
        : Promise.resolve(null),
    30000,
    [plan?.id, ssids.join("|"), threshold, showHeatmap, showPrediction, refreshKey],
  );

  // Networks actually audible at the plan's location, rather than every SSID
  // ever recorded anywhere — for a home survey the global list is mostly
  // other places entirely.
  const nearby = usePolling(
    () => (plan?.is_calibrated ? api.floorPlanNearbySsids(plan.id) : Promise.resolve(null)),
    120000,
    [plan?.id, plan?.is_calibrated, refreshKey],
  );
  const nearbySsids = nearby.data?.results ?? [];

  // Every BSSID of the chosen networks, for placing access points.
  const nearbyBssids = useMemo(
    () => nearbySsids.filter((n) => ssids.includes(n.ssid)).flatMap((n) => n.bssids.map((b) => ({ bssid: b, ssid: n.ssid }))),
    [nearbySsids, ssids],
  );

  const apPins = usePolling(() => api.groundTruth("?kind=AP&limit=500"), 60000, [refreshKey]);
  const apOnPlan = useMemo(
    () => (apPins.data?.results ?? []).filter((p: GroundTruthPosition) => p.floor_plan === plan?.id && p.image_x != null),
    [apPins.data, plan],
  );

  // Drop the drafts whenever the plan's own values change (a commit landing,
  // a reset, or switching plans) so the sliders track reality again.
  useEffect(() => {
    setBearingDraft(null);
    setWidthDraft(null);
  }, [plan?.id, plan?.bearing_deg, plan?.meters_per_pixel]);

  const dismissKey = plan ? `whyfi-floorplan-dismissed-${plan.id}` : null;
  useEffect(() => {
    if (!dismissKey) return;
    try {
      setDismissed(JSON.parse(localStorage.getItem(dismissKey) ?? "[]"));
    } catch {
      setDismissed([]);
    }
  }, [dismissKey]);

  function dismissCandidate(bssid: string) {
    const next = [...dismissed, bssid];
    setDismissed(next);
    setApBssids((prev) => prev.filter((b) => b !== bssid));
    if (dismissKey) localStorage.setItem(dismissKey, JSON.stringify(next));
  }

  function restoreCandidates() {
    setDismissed([]);
    if (dismissKey) localStorage.removeItem(dismissKey);
  }

  // Which networks you're surveying, remembered per plan.
  //
  // This used to reset to nothing on every load, and everything downstream of
  // it — the coverage layer, the weak-spot threshold, the whole set of view
  // controls — is only rendered once at least one network is picked. On a
  // desktop that's invisible, because step 3 is on screen next to the plan
  // and you tick it without thinking. On a phone the steps are stacked, so
  // you land on the plan with no controls at all and nothing says why: the
  // threshold slider simply isn't there until you scroll back up and re-pick
  // the same networks you picked last time. Your own router is not a
  // per-session decision.
  const ssidKey = plan ? `whyfi-floorplan-ssids-${plan.id}` : null;
  useEffect(() => {
    if (!ssidKey) return;
    try {
      const saved = JSON.parse(localStorage.getItem(ssidKey) ?? "[]");
      setSsids(Array.isArray(saved) ? saved.filter((s) => typeof s === "string") : []);
    } catch {
      setSsids([]);
    }
  }, [ssidKey]);

  function changeSsids(next: string[]) {
    setSsids(next);
    if (ssidKey) localStorage.setItem(ssidKey, JSON.stringify(next));
  }


  // Placements on this plan that don't yet have a coverage reading — shown so
  // you can see what you've placed before picking an SSID.
  const placements = useMemo(
    () => (pins.data?.results ?? []).filter((p) => p.floor_plan === plan?.id && p.image_x != null),
    [pins.data, plan],
  );

  async function handleUpload() {
    const file = fileRef.current?.files?.[0];
    const name = nameRef.current?.value?.trim();
    if (!file || !name) {
      setError("Pick a file and give the plan a name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // The browser knows the pixel dimensions; the backend deliberately
      // never decodes the image (no Pillow dependency).
      const dims = await new Promise<{ w: number; h: number }>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => reject(new Error("not an image"));
        img.src = URL.createObjectURL(file);
      });
      const form = new FormData();
      form.append("name", name);
      form.append("image", file);
      form.append("image_width_px", String(dims.w));
      form.append("image_height_px", String(dims.h));
      const created = await api.uploadFloorPlan(form);
      setSelectedId(created.id);
      setMode("calibrate");
      setMessage("Uploaded. Now calibrate it: click a recognisable spot on the plan, then the same spot on the map.");
      setRefreshKey((k) => k + 1);
    } catch {
      setError("Upload failed — is that an image file?");
    } finally {
      setBusy(false);
    }
  }

  async function adjust(patch: { bearing_deg?: number; meters_per_pixel?: number }) {
    if (!plan) return;
    setError(null);
    try {
      await api.adjustFloorPlan(plan.id, patch);
      setRefreshKey((k) => k + 1);
    } catch {
      setError("Could not adjust the plan.");
    }
  }

  /** Commits a slider's value once dragging settles. Without this a single
   * drag fires dozens of requests, each racing the others to write. */
  function adjustDebounced(patch: { bearing_deg?: number; meters_per_pixel?: number }) {
    if (adjustTimer.current) window.clearTimeout(adjustTimer.current);
    adjustTimer.current = window.setTimeout(() => adjust(patch), 250);
  }

  /** Commits a pin's new position. Re-POSTing the same (kind, target_key)
   * upserts, so nudging a point is the same call as placing it — and the
   * backend re-derives its real position from the new pixel coordinates. */
  async function commitPinPosition(pin: GroundTruthPosition, x: number, y: number) {
    if (!plan) return;
    try {
      await api.saveGroundTruth({
        kind: pin.kind,
        target_key: pin.target_key,
        floor_plan: plan.id,
        image_x: x,
        image_y: y,
      });
      setRefreshKey((k) => k + 1);
    } catch {
      setError("Could not move that point.");
    }
  }

  /** Moves a pin optimistically and commits once the gesture settles.
   *
   * Both callers are continuous: a slider fires onChange per pixel of travel
   * and a drag fires pointermove per frame. Writing on every one of those
   * meant dozens of POSTs racing each other for the same row, each followed
   * by a full refetch — the same mistake the bearing/width sliders already
   * had to be rescued from. The on-screen pin follows immediately from local
   * state; only the last position is saved. */
  function movePin(pin: GroundTruthPosition, x: number, y: number) {
    if (!plan) return;
    const clampedX = Math.max(0, Math.min(plan.image_width_px, x));
    const clampedY = Math.max(0, Math.min(plan.image_height_px, y));
    setSelectedPin({ ...pin, image_x: clampedX, image_y: clampedY });
    setPinDraft({ id: pin.id, x: clampedX, y: clampedY });
    if (moveTimer.current) window.clearTimeout(moveTimer.current);
    moveTimer.current = window.setTimeout(() => commitPinPosition(pin, clampedX, clampedY), 200);
  }

  /** Starts a drag on a pin already drawn on the plan. Pointer events (not
   * mouse events) so this works with a finger on the phone, which is where a
   * floor-plan survey actually gets done. setPointerCapture keeps the moves
   * coming even when the finger strays off the little 15px marker. */
  function startPinDrag(event: React.PointerEvent<HTMLDivElement>, pin: GroundTruthPosition) {
    if (!plan) return;
    event.stopPropagation();
    event.preventDefault();
    const image = imageRef.current;
    if (!image) return;
    setSelectedPin(pin);
    event.currentTarget.setPointerCapture(event.pointerId);
    dragging.current = { pin, pointerId: event.pointerId, moved: false };
  }

  function onPinDragMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragging.current;
    const image = imageRef.current;
    if (!drag || !plan || !image || event.pointerId !== drag.pointerId) return;
    event.stopPropagation();
    const rect = image.getBoundingClientRect();
    drag.moved = true;
    movePin(
      drag.pin,
      ((event.clientX - rect.left) / rect.width) * plan.image_width_px,
      ((event.clientY - rect.top) / rect.height) * plan.image_height_px,
    );
  }

  function endPinDrag(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragging.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.stopPropagation();
    dragging.current = null;
    setPinDraft(null);
  }

  /** Enters tracing mode, seeded with whatever outline is already stored so
   * an existing trace is edited rather than silently replaced. */
  function startOutline(where: "plan" | "map") {
    if (!plan) return;
    setOutlineOn(where);
    // Tracing on the map always starts fresh. A stored outline is in pixel
    // space; showing it as a half-done world-space draft you then append to
    // would silently mix the two, and the backend rejects that mixture
    // precisely because it is almost always a bug rather than an intention.
    setOutlineDraft(where === "plan" && plan.outline_points?.length ? [...plan.outline_points] : []);
    setOutlineWorldDraft([]);
    setMode("outline");
    setSelectedPin(null);
    setApBssids([]);
    setSessionId("");
    if (where === "map") setShowAlignment(true);
    setMessage(
      where === "map"
        ? "Click each corner of your building on the map. Three or more, then Save outline."
        : "Click each corner of the building on the plan. Three or more, then Save outline.",
    );
  }

  function cancelOutline() {
    setOutlineDraft(null);
    setOutlineWorldDraft([]);
    setMode("place");
    setMessage(null);
  }

  /** How many corners are in the trace, whichever space it's being drawn in. */
  function outlineDraftCount() {
    return outlineOn === "map" ? outlineWorldDraft.length : (outlineDraft ?? []).length;
  }

  async function saveOutline(points: { x: number; y: number }[] | { lat: number; lng: number }[]) {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      await api.saveFloorPlanOutline(plan.id, points);
      setOutlineDraft(null);
      setOutlineWorldDraft([]);
      setMode("place");
      setMessage(
        points.length
          ? `Outline saved — ${points.length} corners. The map footprint and the heatmap now follow it.`
          : "Outline cleared. The plan's own rectangle is used again.",
      );
      setRefreshKey((k) => k + 1);
    } catch {
      setError("Could not save that outline.");
    } finally {
      setBusy(false);
    }
  }

  /** Drags one traced vertex. Local only — the whole polygon is saved once,
   * on Done, exactly like the rest of the trace. */
  function startOutlineVertexDrag(event: React.PointerEvent<HTMLDivElement>, index: number) {
    event.stopPropagation();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    outlineDragging.current = { index, pointerId: event.pointerId, moved: false };
  }

  function onOutlineVertexDragMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = outlineDragging.current;
    const image = imageRef.current;
    if (!drag || !plan || !image || event.pointerId !== drag.pointerId) return;
    event.stopPropagation();
    const rect = image.getBoundingClientRect();
    const x = Math.max(0, Math.min(plan.image_width_px, ((event.clientX - rect.left) / rect.width) * plan.image_width_px));
    const y = Math.max(0, Math.min(plan.image_height_px, ((event.clientY - rect.top) / rect.height) * plan.image_height_px));
    drag.moved = true;
    setOutlineDraft((prev) => prev && prev.map((p, i) => (i === drag.index ? { x, y } : p)));
  }

  function endOutlineVertexDrag(event: React.PointerEvent<HTMLDivElement>) {
    const drag = outlineDragging.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.stopPropagation();
    // Only a stationary press is a click-to-remove. A press that moved was a
    // drag, and the browser's synthesised click must not delete what the
    // operator just finished positioning.
    suppressVertexClick.current = drag.moved;
    outlineDragging.current = null;
  }

  async function removePin(pin: GroundTruthPosition) {
    try {
      await api.deleteGroundTruth(pin.id);
      setSelectedPin(null);
      setMessage(pin.kind === "AP" ? "Access point removed." : "Measurement point removed.");
      setRefreshKey((k) => k + 1);
    } catch {
      setError("Could not remove that point.");
    }
  }

  async function deletePlan() {
    if (!plan) return;
    setBusy(true);
    try {
      await api.deleteFloorPlan(plan.id);
      setSelectedId(null);
      setSelectedPin(null);
      setArmedDeletePlan(false);
      setMessage(`Deleted "${plan.name}".`);
      setRefreshKey((k) => k + 1);
    } catch {
      setError("Could not delete that plan.");
    } finally {
      setBusy(false);
    }
  }

  async function handlePlanClick(event: React.MouseEvent<HTMLImageElement>) {
    if (!plan) return;
    const { x, y } = clickToImagePixels(event, plan);

    if (mode === "outline") {
      setOutlineDraft((prev) => [...(prev ?? []), { x, y }]);
      return;
    }

    if (mode === "calibrate") {
      setPendingPlanPoint({ x, y });
      setMessage(`Plan point ${anchors.length + 1} set. Now click the same spot on the map below.`);
      return;
    }

    // Radios are ticked, so this click is about access points regardless of
    // which mode the buttons happen to be in. Reading the intent off the
    // actual selection rather than off a hidden mode flag is what stops a
    // click being rejected for the wrong step's reason.
    if (mode === "place-ap" || apBssids.length > 0) {
      if (apBssids.length === 0) {
        setError("Tick which radios you're placing first.");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        // All selected radios land on the same spot — that's the point: they
        // live in one box.
        for (const bssid of apBssids) {
          await api.saveGroundTruth({ kind: "AP", target_key: bssid, floor_plan: plan.id, image_x: x, image_y: y });
        }
        const placed = apBssids.length;
        // Clear the selection afterwards, so the next click places the *next*
        // access point rather than silently dragging the one just placed.
        setApBssids([]);
        setMessage(
          `Placed ${placed} radio${placed === 1 ? "" : "s"}. Tick the next access point's radios and click again.`,
        );
        setRefreshKey((k) => k + 1);
      } catch {
        setError("Could not place that access point.");
      } finally {
        setBusy(false);
      }
      return;
    }

    if (!sessionId) {
      setError(
        "Pick which scan you're placing first — choose one under “Place your measurements”. " +
          "To place an access point instead, tick its radios in step 4.",
      );
      return;
    }
    if (!plan.is_calibrated) {
      setError("Calibrate this plan before placing measurements.");
      return;
    }
    setBusy(true);
    setError(null);
    // Ground truth is unique per (kind, target_key) — one scan session has
    // exactly one asserted position, on one plan. So re-picking a scan that's
    // already on the plan *moves* its existing point; it does not add a
    // second one. That's the right data model, but silently reporting
    // "Placed." either way made the point count sit still while you kept
    // placing, which reads as "it won't let me add any more".
    const wasAlreadyPlaced = placedSessionIds.has(sessionId);
    try {
      await api.saveGroundTruth({
        kind: "OBSERVER",
        target_key: sessionId,
        floor_plan: plan.id,
        image_x: x,
        image_y: y,
      });
      // Clear the selection, exactly as AP placement does. Leaving it set
      // meant the next click on the plan *moved* the measurement just placed
      // instead of placing the next one.
      setSessionId("");
      setMessage(
        wasAlreadyPlaced
          ? "That scan was already on the plan, so its point moved here rather than adding a second one. Pick a scan from “Not yet placed” to add a new point."
          : "Placed. Pick the next scan and click where you took it.",
      );
      setRefreshKey((k) => k + 1);
    } catch {
      setError("Could not place that measurement.");
    } finally {
      setBusy(false);
    }
  }

  async function handleMapClick(lat: number, lng: number) {
    // Tracing the footprint on the map. Until this existed the map only ever
    // accepted two clicks in its whole life — the calibration anchors — and
    // every click after those was silently ignored, which is exactly what
    // "I can't put more than two points on the map" was.
    if (mode === "outline" && outlineOn === "map") {
      setOutlineWorldDraft((prev) => [...prev, { lat, lng }]);
      return;
    }

    if (mode !== "calibrate" || !pendingPlanPoint || !plan) return;
    const next = [...anchors, { imageX: pendingPlanPoint.x, imageY: pendingPlanPoint.y, lat, lng }];
    setPendingPlanPoint(null);
    setAnchors(next);

    if (next.length < 2) {
      setMessage("Anchor 1 set. Now pick a second spot, as far from the first as you can.");
      return;
    }
    setBusy(true);
    try {
      await api.calibrateFloorPlan(plan.id, {
        anchor1_image_x: next[0].imageX,
        anchor1_image_y: next[0].imageY,
        anchor1_lat: next[0].lat,
        anchor1_lng: next[0].lng,
        anchor2_image_x: next[1].imageX,
        anchor2_image_y: next[1].imageY,
        anchor2_lat: next[1].lat,
        anchor2_lng: next[1].lng,
      });
      setAnchors([]);
      setMode("place");
      setMessage("Calibrated. Pick a scan and click the plan where you took it.");
      setRefreshKey((k) => k + 1);
    } catch {
      setError("Calibration failed — the two points may be too close together.");
      setAnchors([]);
    } finally {
      setBusy(false);
    }
  }

  const points: FloorPlanCoveragePoint[] = coverage.data?.points ?? [];
  const worst = points.filter((p) => p.is_weak);

  // The four stages, so each panel can show whether it's current, done, or
  // still waiting on an earlier step.
  const step: number = !plan
    ? 1
    : mode === "calibrate" || !plan.is_calibrated
      ? 2
      : ssids.length === 0
        ? 3
        : mode === "place-ap"
          ? 4
          : placements.length === 0
            ? 5
            : 6;

  // One dismissed list covers both levels: networks are stored as "ssid:NAME"
  // and radios as a bare BSSID, so hiding a network hides its radios too
  // without needing a second store to keep in sync.
  const visibleSsids = nearbySsids.filter((n) => !dismissed.includes(`ssid:${n.ssid}`)).slice(0, 20);
  const apCandidates = nearbyBssids.filter((b) => !dismissed.includes(b.bssid));
  const placedBssids = new Set(apOnPlan.map((p) => p.target_key));
  const placedSessionIds = new Set(placements.map((p) => p.target_key));
  const allSessions = sessions.data?.results ?? [];
  const unplacedSessions = allSessions.filter((s) => !placedSessionIds.has(s.id));
  const placedSessions = allSessions.filter((s) => placedSessionIds.has(s.id));
  // The dropdown only reaches the most recent SESSION_LIMIT scans. Say so
  // when there are more, rather than presenting a silently truncated list as
  // if it were everything — the failure mode is looking for a scan you know
  // you took and concluding the app lost it.
  // While tracing, the draft is the truth; otherwise show whatever is stored.
  const outlinePolygon = outlineDraft ?? plan?.outline_points ?? [];
  const sessionsTruncated = (sessions.data?.count ?? 0) > allSessions.length;
  const oldestListed = allSessions.length ? allSessions[allSessions.length - 1].started_at : null;
  // A point placed from a scan older than the window has no row to select, so
  // it can't be re-picked to move it. Worth calling out separately: it's not
  // "the list is long", it's "this specific pin is stranded".
  const strandedPlacements = placements.filter(
    (p) => !allSessions.some((s) => s.id === p.target_key),
  ).length;

  const overlayPoints =
    points.length > 0
      ? points
      : placements.map((p) => ({
          scan_session_id: p.target_key,
          image_x: p.image_x as number,
          image_y: p.image_y as number,
          label: "",
          rssi: null,
          bssid: null,
          observed_at: null,
          is_weak: false,
          no_coverage: false,
        }));

  const summary: ReportField[] = [
    { label: "Floor plan", value: plan?.name ?? "—" },
    { label: "Networks surveyed", value: ssids.join(" + ") || "—" },
    { label: "Measurement points", value: coverage.data?.measured_count ?? placements.length },
    {
      label: "Weak spots",
      value: coverage.data ? `${coverage.data.weak_count} below ${coverage.data.weak_threshold_dbm} dBm` : "—",
    },
    { label: "Access points placed", value: apOnPlan.length },
    {
      label: "Plan scale",
      value: plan?.meters_per_pixel
        ? `${(plan.meters_per_pixel * plan.image_width_px).toFixed(1)} m wide, bearing ${(plan.bearing_deg ?? 0).toFixed(0)}°`
        : "not calibrated",
    },
  ];

  return (
    <section>
      <ReportHeader
        title={`WiFi coverage survey — ${plan?.name ?? "floor plan"}`}
        summary={summary}
        viewSettings={[
          { label: "Weak threshold", value: `${threshold} dBm` },
          {
            label: "Coverage layer",
            value:
              layer === "measured"
                ? "measured — interpolated (IDW)"
                : layer === "predicted"
                  ? "PREDICTED from placed access points — modelled, not measured"
                  : "measured points only",
          },
          {
            label: "Unmeasured areas",
            value: "left blank — coverage is only claimed where it was measured",
          },
        ]}
      />

      <div className="page-title-row print-hide">
        <h1>Floor plan survey</h1>
        {plan && coverage.data && <PrintReportButton label="Print survey report" />}
      </div>
      <p className="page-hint">
        Find weak spots at home. Upload a floor plan, anchor it to the world once, then walk through your scans and
        click where each one was taken. GPS can&rsquo;t tell rooms apart indoors, so placing points by hand is what
        makes the result trustworthy.
      </p>

      {message && <p className="page-hint">{message}</p>}
      {error && <p className="error-text">{error}</p>}

      <div className={`workflow-step ${step === 1 ? "is-active" : "is-done"}`}>
        <h3>
          <span className="step-number">1</span> Choose or upload a plan
        </h3>
        <p>A picture of your floor plan — a screenshot of a estate-agent plan or a hand sketch both work fine.</p>
        <div className="control-row">
          <label>
            Plan
            <select
              value={selectedId ?? ""}
              onChange={(e) => {
                setSelectedId(e.target.value ? Number(e.target.value) : null);
                setAnchors([]);
                setPendingPlanPoint(null);
                setMessage(null);
                setError(null);
              }}
            >
              <option value="">Select a plan…</option>
              {(plans.data?.results ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} {p.is_calibrated ? `— ${p.placement_count} placed` : "— not calibrated"}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="control-row">
          <input ref={nameRef} type="text" placeholder="New plan name" />
          <input ref={fileRef} type="file" accept="image/*" />
          <button onClick={handleUpload} disabled={busy}>
            Upload plan
          </button>
        </div>
        {plan && (
          <div className="control-row">
            {armedDeletePlan ? (
              <>
                <span className="warning-text">
                  Delete &ldquo;{plan.name}&rdquo; and its {plan.placement_count} placement
                  {plan.placement_count === 1 ? "" : "s"}? The scans themselves are kept.
                </span>
                <button onClick={deletePlan} disabled={busy}>
                  Yes, delete
                </button>
                <button onClick={() => setArmedDeletePlan(false)}>Cancel</button>
              </>
            ) : (
              <button onClick={() => setArmedDeletePlan(true)}>Delete this plan</button>
            )}
          </div>
        )}
      </div>

      {plan && (
        <div className={`workflow-step ${step === 2 ? "is-active" : plan.is_calibrated ? "is-done" : ""}`}>
          <h3>
            <span className="step-number">2</span> Anchor it to the world
          </h3>
          <p>
            Click a spot you can recognise on both the plan and the map — a corner of the building works well — then
            the same spot on the map. Twice, as far apart as you can manage: two points are what fix the plan&rsquo;s
            scale and rotation together.
          </p>
          <div className="control-row">
            <button
              onClick={async () => {
                setError(null);
                // Wipe the old transform *before* switching modes, so the
                // stale footprint can't linger on the map while new anchors
                // are being picked.
                setBusy(true);
                try {
                  if (plan.is_calibrated) await api.resetFloorPlanCalibration(plan.id);
                  setAnchors([]);
                  setPendingPlanPoint(null);
                  setSelectedPin(null);
                  setShowAlignment(false);
                  setBearingDraft(null);
                  setWidthDraft(null);
                  setMode("calibrate");
                  setRefreshKey((k) => k + 1);
                  setMessage("Starting over — anchor 1 of 2. Click a recognisable spot on the plan.");
                } catch {
                  setError("Could not reset the calibration.");
                } finally {
                  setBusy(false);
                }
              }}
              className={mode === "calibrate" ? "active" : ""}
              disabled={busy}
            >
              {plan.is_calibrated ? "Start calibration over" : "Calibrate"}
            </button>
            {plan.is_calibrated && (
              <span className="page-hint" style={{ margin: 0 }}>
                Origin {formatCoords(plan.anchor1_lat as number, plan.anchor1_lng as number)}
              </span>
            )}
          </div>
          {plan.is_calibrated && (
            <>
              <p>
                Two clicks on a map aren&rsquo;t precise at house scale, so nudge the rotation until the plan lines up
                with reality. Bearing is which way the <em>top</em> of the plan points: 0&deg; is north.
              </p>
              <div className="control-row">
                <label className="slider-field">
                  Bearing
                  <input
                    type="range"
                    min={0}
                    max={359.5}
                    step={0.5}
                    value={bearingDraft ?? plan.bearing_deg ?? 0}
                    onChange={(e) => {
                      const next = Number(e.target.value);
                      setBearingDraft(next);
                      adjustDebounced({ bearing_deg: next });
                    }}
                  />
                  <output>{(bearingDraft ?? plan.bearing_deg ?? 0).toFixed(1)}&deg;</output>
                </label>
              </div>
              <div className="control-row">
                <label className="slider-field">
                  Width
                  {/* Fixed 1-60m range rather than one derived from the
                      current value — a range computed from the number being
                      dragged moves under your finger as you drag it. */}
                  <input
                    type="range"
                    min={1}
                    max={60}
                    step={0.1}
                    value={widthDraft ?? (plan.meters_per_pixel ?? 0) * plan.image_width_px}
                    onChange={(e) => {
                      const metres = Number(e.target.value);
                      setWidthDraft(metres);
                      adjustDebounced({ meters_per_pixel: metres / plan.image_width_px });
                    }}
                  />
                  <output>
                    {(widthDraft ?? (plan.meters_per_pixel ?? 0) * plan.image_width_px).toFixed(1)} m across
                  </output>
                </label>
                <button onClick={() => setShowAlignment((v) => !v)} className={showAlignment ? "active" : ""}>
                  {showAlignment ? "Hide alignment map" : "Check alignment on map"}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {plan && (mode === "calibrate" || (plan.is_calibrated && showAlignment)) && (
        <>
          {mode === "calibrate" ? (
            <p className="page-hint">
              Anchor {anchors.length + 1} of 2.{" "}
              {pendingPlanPoint ? "Now click the same spot on this map." : "Click the plan first."}
            </p>
          ) : mode === "outline" && outlineOn === "map" ? (
            <p className="page-hint">
              Click each corner of your building. The dashed shape is what you&rsquo;re drawing; the solid orange one
              is where the plan currently sits.
            </p>
          ) : (
            <p className="page-hint">
              The orange outline is where your plan currently sits. Nudge the bearing and scale above until it lines
              up with your building.
            </p>
          )}
          <RadioMap
            points={[]}
            polygons={
              (plan.corners
                ? [
                    {
                      points: plan.corners,
                      color: "#f59e0b",
                      // Outline only, and a hard one. The default 0.15 flat
                      // fill is meant for coverage areas, where a soft wash
                      // reads as "roughly here"; a floor plan's footprint is
                      // exact geometry and needs an edge crisp enough to line
                      // up against a roof. Without exactOutline the shared
                      // 4px coverage blur applies and the corners you're
                      // aiming with are the blurriest part of the shape.
                      fillOpacity: 0,
                      exactOutline: true,
                      label: `${plan.name} footprint — if this doesn't sit on your building, adjust the bearing and width above`,
                    },
                  ]
                : []
              ).concat(
                // The trace in progress, drawn alongside the current footprint
                // so you can see both the shape you're making and the one it
                // will replace. Two points is a line, which Leaflet is happy
                // to render as a degenerate polygon and is a useful cue that
                // the clicks are landing.
                outlineWorldDraft.length >= 2
                  ? [
                      {
                        points: outlineWorldDraft,
                        color: "#22d3ee",
                        fillOpacity: 0.15,
                        exactOutline: true,
                        label: "Building outline being traced",
                      },
                    ]
                  : [],
              )
            }
            // Clickable for calibration anchors, and now also while tracing
            // the outline — the map previously accepted exactly two clicks
            // ever and ignored the rest.
            onMapClick={
              pendingPlanPoint || (mode === "outline" && outlineOn === "map") ? handleMapClick : null
            }
            initialCenter={here}
          />
          {mode === "outline" && outlineOn === "map" && (
            <p className="page-hint">
              {outlineWorldDraft.length} corner{outlineWorldDraft.length === 1 ? "" : "s"} placed
              {outlineWorldDraft.length > 0 && (
                <>
                  {" — "}
                  <button onClick={() => setOutlineWorldDraft((prev) => prev.slice(0, -1))}>Undo last corner</button>
                </>
              )}
            </p>
          )}
          {!here && (
            <p className="page-hint">
              Couldn&rsquo;t read your location, so the map opened on its default view — pan to your home before
              picking anchor points.
            </p>
          )}
        </>
      )}

      {plan && plan.is_calibrated && (
        <div className={`workflow-step ${step === 3 ? "is-active" : ssids.length ? "is-done" : ""}`}>
          <h3>
            <span className="step-number">3</span> Choose your networks
          </h3>
          <p>
            Networks heard at this location, most-seen first. Tick every name your router uses &mdash; a 2.4 and a
            5&nbsp;GHz radio often have different SSIDs but are one network as far as &ldquo;do I have signal
            here&rdquo; goes.
          </p>
          <div className="control-row">
            {nearbySsids.length === 0 && (
              <span className="page-hint" style={{ margin: 0 }}>
                {nearby.loading ? "Looking for networks near this plan…" : "No networks recorded near this plan yet."}
              </span>
            )}
            {visibleSsids.map((n) => (
              <label key={n.ssid}>
                <input
                  type="checkbox"
                  checked={ssids.includes(n.ssid)}
                  onChange={(e) =>
                    changeSsids(e.target.checked ? [...ssids, n.ssid] : ssids.filter((x) => x !== n.ssid))
                  }
                />
                {n.ssid}{" "}
                <span className="meta-note">
                  ({n.reading_count}&times;, best {n.best_rssi} dBm, {n.bands.join("/")})
                </span>
              </label>
            ))}
          </div>

          <div className="control-row">
            <button
              onClick={() => {
                // Hide every network you didn't tick, and with it every radio
                // belonging to one — the neighbourhood's networks are noise
                // for a survey of your own. Reversible, and stored per plan,
                // so nothing is destroyed.
                const keep = new Set(ssids);
                const hiddenSsids = visibleSsids.filter((n) => !keep.has(n.ssid));
                const next = [
                  ...dismissed,
                  ...hiddenSsids.map((n) => `ssid:${n.ssid}`),
                  ...hiddenSsids.flatMap((n) => n.bssids),
                ];
                setDismissed(next);
                if (dismissKey) localStorage.setItem(dismissKey, JSON.stringify(next));
              }}
              disabled={ssids.length === 0 || visibleSsids.length <= ssids.length}
            >
              Hide all other networks
            </button>
            {dismissed.length > 0 && (
              <button onClick={restoreCandidates}>Restore hidden</button>
            )}
            <span className="page-hint" style={{ margin: 0 }}>
              {visibleSsids.length} network{visibleSsids.length === 1 ? "" : "s"} shown
              {ssids.length > 0 && `, ${ssids.length} selected`}
            </span>
          </div>
        </div>
      )}

      {plan && plan.is_calibrated && ssids.length > 0 && (
        <div className={`workflow-step ${step === 4 ? "is-active" : apOnPlan.length ? "is-done" : ""}`}>
          <h3>
            <span className="step-number">4</span> Place your access points
          </h3>
          <p>
            Tick the radios that live in one box &mdash; usually a 2.4 and a 5&nbsp;GHz BSSID &mdash; then click the
            plan once to place them together. Only radios from the networks you picked in step 3 are listed. These
            positions also feed the estimator scoreboard and path-loss calibration.
          </p>

          {nearby.loading && apCandidates.length === 0 ? (
            <p className="page-hint">Looking up which radios are audible here…</p>
          ) : apCandidates.length === 0 ? (
            <p className="empty-state">
              No radios left to place.{" "}
              {dismissed.length > 0 && <button onClick={restoreCandidates}>Restore {dismissed.length} dismissed</button>}
            </p>
          ) : (
            <div className="control-row">
              {apCandidates.map((b) => (
                <label key={b.bssid} className={placedBssids.has(b.bssid) ? "is-placed" : ""}>
                  <input
                    type="checkbox"
                    checked={apBssids.includes(b.bssid)}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...apBssids, b.bssid]
                        : apBssids.filter((x) => x !== b.bssid);
                      setApBssids(next);
                      // Ticking a radio *is* the statement of intent. The
                      // click target on the plan used to depend on a separate
                      // mode button that read like an instruction ("Click the
                      // plan to place 1 radio") rather than a control, so
                      // ticking a radio and then doing exactly what that line
                      // said produced "Pick which scan you're placing first"
                      // — an error about step 5, while you were working in
                      // step 4. Nothing was ever placed.
                      setMode(next.length > 0 ? "place-ap" : "place");
                    }}
                  />
                  <span className="mono">{b.bssid}</span>{" "}
                  {/* The SSID is the only thing that makes one of these MAC
                      addresses recognisable as "the box in the hallway", so it
                      stays plainly legible. A radio broadcasting no name at all
                      says so, rather than rendering as an empty gap that reads
                      like a loading glitch. */}
                  <span className="meta-note">
                    {b.ssid ? b.ssid : <em>hidden network (no SSID)</em>}
                    {placedBssids.has(b.bssid) ? " · placed" : ""}
                  </span>
                  <button
                    title="Not interesting — hide from this list"
                    onClick={(e) => {
                      e.preventDefault();
                      dismissCandidate(b.bssid);
                    }}
                  >
                    &times;
                  </button>
                </label>
              ))}
            </div>
          )}

          <div className="control-row">
            {/* Status, not a control. This used to be a button that had to be
                pressed to arm AP placement, while reading like an instruction
                you could simply follow — so the mode it set was easy to miss
                entirely. Ticking a radio arms it now, and this just reports
                where you are. */}
            <span className={apBssids.length > 0 ? "step-armed" : "page-hint"} style={{ margin: 0 }}>
              {apBssids.length > 0
                ? `Now click the plan to place ${apBssids.length} radio${apBssids.length === 1 ? "" : "s"}`
                : "Tick the radios that live in one box"}
            </span>
            <span className="page-hint" style={{ margin: 0 }}>
              {apCandidates.length} radio{apCandidates.length === 1 ? "" : "s"} from your networks,{" "}
              {apOnPlan.length} placed
            </span>
          </div>
        </div>
      )}

      {plan && plan.is_calibrated && (
        <div className={`workflow-step ${step === 5 ? "is-active" : placements.length ? "is-done" : ""}`}>
          <h3>
            <span className="step-number">5</span> Place your measurements
          </h3>
          <p>
            Pick a scan, then click the plan where you were standing when you took it. Already-placed points can be
            dragged to a new spot. Placed points also correct the input to every estimator elsewhere in the app, not
            just this view.
          </p>
          <div className="control-row">
            <label>
              Scan
              {/* Two groups, not one flat list. Every scan stays reachable —
                  you have to be able to re-pick a placed one to correct it —
                  but the ones that will *add* a point are separated from the
                  ones that will only move an existing point, which is the
                  distinction that actually matters while surveying. */}
              <select
                value={sessionId}
                onChange={(e) => {
                  setSessionId(e.target.value);
                  // Symmetrical with ticking an AP radio above: choosing a
                  // scan means the next click on the plan is a measurement.
                  if (e.target.value) {
                    setMode("place");
                    setApBssids([]);
                  }
                }}
                disabled={unplacedSessions.length === 0 && placedSessions.length === 0}
              >
                <option value="">
                  {sessions.data ? "Which scan are you placing?" : "Loading your scans…"}
                </option>
                {unplacedSessions.length > 0 && (
                  <optgroup label="Not yet placed">
                    {unplacedSessions.map((s) => (
                      <option key={s.id} value={s.id}>
                        {new Date(s.started_at).toLocaleString()} — {s.wifi_count} WiFi
                      </option>
                    ))}
                  </optgroup>
                )}
                {placedSessions.length > 0 && (
                  <optgroup label="Already on this plan (picking one moves it)">
                    {placedSessions.map((s) => (
                      <option key={s.id} value={s.id}>
                        ✓ {new Date(s.started_at).toLocaleString()} — {s.wifi_count} WiFi
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </label>
            <span className="page-hint" style={{ margin: 0 }}>
              {placements.length} placed on this plan
              {sessions.data
                ? `, ${unplacedSessions.length} scan${unplacedSessions.length === 1 ? "" : "s"} left to place`
                : " — still loading your scans"}
            </span>
          </div>

          {sessionsTruncated && (
            <p className="warning-text" style={{ marginTop: "0.5rem" }}>
              Showing the {allSessions.length} most recent scans of {sessions.data?.count} — anything before{" "}
              {oldestListed ? new Date(oldestListed).toLocaleDateString() : "that"} isn&rsquo;t in the list.
              {strandedPlacements > 0 && (
                <>
                  {" "}
                  {strandedPlacements} point{strandedPlacements === 1 ? " on this plan was" : "s on this plan were"}{" "}
                  placed from a scan that old, so {strandedPlacements === 1 ? "it" : "they"} can still be dragged on the
                  plan but can&rsquo;t be re-picked here.
                </>
              )}
            </p>
          )}
        </div>
      )}

      {/* Not gated on having picked networks: the footprint is a property of
          the building, and tracing it is useful before any survey data
          exists. */}
      {plan && plan.is_calibrated && (
        <div className="control-row floorplan-view-controls">
          {mode === "outline" ? (
            <>
              <span className="step-armed">
                Click each corner of the building {outlineOn === "map" ? "on the map below" : "on the plan"}
                {outlineDraftCount() > 0
                  ? ` — ${outlineDraftCount()} so far${
                      outlineDraftCount() < 3 ? `, ${3 - outlineDraftCount()} more needed` : ""
                    }`
                  : ""}
              </span>
              <button
                onClick={() => saveOutline(outlineOn === "map" ? outlineWorldDraft : (outlineDraft ?? []))}
                disabled={busy || outlineDraftCount() < 3}
                className="active"
              >
                Save outline
              </button>
              <button
                onClick={() => (outlineOn === "map" ? setOutlineWorldDraft([]) : setOutlineDraft([]))}
                disabled={outlineDraftCount() === 0}
              >
                Start over
              </button>
              <button onClick={cancelOutline}>Cancel</button>
              <span className="page-hint" style={{ margin: 0 }}>
                {outlineOn === "map"
                  ? "Zoom right in on your roof first — the closer you are, the more accurate the trace."
                  : "Drag a corner to move it, click one to remove it."}
              </span>
            </>
          ) : (
            <>
              <button onClick={() => startOutline("plan")}>
                {plan.outline_points?.length ? "Edit outline on plan" : "Trace outline on plan"}
              </button>
              {/* Tracing on the map follows the actual roof rather than the
                  architect's drawing, which is the better reference whenever
                  the plan image is a crop, a sketch, or just slightly off. */}
              <button onClick={() => startOutline("map")}>Trace outline on map</button>
              {plan.outline_points?.length > 0 && (
                <>
                  <button onClick={() => saveOutline([])} disabled={busy}>
                    Clear outline
                  </button>
                  <span className="page-hint" style={{ margin: 0 }}>
                    {plan.outline_points.length}-corner footprint — the map outline and heatmap follow it
                  </span>
                </>
              )}
              {!plan.outline_points?.length && (
                <span className="page-hint" style={{ margin: 0 }}>
                  Untraced: the plan&rsquo;s full rectangle is treated as the building
                </span>
              )}
            </>
          )}
        </div>
      )}

      {/* Shown whenever the plan is calibrated, NOT only once a network is
          picked. Hiding the whole row until then meant the threshold slider
          simply wasn't on the page, with nothing saying why or how to get it
          back — and on a phone, where step 3 is a long scroll up rather than
          sitting alongside the plan, that reads as a missing feature rather
          than an unmet precondition. A disabled control that explains itself
          is worth more than an absent one. */}
      {plan && plan.is_calibrated && (
        <div className="control-row floorplan-view-controls">
          {ssids.length === 0 && (
            <span className="page-hint" style={{ margin: 0, flexBasis: "100%" }}>
              Pick your networks in step&nbsp;3 above to measure coverage — until then there&rsquo;s no signal to
              threshold.
            </span>
          )}
          <label style={{ flex: "1 1 22rem", opacity: ssids.length === 0 ? 0.5 : 1 }}>
            Weak below
            {/* -40 to -90 dBm spans "right next to the router" to "barely
                audible"; anything outside that isn't a useful place to draw
                the line between fine and weak. Step of 1 dBm because the
                interesting range is narrow — the difference between -65 and
                -70 is the difference between a video call working and not. */}
            <input
              type="range"
              min={-90}
              max={-40}
              step={1}
              value={thresholdShown}
              disabled={ssids.length === 0}
              onChange={(e) => changeThreshold(Number(e.target.value))}
              style={{ flex: 1 }}
            />
            <output className="mono">{thresholdShown} dBm</output>
          </label>
          <label style={{ opacity: ssids.length === 0 ? 0.5 : 1 }}>
            Coverage
            <select
              value={layer}
              disabled={ssids.length === 0}
              onChange={(e) => setLayer(e.target.value as typeof layer)}
            >
              <option value="measured">Measured (interpolated)</option>
              <option value="predicted">Predicted from access points</option>
              <option value="none">Points only</option>
            </select>
          </label>
          <span className="page-hint" style={{ margin: 0 }}>
            {ssids.length === 0
              ? "no networks selected"
              : coverage.data
                ? `${coverage.data.weak_count} of ${coverage.data.measured_count} measured points are weak`
                : "measuring…"}
          </span>
        </div>
      )}

      {/* The predicted layer is a model output, and the one way this feature
          could actively mislead is by looking like the measured one. It gets
          a standing banner rather than a legend entry, because a legend is
          something you consult and a banner is something you can't miss. */}
      {plan && showPrediction && (
        <p className={coverage.data?.prediction ? "warning-text" : "page-hint"}>
          {coverage.data?.prediction ? (
            <>
              <strong>Modelled, not measured.</strong> Signal predicted outward from{" "}
              {coverage.data.prediction.sources.length} placed radio
              {coverage.data.prediction.sources.length === 1 ? "" : "s"} by path loss over distance.
              {coverage.data.prediction.sources.some((s) => s.source === "fitted") ? (
                <>
                  {" "}
                  Falloff fitted to your own readings where there were enough of them
                  {coverage.data.prediction.sources
                    .filter((s) => s.source === "fitted")
                    .map((s) => ` (${s.bssid}: ${s.sample_count} readings, R²&nbsp;${s.r_squared?.toFixed(2)})`)
                    .join("")}
                  .
                </>
              ) : (
                " Falloff uses generic indoor constants — no access point has enough nearby readings to fit a curve of its own yet."
              )}{" "}
              Walls are not modelled, so this is optimistic through masonry.
            </>
          ) : apOnPlan.length === 0 ? (
            "Place an access point in step 4 to predict coverage from it."
          ) : (
            "Predicting…"
          )}
        </p>
      )}

      {plan && (
        <div className={`floorplan-canvas is-clickable is-sticky${mode === "outline" ? " is-tracing" : ""}`}>
          <img ref={imageRef} src={plan.image} alt={plan.name} onClick={handlePlanClick} />

          {/* The building footprint, over the plan rather than clipping it —
              the image is a rectangular raster and stays one. Hiding the
              pixels outside the outline would take away the very context you
              trace against, and after tracing you still need to read the
              whole plan. So: rectangular raster, polygon drawn on top. */}
          {outlinePolygon.length >= 2 && (
            <svg
              className="floorplan-outline"
              viewBox={`0 0 ${plan.image_width_px} ${plan.image_height_px}`}
              preserveAspectRatio="none"
            >
              <polygon
                points={outlinePolygon.map((p) => `${p.x},${p.y}`).join(" ")}
                className={mode === "outline" ? "is-tracing" : ""}
              />
            </svg>
          )}

          {/* Vertex handles, only while tracing. Same pointer-event drag as
              the measurement pins, so a finger works. */}
          {mode === "outline" &&
            (outlineDraft ?? []).map((point, index) => (
              <div
                key={index}
                className="floorplan-vertex"
                title={`Corner ${index + 1} — drag to move, click to remove`}
                onPointerDown={(e) => startOutlineVertexDrag(e, index)}
                onPointerMove={onOutlineVertexDragMove}
                onPointerUp={endOutlineVertexDrag}
                onPointerCancel={endOutlineVertexDrag}
                onClick={(e) => {
                  e.stopPropagation();
                  if (suppressVertexClick.current) {
                    suppressVertexClick.current = false;
                    return;
                  }
                  setOutlineDraft((prev) => prev && prev.filter((_, i) => i !== index));
                }}
                style={{
                  left: `${(point.x / plan.image_width_px) * 100}%`,
                  top: `${(point.y / plan.image_height_px) * 100}%`,
                }}
              />
            ))}

          {/* Interpolated surface, under the measured dots. Cells the backend
              left null are beyond the influence of any reading and are simply
              not drawn — an unpainted area means "not measured", which is a
              more honest thing to show than a guess. */}
          {showHeatmap &&
            coverage.data?.heatmap?.cells.map((cell, i) => {
              if (cell.rssi == null) return null;
              // image_x/image_y are the cell's *centre* (see
              // interpolate_coverage), but left/top position its top-left
              // corner — so painting them directly shifted the whole surface
              // down and right by half a cell. Barely visible while the
              // heatmap covered the entire rectangle; obvious the moment it
              // gets clipped to a traced outline and the edges are crisp.
              const cellPercent = 100 / (coverage.data?.heatmap?.steps ?? 1);
              return (
                <div
                  key={`h${i}`}
                  className="floorplan-heat-cell"
                  style={{
                    left: `${(cell.image_x / plan.image_width_px) * 100 - cellPercent / 2}%`,
                    top: `${(cell.image_y / plan.image_height_px) * 100 - cellPercent / 2}%`,
                    width: `${cellPercent}%`,
                    height: `${cellPercent}%`,
                    background: signalStrengthColor(cell.rssi),
                  }}
                />
              );
            })}

          {/* Predicted surface, radiating out from each placed access point.
              Same signal-strength colours, because green-to-red means the
              same thing here — but hatched, so at a glance you can tell you
              are looking at a model rather than at somewhere you stood. */}
          {showPrediction &&
            coverage.data?.prediction?.cells.map((cell, i) => {
              const cellPercent = 100 / (coverage.data?.prediction?.steps ?? 1);
              return (
                <div
                  key={`p${i}`}
                  className="floorplan-heat-cell is-predicted"
                  title={`${cell.rssi} dBm predicted — ${cell.distance_m} m from ${cell.bssid}`}
                  style={{
                    left: `${(cell.image_x / plan.image_width_px) * 100 - cellPercent / 2}%`,
                    top: `${(cell.image_y / plan.image_height_px) * 100 - cellPercent / 2}%`,
                    width: `${cellPercent}%`,
                    height: `${cellPercent}%`,
                    // backgroundColor, not the `background` shorthand: the
                    // shorthand resets background-image, which would erase
                    // the hatching that marks this as predicted.
                    backgroundColor: signalStrengthColor(cell.rssi),
                  }}
                />
              );
            })}

          {/* Placed access points, drawn distinctly from measurement spots —
              one is a thing you surveyed, the other is where you stood. */}
          {(coverage.data?.suggestions ?? []).map((sug) => (
            <div
              key={`sug${sug.rank}`}
              className="floorplan-suggestion"
              title={`Suggestion ${sug.rank}: ${sug.action === "add" ? "add" : "move"} an access point here — ${sug.rationale}`}
              style={{
                left: `${(sug.image_x / plan.image_width_px) * 100}%`,
                top: `${(sug.image_y / plan.image_height_px) * 100}%`,
              }}
            >
              {sug.rank}
            </div>
          ))}

          {apOnPlan.map((ap) => {
            const at = pinDraft?.id === ap.id ? pinDraft : { x: ap.image_x as number, y: ap.image_y as number };
            return (
              <div
                key={`ap${ap.id}`}
                className={`floorplan-ap is-draggable${selectedPin?.id === ap.id ? " is-selected" : ""}`}
                title={`Access point ${ap.target_key} — drag to move, click to edit`}
                onPointerDown={(e) => startPinDrag(e, ap)}
                onPointerMove={onPinDragMove}
                onPointerUp={endPinDrag}
                onPointerCancel={endPinDrag}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedPin(ap);
                }}
                style={{
                  left: `${(at.x / plan.image_width_px) * 100}%`,
                  top: `${(at.y / plan.image_height_px) * 100}%`,
                }}
              />
            );
          })}
          {overlayPoints.map((point) => {
            const pin = placements.find((p) => p.target_key === point.scan_session_id);
            const at =
              pin && pinDraft?.id === pin.id ? pinDraft : { x: point.image_x, y: point.image_y };
            return (
              <div
                key={point.scan_session_id}
                className={`floorplan-point${point.is_weak ? " is-weak" : ""}${
                  point.rssi == null ? " is-unmeasured" : ""
                }${pin ? " is-draggable" : ""}${selectedPin?.id === pin?.id ? " is-selected" : ""}`}
                title={
                  (point.rssi == null
                    ? point.no_coverage
                      ? "Not heard here at all"
                      : "Placed — pick a network to see signal"
                    : `${point.rssi} dBm${point.is_weak ? " — weak" : ""}`) +
                  (pin ? " — drag to move" : "")
                }
                onPointerDown={pin ? (e) => startPinDrag(e, pin) : undefined}
                onPointerMove={pin ? onPinDragMove : undefined}
                onPointerUp={pin ? endPinDrag : undefined}
                onPointerCancel={pin ? endPinDrag : undefined}
                onClick={(e) => {
                  e.stopPropagation();
                  if (pin) setSelectedPin(pin);
                }}
                style={{
                  left: `${(at.x / plan.image_width_px) * 100}%`,
                  top: `${(at.y / plan.image_height_px) * 100}%`,
                  ...(point.rssi == null ? {} : { background: signalStrengthColor(point.rssi) }),
                }}
              />
            );
          })}
        </div>
      )}

      {plan && selectedPin && (
        <div className="workflow-step is-active">
          <h3>
            <span className="step-number">±</span>{" "}
            {selectedPin.kind === "AP" ? `Access point ${selectedPin.target_key}` : "Measurement point"}
          </h3>
          <p>
            Drag it straight on the plan, or nudge it with the sliders — either beats re-clicking and hoping to hit
            the same few pixels again, especially on a phone.
          </p>
          <div className="control-row">
            <label style={{ flex: "1 1 16rem" }}>
              Left / right
              <input
                type="range"
                min={0}
                max={plan.image_width_px}
                value={selectedPin.image_x ?? 0}
                onChange={(e) => movePin(selectedPin, Number(e.target.value), selectedPin.image_y ?? 0)}
                style={{ flex: 1 }}
              />
            </label>
            <label style={{ flex: "1 1 16rem" }}>
              Up / down
              <input
                type="range"
                min={0}
                max={plan.image_height_px}
                value={selectedPin.image_y ?? 0}
                onChange={(e) => movePin(selectedPin, selectedPin.image_x ?? 0, Number(e.target.value))}
                style={{ flex: 1 }}
              />
            </label>
          </div>
          <div className="control-row">
            <span className="page-hint" style={{ margin: 0 }}>
              {Math.round(selectedPin.image_x ?? 0)}, {Math.round(selectedPin.image_y ?? 0)} px
              {plan.meters_per_pixel
                ? ` — one step ≈ ${(plan.meters_per_pixel * 1).toFixed(2)} m`
                : ""}
            </span>
            <button onClick={() => removePin(selectedPin)}>Remove this point</button>
            <button onClick={() => setSelectedPin(null)}>Done</button>
          </div>
        </div>
      )}

      {coverage.data && coverage.data.suggestions?.length > 0 && (
        <>
          <h2>Suggested access point changes</h2>
          <p className="page-hint">
            Derived from where the weak measurements cluster: a weak area is weak because no radio is near enough to
            it, so the middle of that area is where one would help most. Whether to move an existing node or add
            another is partly a question of power sockets and cabling &mdash; the distance to the nearest access point
            is given so that call is yours.
          </p>
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Action</th>
                <th>Weak points covered</th>
                <th>Worst signal there</th>
                <th>Nearest existing AP</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {(coverage.data.suggestions ?? []).map((sug) => (
                <tr key={sug.rank}>
                  <td>{sug.rank}</td>
                  <td>{sug.action === "add" ? "Add a node" : "Move a node"}</td>
                  <td>
                    {sug.weak_point_count}
                    {sug.dead_point_count > 0 && ` (${sug.dead_point_count} with no signal at all)`}
                  </td>
                  <td>{sug.worst_rssi == null ? "not heard" : `${sug.worst_rssi} dBm`}</td>
                  <td className="mono">
                    {sug.nearest_ap_bssid
                      ? `${sug.nearest_ap_bssid} (${sug.nearest_ap_distance_m?.toFixed(0)} m)`
                      : "none placed"}
                  </td>
                  <td>{sug.rationale}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {plan && apOnPlan.length > 0 && (
        <>
          <h2>Placed access points</h2>
          <table className="data-table">
            <thead>
              <tr>
                <th>BSSID</th>
                <th>Position on plan</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {apOnPlan.map((ap) => (
                <tr key={ap.id}>
                  <td className="mono">{ap.target_key}</td>
                  <td>
                    {Math.round(ap.image_x as number)}, {Math.round(ap.image_y as number)} px
                  </td>
                  <td>
                    <button onClick={() => setSelectedPin(ap)}>Edit</button>{" "}
                    <button onClick={() => removePin(ap)}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {coverage.data && (
        <>
          <h2>
            Weak spots — {coverage.data.ssids.join(" + ")} ({coverage.data.weak_count} of{" "}
            {coverage.data.measured_count} measured
            points below {coverage.data.weak_threshold_dbm} dBm)
          </h2>
          {worst.length === 0 ? (
            <p className="empty-state">No weak spots at this threshold. Try raising it to see marginal areas.</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Signal</th>
                  <th>Strongest radio there</th>
                  <th>Network</th>
                  <th>Measured</th>
                  <th>Position on plan</th>
                </tr>
              </thead>
              <tbody>
                {worst.map((point) => (
                  <tr key={point.scan_session_id}>
                    <td>{point.no_coverage ? "not heard at all" : `${point.rssi} dBm`}</td>
                    <td className="mono">{point.bssid ?? "—"}</td>
                    <td>{point.ssid ?? "—"}</td>
                    <td>{point.observed_at ? new Date(point.observed_at).toLocaleString() : "—"}</td>
                    <td>
                      {Math.round(point.image_x)}, {Math.round(point.image_y)} px
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
