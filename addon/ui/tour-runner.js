// When to start which tour. A finished or skipped tour is marked seen so it
// never nags; everything can be replayed from the "?" help button.
import {startTour, isTourRunning} from "./tour.js";
import {shouldAutoStart, markTourDone, pendingReleaseNotes, markVersionSeen} from "../core/tours.js";
import {PANEL_TOUR, BUILDER_TOUR, RELEASE_NOTES, releaseNotesTour} from "./tour-content.js";

export function extensionVersion() {
  try {
    const m = chrome.runtime.getManifest && chrome.runtime.getManifest();
    return (m && m.version) || "0.0.0";
  } catch (e) {
    return "0.0.0";
  }
}

export async function runTour(tour) {
  if (!tour) return null;
  const result = await startTour(tour);
  markTourDone(tour.id);
  return result;
}

function autoRun(tour, delayMs) {
  if (!tour || !shouldAutoStart(tour.id)) return;
  setTimeout(() => {
    if (isTourRunning() || !shouldAutoStart(tour.id)) return;
    runTour(tour);
  }, delayMs);
}

// On panel open: release notes after an update, otherwise the welcome tour
// for the current mode the first time.
export function autoStartPanelTours(mode) {
  const version = extensionVersion();
  const notes = pendingReleaseNotes(RELEASE_NOTES, version);
  markVersionSeen(version);
  if (notes.length && shouldAutoStart("whats-new@" + version)) {
    setTimeout(() => {
      if (isTourRunning()) return;
      startTour(releaseNotesTour(notes)).then(() => markTourDone("whats-new@" + version));
    }, 900);
    return;
  }
  autoRun(mode === "builder" ? BUILDER_TOUR : PANEL_TOUR, 900);
}

export function autoStartBuilderTour() {
  autoRun(BUILDER_TOUR, 600);
}

// Per-tab tips no longer open by themselves (they got in the way on every
// new tab); "Tour this tool" in the ? menu still shows them.
export function autoStartTabTour() {}

export function showReleaseNotes() {
  return startTour(releaseNotesTour(RELEASE_NOTES));
}
