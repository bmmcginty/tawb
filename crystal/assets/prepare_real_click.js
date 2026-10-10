// Generated from src/click.js prepareRealClick; update with tools/update_crystal_assets.js.
function prepareRealClick(el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') {
    return { ok: false, reason: 'is not an element' };
  }

  // Duplicated in clickThrough: each function is stringified separately when
  // it is sent into the page, so neither can call out to the other.
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

  // A closed shadow root is a shadow root for hit-testing purposes and not
  // for scripting ones: elementFromPoint retargets out of it and answers with
  // the host, and node.shadowRoot answers null. So the descent stopped at the
  // host and concluded the element was covered by it — which on Cloudflare's
  // challenge meant refusing to press the one control on the page, saying it
  // was "covered by <body>", when <body> was the thing hosting it.
  //
  // Which is answered from the target's side rather than the page's, and
  // needs nothing handed in. getRootNode() works from *inside* a closed
  // shadow root even though nothing outside can see in, so walking up from
  // the element gives every host between it and the document. If the point
  // answers with one of those, the retargeting is the reason and the element
  // really is what is under the cursor.
  const hostsAbove = (node) => {
    const hosts = new Set();
    let current = node;
    for (let depth = 0; depth < 8; depth += 1) {
      const root = current.getRootNode ? current.getRootNode() : null;
      if (!root || !root.host) break;
      hosts.add(root.host);
      current = root.host;
    }
    return hosts;
  };

  const deepHit = (x, y) => {
    const chain = [];
    let root = document;
    for (let depth = 0; depth < 8; depth += 1) {
      const hit = root.elementFromPoint(x, y);
      if (!hit || chain[chain.length - 1] === hit) break;
      chain.push(hit);
      if (!hit.shadowRoot) break;
      root = hit.shadowRoot;
    }
    return chain;
  };

  const name = (node) => {
    const tag = node.tagName ? node.tagName.toLowerCase() : 'something';
    const id = node.id ? `#${node.id}` : '';
    const cls = typeof node.className === 'string' && node.className.trim()
      ? `.${node.className.trim().split(/\s+/)[0]}` : '';
    return `<${tag}${id}${cls}>`;
  };

  let blocked = null;

  for (const block of ['center', 'start', 'end', 'nearest']) {
    // Instant, not the page's own scroll behaviour: a smooth scroll is still
    // animating when the next line measures the element, and everything after
    // that would be about where it used to be.
    el.scrollIntoView({ block, inline: 'center', behavior: 'instant' });

    // Re-read after the scroll: the boxes measured before it are at the
    // positions the element used to be at.
    const aim = aimPointOf(el);
    if (!aim.rect.width || !aim.rect.height) {
      return { ok: false, reason: 'has no size on screen' };
    }

    const x = aim.x;
    const y = aim.y;
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
      blocked = blocked || { ok: false, reason: 'cannot be brought onto the screen' };
      continue;
    }

    const chain = deepHit(x, y);
    if (!chain.length) {
      blocked = blocked || { ok: false, reason: 'is not visible at its own centre' };
      continue;
    }

    // A descendant under the point is the normal case, not something in the
    // way: that is where a mouse lands anyway, and the event travels up. A
    // host above it is the same answer wearing a disguise — elementFromPoint
    // retargets out of a shadow root, so <body> being reported for something
    // inside <body>'s own closed shadow root means the point is right.
    const hosts = hostsAbove(el);
    if (chain.some((node) => node === el || el.contains(node) || hosts.has(node))) {
      // A point just outside the element, for a pointer that has to arrive
      // from somewhere. Above it where there is room, below it otherwise.
      // See core.hover: a move that begins inside the element it is aiming
      // at crosses no boundary, and a page waiting to be entered is never
      // entered.
      //
      // Outside the menu item rather than outside the link inside it. A
      // dropdown listens on the item, which is bigger than its link — an
      // <li> with padding around an <a> — and mouseenter is not mouseover:
      // it is refused when the pointer came from somewhere the item already
      // contains. A point three pixels above the link is still inside the
      // item, so the arrival would be rejected by the very handler it is
      // meant to reach.
      let holder = el;
      try {
        holder = el.closest('li, [role="menuitem"], [aria-haspopup]') || el;
      } catch { /* an engine without closest, or a detached node */ }
      const outer = holder.getBoundingClientRect();
      const box = outer.width && outer.height ? outer : aim.rect;
      const above = box.top - 3;
      const below = box.bottom + 3;
      const from = above >= 0 ? above : Math.min(below, window.innerHeight - 1);
      return {
        ok: true,
        x: Math.round(x),
        y: Math.round(y),
        fromX: Math.round(x),
        fromY: Math.round(from),
        placed: block,
      };
    }

    blocked = { ok: false, reason: `is covered by ${name(chain[chain.length - 1])}`, covered: true };
  }

  return blocked || { ok: false, reason: 'could not be reached' };
}
