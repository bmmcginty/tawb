'use strict';

// Startup happens before the full-screen reader owns the terminal. Once a
// wait has lasted ten seconds, keep one useful line there while a browser
// brings up its profile and protocol services. A normal quick start remains
// quiet. A spinner would make a screen reader announce motion rather than
// information, so updates happen only when the phase changes (or when the
// launcher has a meaningful elapsed-time update).
function startupStatus({
  write = (text) => process.stdout.write(text),
  isTTY = !!process.stdout.isTTY,
  delayMs = 10000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let last = null;
  let shown = false;
  let timer = null;

  const show = () => {
    timer = null;
    if (!last) return;
    shown = true;
    write(isTTY ? `\r\x1b[2K${last}` : `${last}\n`);
  };

  const update = (message) => {
    const text = String(message || '').trim();
    if (!text || text === last) return false;
    last = text;
    // A normal startup needs no narration. Remember its latest phase, but do
    // not put anything on the terminal unless the wait becomes noteworthy.
    if (!shown) {
      if (!timer) timer = setTimer(show, delayMs);
      return true;
    }
    show();
    return true;
  };

  const finish = () => {
    if (timer) { clearTimer(timer); timer = null; }
    if (shown && isTTY) write('\n');
    shown = false;
  };

  return { update, finish };
}

module.exports = { startupStatus };
