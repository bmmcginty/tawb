'use strict';

// Where a click lands.
//
// Activation here goes through the element's own default action rather than
// by driving a mouse at coordinates: a blind user has no viewport, and
// legitimate targets — skip links, visually hidden controls — sit off-screen
// where a pointer could never reach them.
//
// But `element.click()` fires at that element, and a real click does not. A
// mouse lands on the innermost element under the pointer and the event
// travels *up* from there, so a handler bound below the labelled control
// hears a real click and never hears ours. That is not an edge case: on a
// Bandcamp album page the accessible control is
//
//   <a role="button" aria-label="Play Weird Fish"><div class="play_status"></div></a>
//
// and the player listens on the inner div. Pressing Enter on the play button
// did nothing at all, in both browsers, while clicking the div played the
// track — which is why the only way to play anything was to switch to HTML
// view and activate the bare <div> there.
//
// So the click is aimed the way a mouse would be: at the deepest descendant
// covering the middle of the element. Events bubble from there back up
// through the element itself, so a handler on either one now hears it. The
// aim is done with layout boxes rather than elementFromPoint, which answers
// only for what is on screen and would make an off-screen control
// unclickable again.
function clickThrough(el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return false;

  const box = el.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;

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
      const rect = child.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
      inner = child;
      break;
    }
    if (!inner) break;
    node = inner;
  }

  node.click();
  return node !== el;
}

// Runs in the page before a real click: brings the element onto the screen
// and reports whether a click there would actually reach it.
//
// A real click goes where a real click goes — at a point, through whatever is
// painted on top. A reader cannot see that a cookie banner has landed over
// the button, so the check is made here and reported rather than discovered
// afterwards by whatever the click did instead.
//
// Where the element sits on screen is ours to choose, though, and a control
// hidden under a sticky bar in the middle of the window is often perfectly
// clear a moment later at the top of it. So the element is placed four
// different ways and the first placement that leaves it reachable is the one
// the click uses.
//
// Hit testing descends through shadow roots. elementFromPoint retargets to
// the shadow host — a custom element several hundred pixels away reports as
// the thing in the way — which is both useless to report and wrong to judge:
// what matters is the innermost element the click would actually reach.
function prepareRealClick(el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') {
    return { ok: false, reason: 'is not an element' };
  }

  // A closed shadow root is a shadow root for hit-testing purposes and not
  // for scripting ones: elementFromPoint retargets out of it and answers with
  // the host, and node.shadowRoot answers null. So the descent stopped at the
  // host and concluded the element was covered by it — which on Cloudflare's
  // challenge meant refusing to press the one control on the page, saying it
  // was "covered by <body>", when <body> was the thing hosting it.
  //
  // The driver leaves the roots it found on window (see driver_chromium.js),
  // and a ShadowRoot answers elementFromPoint whether it is open or closed,
  // so the chain can be followed the rest of the way down.
  const shadowOf = (node) => {
    if (node.shadowRoot) return node.shadowRoot;
    const closed = window.__twebClosed;
    return (closed && closed.get(node)) || null;
  };

  const deepHit = (x, y) => {
    const chain = [];
    let root = document;
    for (let depth = 0; depth < 8; depth += 1) {
      const hit = root.elementFromPoint(x, y);
      if (!hit || chain[chain.length - 1] === hit) break;
      chain.push(hit);
      const shadow = shadowOf(hit);
      if (!shadow) break;
      root = shadow;
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

    const box = el.getBoundingClientRect();
    if (!box.width || !box.height) return { ok: false, reason: 'has no size on screen' };

    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
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
    // way: that is where a mouse lands anyway, and the event travels up.
    if (chain.some((node) => node === el || el.contains(node))) {
      return { ok: true, x: Math.round(x), y: Math.round(y), placed: block };
    }

    blocked = { ok: false, reason: `is covered by ${name(chain[chain.length - 1])}`, covered: true };
  }

  return blocked || { ok: false, reason: 'could not be reached' };
}

module.exports = { clickThrough, prepareRealClick };
