// Generated from src/place.js locateElement; update with tools/update_crystal_assets.js.
function locateElement(subject, directArrayName = null) {
  // Called either against a page with { el, arrayName }, or directly against
  // an element handle with the array name as its one argument. The latter is
  // required by the protocol clients: a handle nested inside an ordinary
  // object cannot be serialised as a remote object reference.
  const el = directArrayName ? subject : subject.el;
  const arrayName = directArrayName || subject.arrayName;
  const nodes = window[Symbol.for(arrayName)];
  if (!nodes || !nodes.length || !el) return null;

  const positions = new Map();
  for (let i = 0; i < nodes.length; i += 1) {
    if (!positions.has(nodes[i])) positions.set(nodes[i], i);
  }

  for (let node = el; node; node = node.parentElement) {
    const found = positions.get(node);
    if (found != null) return { index: found, exact: node === el };
  }

  const all = document.getElementsByTagName('*');
  const order = new Map();
  for (let i = 0; i < all.length; i += 1) order.set(all[i], i);
  const target = order.get(el);
  if (target == null) return null;

  let best = null;
  for (let i = 0; i < nodes.length; i += 1) {
    const at = order.get(nodes[i]);
    if (at == null || at > target) continue;
    if (!best || at > best.at) best = { index: i, at };
  }
  return best ? { index: best.index, exact: false } : null;
}
