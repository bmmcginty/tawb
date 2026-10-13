// Generated from src/focus.js takeFocusTrackerTarget; update with tools/update_crystal_assets.js.
function takeFocusTrackerTarget(token) {
  const key = Symbol.for('tweb.activationFocus');
  const tracker = window[key];
  if (!tracker || tracker.token !== token) return document.documentElement;
  document.removeEventListener('focusin', tracker.listener, true);
  delete window[key];
  return tracker.target || document.documentElement;
}
