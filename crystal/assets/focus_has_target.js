// Generated from src/focus.js focusTrackerHasTarget; update with tools/update_crystal_assets.js.
function focusTrackerHasTarget(token) {
  const tracker = window[Symbol.for('tweb.activationFocus')];
  if (!tracker || tracker.token !== token) return false;

  const active = document.activeElement;
  if (active && active.tagName && active !== tracker.before
    && active !== tracker.source
    && !(tracker.source.contains && tracker.source.contains(active))) {
    tracker.target = active;
  }
  return !!tracker.target;
}
