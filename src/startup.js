'use strict';

// Startup happens before the full-screen reader owns the terminal. Keep one
// useful line there instead of leaving a blank screen while a browser brings
// up its profile and protocol services. A spinner would make a screen reader
// announce motion rather than information, so updates happen only when the
// phase changes (or when the launcher has a meaningful elapsed-time update).
function startupStatus({
  write = (text) => process.stdout.write(text),
  isTTY = !!process.stdout.isTTY,
} = {}) {
  let last = null;
  let shown = false;

  const update = (message) => {
    const text = String(message || '').trim();
    if (!text || text === last) return false;
    last = text;
    shown = true;
    write(isTTY ? `\r\x1b[2K${text}` : `${text}\n`);
    return true;
  };

  const finish = () => {
    if (shown && isTTY) write('\n');
    shown = false;
  };

  return { update, finish };
}

module.exports = { startupStatus };
