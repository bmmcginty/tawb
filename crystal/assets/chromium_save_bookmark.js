// Generated from src/library_chromium.js saveBookmark; update with tools/update_crystal_assets.js.
function saveBookmark(entry) {
  const OTHER_BOOKMARKS_ID = '2';
  return new Promise((resolve, reject) => {
    chrome.bookmarks.getTree((tree) => {
      const roots = (tree && tree[0] && tree[0].children) || [];
      const folders = roots.filter((node) => !node.url);
      const target = folders.find((node) => node.id === OTHER_BOOKMARKS_ID)
        || folders[folders.length - 1];
      if (!target) { reject(new Error('this browser has nowhere to file a bookmark')); return; }

      // The whole tree is already in hand, so the "have I saved this before"
      // question costs nothing more than walking it.
      let already = null;
      const walk = (node, trail) => {
        if (!node || already) return;
        if (node.url) {
          if (node.url === entry.url) {
            already = { title: String(node.title || ''), folder: trail.join('/') };
          }
          return;
        }
        const here = node.title ? [...trail, String(node.title)] : trail;
        for (const child of node.children || []) walk(child, here);
      };
      for (const root of tree || []) walk(root, []);
      if (already) { resolve({ existed: true, ...already }); return; }

      chrome.bookmarks.create(
        { parentId: target.id, title: entry.title, url: entry.url },
        (made) => {
          if (!made) {
            reject(new Error(
              (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'refused'));
            return;
          }
          resolve({
            existed: false,
            title: String(made.title || entry.title || ''),
            folder: String(target.title || ''),
          });
        });
    });
  });
}
