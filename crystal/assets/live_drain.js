// Generated from src/live.js DRAIN_SCRIPT; update with tools/update_crystal_assets.js.
() => {
  const queue = window[Symbol.for('tweb.queue')];
  if (!queue || !queue.length) return null;
  return queue.splice(0, queue.length);
}
