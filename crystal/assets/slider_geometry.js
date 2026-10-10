// Generated from src/driver_firefox.js sliderGeometry; update with tools/update_crystal_assets.js.
function sliderGeometry(el, requested) {
  const root = el.getBoundingClientRect();
  const vertical = requested === 'vertical'
    || (!requested && root.height > root.width * 1.5);
  let start = 2;
  let end = (vertical ? root.height : root.width) - 2;
  // A composite slider may keep its mute button inside the slider's own box.
  // That button is not track: clicking a low volume on it toggles mute
  // instead of setting the requested value.
  for (const child of el.querySelectorAll('button,[role="button"]')) {
    const part = child.getBoundingClientRect();
    if (!part.width || !part.height) continue;
    const nearStart = vertical ? part.top <= root.top + 2 : part.left <= root.left + 2;
    const nearEnd = vertical ? part.bottom >= root.bottom - 2 : part.right >= root.right - 2;
    if (nearStart) start = Math.max(start, vertical ? part.bottom - root.top : part.right - root.left);
    if (nearEnd) end = Math.min(end, vertical ? part.top - root.top : part.left - root.left);
  }
  let track = null;
  for (const child of el.querySelectorAll('*:not(button):not([role="button"])')) {
    const part = child.getBoundingClientRect();
    const along = vertical ? part.height : part.width;
    const across = vertical ? part.width : part.height;
    const rootAlong = vertical ? root.height : root.width;
    const rootAcross = vertical ? root.width : root.height;
    if (along < rootAlong * 0.3 || across >= rootAcross * 0.8) continue;
    if (!track || along > track.along) {
      track = {
        along,
        start: vertical ? part.top - root.top : part.left - root.left,
        end: vertical ? part.bottom - root.top : part.right - root.left,
      };
    }
  }
  if (track) { start = track.start; end = track.end; }
  return { width: root.width, height: root.height, vertical, start, end: Math.max(start, end) };
}
