// Generated from src/driver_chromium.js sliderTrack; update with tools/update_crystal_assets.js.
function sliderTrack(el, isVertical) {
const root = el.getBoundingClientRect();
let start = 2;
let end = (isVertical ? root.height : root.width) - 2;
for (const child of el.querySelectorAll('button,[role="button"]')) {
  const part = child.getBoundingClientRect();
  if (!part.width || !part.height) continue;
  const nearStart = isVertical ? part.top <= root.top + 2 : part.left <= root.left + 2;
  const nearEnd = isVertical ? part.bottom >= root.bottom - 2 : part.right >= root.right - 2;
  if (nearStart) start = Math.max(start, isVertical ? part.bottom - root.top : part.right - root.left);
  if (nearEnd) end = Math.min(end, isVertical ? part.top - root.top : part.left - root.left);
}
// A narrow, long descendant is the painted track itself. It is a
// stronger boundary than the composite control's padded outer box.
let track = null;
for (const child of el.querySelectorAll('*:not(button):not([role="button"])')) {
  const part = child.getBoundingClientRect();
  const along = isVertical ? part.height : part.width;
  const across = isVertical ? part.width : part.height;
  const rootAlong = isVertical ? root.height : root.width;
  const rootAcross = isVertical ? root.width : root.height;
  if (along < rootAlong * 0.3 || across >= rootAcross * 0.8) continue;
  if (!track || along > track.along) {
    track = {
      along,
      start: isVertical ? part.top - root.top : part.left - root.left,
      end: isVertical ? part.bottom - root.top : part.right - root.left,
    };
  }
}
if (track) { start = track.start; end = track.end; }
return { start, end: Math.max(start, end), size: isVertical ? root.height : root.width };
}
