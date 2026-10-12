// Generated from src/library_chromium.js readDownloads; update with tools/update_crystal_assets.js.
function readDownloads(deadline) {
  const STATES = {
    0: 'in progress', 1: 'cancelled', 2: 'complete', 3: 'paused',
    4: 'dangerous', 5: 'interrupted', 6: 'insecure',
  };
  const manager = document.querySelector('downloads-manager');
  if (!manager) return Promise.resolve([]);
  return import('chrome://downloads/downloads.js')
    .then(({ browserProxyFactory }) => browserProxyFactory.getInstance().handler.getDownloads([]))
    .then(() => new Promise((resolve) => {
    const tick = () => {
      const items = manager.items_;
      if (Array.isArray(items) && (items.length || Date.now() > deadline)) {
        resolve(items.map((item) => ({
          title: String(item.fileName || ''),
          file: String(item.filePath || ''),
          url: String(item.url || ''),
          state: String(item.progressStatusText || item.lastReasonText
            || STATES[Number(item.state)] || 'unknown'),
          bytes: Number(item.total) || 0,
          totalBytes: Number(item.total) || 0,
          // Seconds here, where every other date in this browser is
          // milliseconds.
          when: item.started ? Number(item.started) * 1000 : null,
        })));
        return;
      }
      if (Date.now() > deadline) { resolve([]); return; }
      setTimeout(tick, 100);
    };
    tick();
  }));
}
