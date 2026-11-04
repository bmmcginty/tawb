'use strict';

// A live region the reader did not get to hear.
//
// A polite announcement must not shout over an error, so while the status row
// is owned by something else it waits. What it must not do is wait forever:
// the row is cleared by the next keystroke, and an announcement that is still
// sitting in the queue when that happens was announced to nobody.
//
// This is the decision that drains it, exercised without a page or a browser.

const test = require('node:test');
const assert = require('node:assert');

const {
  nextPendingAnnouncement, drainPendingAnnouncements,
} = require('../src/index');

function stateWith(queue, { statusMsg = '', heldUntil = 0 } = {}) {
  return {
    mode: 'browse',
    statusMsg,
    statusHeldUntil: heldUntil,
    messages: [],
    drawn: {},
    core: { live: { queue }, page: { url: () => 'https://example.test/' } },
  };
}

function capturingTerminal(fn) {
  const write = process.stdout.write;
  const chunks = [];
  process.stdout.write = (text) => { chunks.push(String(text)); return true; };
  try { fn(); } finally { process.stdout.write = write; }
  return chunks.join('');
}

test('a queue that is empty has nothing to say', () => {
  const state = stateWith([]);
  assert.equal(nextPendingAnnouncement(state), null);
  assert.equal(capturingTerminal(() => drainPendingAnnouncements(state)), '');
});

test('a message still inside its hold is not shouted over', () => {
  const now = 1000;
  const state = stateWith([{ politeness: 'polite', text: 'Two results' }], {
    statusMsg: 'Could not read bookmarks.', heldUntil: now + 4000,
  });
  assert.equal(nextPendingAnnouncement(state, now), null);
  assert.equal(state.core.live.queue.length, 1, 'it waits rather than being dropped');
});

test('the message surfaces as soon as the hold has passed', () => {
  const now = 10_000;
  const state = stateWith([{ politeness: 'polite', text: 'Two results' }], {
    statusMsg: 'Could not read bookmarks.', heldUntil: now - 1,
  });
  const item = nextPendingAnnouncement(state, now);
  assert.deepEqual(item, { politeness: 'polite', text: 'Two results' });
  assert.equal(state.core.live.queue.length, 0, 'it is taken out of the queue');
});

test('the keystroke that clears the row is what lets it be said', () => {
  const state = stateWith([{ politeness: 'polite', text: 'Two results' }], {
    statusMsg: 'Bookmark removed.', heldUntil: Date.now() + 4000,
  });
  assert.equal(drainPendingAnnouncements(state), false, 'the row is still owned');

  // beginKeystroke() is what a keystroke does to the row.
  state.statusMsg = '';
  const painted = capturingTerminal(() => assert.equal(drainPendingAnnouncements(state), true));
  assert.match(painted, /Two results/, 'the waiting announcement reached the row');
  assert.equal(state.statusMsg, 'Two results');
  assert.equal(state.core.live.queue.length, 0);
});

test('one is said at a time, and the rest wait their turn', () => {
  const state = stateWith([
    { politeness: 'polite', text: 'One result' },
    { politeness: 'polite', text: 'Two results' },
  ]);
  const said = [];
  const write = process.stdout.write;
  process.stdout.write = (text) => { said.push(String(text)); return true; };
  try {
    assert.equal(drainPendingAnnouncements(state), true);
  } finally {
    process.stdout.write = write;
  }
  assert.match(said.join(''), /One result/);
  assert.equal(state.statusMsg, 'One result', 'the older announcement is said first');
  assert.equal(state.core.live.queue.length, 1, 'the newer one is still waiting');

  // The hold the first one took is why the second did not overtake it.
  assert.equal(nextPendingAnnouncement(state, Date.now() + 1000), null);
});
