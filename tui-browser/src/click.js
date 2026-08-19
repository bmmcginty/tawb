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

module.exports = { clickThrough };
