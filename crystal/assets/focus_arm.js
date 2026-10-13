// Generated from src/focus.js armFocusTracker; update with tools/update_crystal_assets.js.
function armFocusTracker(source, token) {
  const key = Symbol.for('tweb.activationFocus');
  const previous = window[key];
  if (previous && previous.listener) {
    document.removeEventListener('focusin', previous.listener, true);
  }

  const tracker = { token, source, before: document.activeElement, target: null, listener: null };
  tracker.listener = (event) => {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const target = path[0] || event.target;
    if (!target || !target.tagName) return;
    // A pointer activation ordinarily focuses the thing that was pressed.
    // That is not a destination and must not move the terminal reader.
    if (target === source || (source.contains && source.contains(target))) return;
    tracker.target = target;
  };
  document.addEventListener('focusin', tracker.listener, true);
  window[key] = tracker;
  return true;
}
