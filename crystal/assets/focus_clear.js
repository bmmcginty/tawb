// Generated from src/focus.js clearFocusTracker; update with tools/update_crystal_assets.js.
function clearFocusTracker(token) {
  const key = Symbol.for('tweb.activationFocus');
  const tracker = window[key];
  if (!tracker || tracker.token !== token) return false;
  document.removeEventListener('focusin', tracker.listener, true);
  delete window[key];
  return true;
}
