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
// covering the aim point of the element. Events bubble from there back up
// through the element itself, so a handler on either one now hears it. The
// aim is done with layout boxes rather than elementFromPoint, which answers
// only for what is on screen and would make an off-screen control
// unclickable again.
//
// The aim point is the middle of the element's first line box, not the middle
// of getBoundingClientRect(). For a block element the two are the same point.
// For an inline element that wraps onto more than one line they are not:
// getBoundingClientRect() returns the union of every line box, and the middle
// of that union falls in the leading between two lines, or past the end of a
// short last line — a place the element does not occupy at all. See
// aimPointOf, which both functions in this file duplicate because each one is
// serialised into the page on its own.
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

// Whether pressing this would submit a form the browser filled in itself.
//
// A saved password is not in the page. Both engines fill the fields visually
// and keep the value from page script until a person interacts with the page,
// which is what stops a hostile page reading a credential the reader never
// meant to give it. The catch is that it also applies to the submission: a
// form sent by `element.click()` — no mouse, no key, no user activation —
// arrives at the server with the fields empty, and neither the page nor the
// reader is told. Measured directly: fields reporting `:autofill`, and
// `username=&password=` at the other end.
//
// So a button that would send such a form is pressed as a person presses it
// instead, at real coordinates. See core.activate.
function submitsAutofilled(el) {
  const form = el && (el.form || (el.closest && el.closest('form')));
  if (!form || !form.elements) return false;
  for (const field of form.elements) {
    for (const selector of [':autofill', ':-webkit-autofill']) {
      try {
        if (field.matches(selector)) return true;
      } catch { /* an engine that does not know this pseudo-class */ }
    }
  }
  return false;
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
//
// The point tested here has to be the point the click will land on, or the
// check answers about somewhere else. Both drivers aim at the middle of the
// element's *first* line box — Chromium through DOM.getContentQuads, which
// returns one quad per line, and Firefox through the WebDriver in-view centre
// point, which is defined on the first client rect. So this tests the first
// line box too, not the middle of getBoundingClientRect().
//
// The difference is the whole bug on bestmed.co.za, where a form is
//
//   <li><a href="...">Corporate Member Benefit Option Change Form</a></li>
//
// and the link text wraps onto two lines. getBoundingClientRect() unions the
// two line boxes into one 198x33 rectangle whose middle lies in the leading
// between the lines, where the <li> is what gets hit. Alt+D and the click key
// both refused the link — "is covered by <li>" — while the click they were
// guarding would have landed on the link's first line perfectly well.
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
      return { ok: true, x: Math.round(x), y: Math.round(y), placed: block };
    }

    blocked = { ok: false, reason: `is covered by ${name(chain[chain.length - 1])}`, covered: true };
  }

  return blocked || { ok: false, reason: 'could not be reached' };
}

module.exports = { clickThrough, prepareRealClick, submitsAutofilled };
