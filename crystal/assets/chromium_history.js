// Generated from src/library_chromium.js readHistory; update with tools/update_crystal_assets.js.
function readHistory(max) {
  return import('chrome://history/history.js').then(({ BrowserProxyImpl }) => {
    const handler = BrowserProxyImpl.getInstance().handler;
    return handler.queryHistory('', max);
  }).then((answer) => {
    const results = (answer && answer.results && answer.results.value) || [];
    return results.map((entry) => ({
      title: String(entry.title || ''),
      url: String(entry.url || ''),
      when: Number(entry.time) || null,
    }));
  });
}
