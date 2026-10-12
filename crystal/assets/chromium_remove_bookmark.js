// Generated from src/library_chromium.js removeBookmark; update with tools/update_crystal_assets.js.
function removeBookmark(id) {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.remove(String(id || ''), () => {
      const error = chrome.runtime.lastError;
      if (error) { reject(new Error(error.message || 'refused')); return; }
      resolve({ removed: true });
    });
  });
}
