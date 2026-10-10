// Generated from src/click.js clickThrough; update with tools/update_crystal_assets.js.
function clickThrough(el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return false;

  // Duplicated in prepareRealClick: each function is stringified separately
  // when it is sent into the page, so neither can call out to the other.
  const aimPointOf = (node) => {
    const rects = typeof node.getClientRects === 'function'
      ? Array.from(node.getClientRects()) : [];
    for (const rect of rects) {
      if (rect.width < 1 || rect.height < 1) continue;
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, rect };
    }
    const box = node.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2, rect: box };
  };
  // Whether a real line box of this node covers the point, rather than the
  // union of every line box covering it.
  const covers = (node, x, y) => {
    const rects = typeof node.getClientRects === 'function'
      ? Array.from(node.getClientRects()) : [];
    const boxes = rects.length ? rects : [node.getBoundingClientRect()];
    for (const rect of boxes) {
      if (!rect.width || !rect.height) continue;
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
      return true;
    }
    return false;
  };

  const aim = aimPointOf(el);
  const x = aim.x;
  const y = aim.y;

  let node = el;
  // Deep enough for an icon inside a span inside a button; bounded so a
  // pathological tree cannot spin here.
  for (let depth = 0; depth < 20; depth += 1) {
    let inner = null;
    for (const child of node.children) {
      const style = window.getComputedStyle(child);
      // Something the pointer would pass straight through is not a target.
      if (style.pointerEvents === 'none' || style.display === 'none'
        || style.visibility === 'hidden') continue;
      if (!covers(child, x, y)) continue;
      inner = child;
      break;
    }
    if (!inner) break;
    node = inner;
  }

  node.click();
  return node !== el;
}
