// Generated from src/core.js RESTORE_SCROLL; update with tools/update_crystal_assets.js.
() => {
  const undo = window[Symbol.for('tweb.scroll')];
  if (!undo) return false;
  for (const entry of undo) {
    try { entry.el.scrollTop = entry.top; } catch { /* detached since */ }
  }
  window[Symbol.for('tweb.scroll')] = null;
  return true;
}
