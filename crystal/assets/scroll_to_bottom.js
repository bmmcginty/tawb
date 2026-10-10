// Generated from src/core.js SCROLL_TO_BOTTOM; update with tools/update_crystal_assets.js.
() => {
  const root = document.scrollingElement || document.documentElement;
  const targets = [];
  if (root.scrollHeight > root.clientHeight + 50) targets.push(root);

  // Plenty of feeds scroll an inner container rather than the document, and
  // scrolling the document then does nothing at all. Find the tallest one
  // that actually scrolls. The cheap size test comes first so that style
  // resolution — the expensive half — runs on a handful of elements rather
  // than every element on the page.
  let best = null;
  for (const el of document.querySelectorAll('*')) {
    if (el.clientHeight < 200 || el.scrollHeight <= el.clientHeight + 50) continue;
    if (!/(auto|scroll)/.test(getComputedStyle(el).overflowY)) continue;
    if (!best || el.scrollHeight > best.scrollHeight) best = el;
  }
  if (best && best !== root) targets.push(best);

  // Where everything was, so a scroll that gained nothing can be undone.
  window[Symbol.for('tweb.scroll')] = targets.map((el) => ({ el, top: el.scrollTop }));

  let moved = false;
  for (const el of targets) {
    const before = el.scrollTop;
    el.scrollTop = el.scrollHeight;
    if (el.scrollTop !== before) moved = true;
  }

  // Which element was actually scrolled, in a form a log can carry. When a
  // feed does not respond on a real site, the first question is always
  // whether we scrolled the thing the feed is in.
  const name = (el) => {
    if (!el || el === root) return 'document';
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className
      ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  };

  return {
    elements: document.getElementsByTagName('*').length,
    // Nothing on the page scrolls, so no amount of waiting will produce
    // anything: this is the end of the page and we can say so at once.
    scrollable: targets.length > 0,
    moved,
    target: targets.map(name).join(' + ') || 'nothing',
  };
}
