'use strict';

// Browser focus caused by one activation.
//
// A page can implement a skip link without a real fragment target: its click
// handler calls focus() on the destination instead. The URL then says nothing
// happened, while a graphical browser follows the new focus. Record focus
// immediately before the click so that stale browser focus cannot be mistaken
// for the result of the reader's Enter key. A focusin listener catches normal
// focused documents; polling activeElement also covers a browser on Xvfb whose
// document is visible but whose native window does not hold desktop focus.
function armFocusTracker(source, token) {
  const key = Symbol.for('tweb.activationFocus');
  const previous = window[key];
  if (previous && previous.listener) {
    document.removeEventListener('focusin', previous.listener, true);
  }

  const tracker = { token, source, before: document.activeElement, target: null, listener: null };
  tracker.listener = (event) => {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const target = path[0] || event.target;
    if (!target || !target.tagName) return;
    // A pointer activation ordinarily focuses the thing that was pressed.
    // That is not a destination and must not move the terminal reader.
    if (target === source || (source.contains && source.contains(target))) return;
    tracker.target = target;
  };
  document.addEventListener('focusin', tracker.listener, true);
  window[key] = tracker;
  return true;
}

function focusTrackerHasTarget(token) {
  const tracker = window[Symbol.for('tweb.activationFocus')];
  if (!tracker || tracker.token !== token) return false;

  const active = document.activeElement;
  if (active && active.tagName && active !== tracker.before
    && active !== tracker.source
    && !(tracker.source.contains && tracker.source.contains(active))) {
    tracker.target = active;
  }
  return !!tracker.target;
}

function takeFocusTrackerTarget(token) {
  const key = Symbol.for('tweb.activationFocus');
  const tracker = window[key];
  if (!tracker || tracker.token !== token) return document.documentElement;
  document.removeEventListener('focusin', tracker.listener, true);
  delete window[key];
  return tracker.target || document.documentElement;
}

function clearFocusTracker(token) {
  const key = Symbol.for('tweb.activationFocus');
  const tracker = window[key];
  if (!tracker || tracker.token !== token) return false;
  document.removeEventListener('focusin', tracker.listener, true);
  delete window[key];
  return true;
}

let focusSequence = 0;

async function armActivationFocus(scope, sourceHandle) {
  const token = `${process.pid}:${Date.now()}:${focusSequence += 1}`;
  await sourceHandle.evaluate(armFocusTracker, token);
  return { scope, token };
}

async function cancelActivationFocus(tracker) {
  if (!tracker) return false;
  return tracker.scope.evaluate(clearFocusTracker, tracker.token);
}

// Focus handlers are normally synchronous; CIBC's skip-to-banking link has
// already focused its destination when click() returns. A short bounded watch
// also covers handlers that defer focus through a microtask, animation frame,
// or transition. The serial key loop means no later key can be handled while
// this is pending, so an event in this window belongs to this activation.
async function focusedByActivation(tracker, { waitMs = 250, pollMs = 10 } = {}) {
  if (!tracker) return null;
  const { scope, token } = tracker;
  const deadline = Date.now() + waitMs;
  try {
    for (;;) {
      const found = await scope.evaluate(focusTrackerHasTarget, token);
      if (found) {
        const handle = await scope.evaluateHandle(takeFocusTrackerTarget, token);
        return { handle, frame: scope };
      }
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  } finally {
    await scope.evaluate(clearFocusTracker, token).catch(() => {});
  }
}

module.exports = {
  armActivationFocus, focusedByActivation, cancelActivationFocus,
  armFocusTracker, focusTrackerHasTarget, takeFocusTrackerTarget, clearFocusTracker,
};
