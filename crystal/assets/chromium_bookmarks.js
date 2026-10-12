// Generated from src/library_chromium.js readBookmarks; update with tools/update_crystal_assets.js.
function readBookmarks() {
  return new Promise((resolve) => {
    chrome.bookmarks.getTree((tree) => {
      const out = [];
      const walk = (node, trail) => {
        if (!node) return;
        if (node.url) {
          out.push({
            bookmarkId: String(node.id || ''),
            title: String(node.title || ''),
            url: String(node.url),
            folder: trail.join('/'),
            when: Number(node.dateAdded) || null,
          });
          return;
        }
        // The unnamed root above the browser's own folders contributes no name.
        const here = node.title ? [...trail, String(node.title)] : trail;
        for (const child of node.children || []) walk(child, here);
      };
      for (const root of tree || []) walk(root, []);
      resolve(out);
    });
  });
}
