// Generated from src/core.js TEXT_AT_FRAGMENT; update with tools/update_crystal_assets.js.
(hash) => {
  let target = null;
  try {
    target = document.getElementById(hash) || document.querySelector(`[name="${CSS.escape(hash)}"]`);
  } catch { /* not a usable selector */ }
  if (!target) return null;

  // The first readable text at or after the target. A skip link usually
  // points at a container — <main id="main-content"> — whose own text is the
  // entire rest of the page, so what identifies the place is the first thing
  // inside it, not the container.
  //
  // Readable is the load-bearing word. Reddit's #main-content opens with a
  // <script> whose source is the first text node in it; matching on that
  // looks for `SML.load([...])` in the buffer, which no view will ever show.
  const UNRENDERED = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE', 'HEAD']);
  const walker = document.createTreeWalker(document.body || document, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || UNRENDERED.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if ((node.data || '').replace(/\s+/g, ' ').trim().length < 2) return NodeFilter.FILTER_REJECT;
      const style = window.getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  walker.currentNode = target;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    return (node.data || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  }
  return null;
}
