'use strict';

// The session lists are Lynx's own (VLINKS and HISTORY), so their rules are
// tested here rather than through the terminal loop that happens to record
// them. Each behavior existed before they were moved into this module; these
// tests pin it at the new boundary.

const test = require('node:test');
const assert = require('node:assert');

const { VISITED_LIMIT, noteVisitedLink, notePageVisit } = require('../src/lynx_session');

test('a followed link is remembered once, at the top', () => {
  const state = {};
  noteVisitedLink(state, { name: 'Alpha', href: 'https://example.test/a' });
  noteVisitedLink(state, { name: 'Beta', href: 'https://example.test/b' });
  assert.deepEqual(state.visitedLinks.map((entry) => entry.name), ['Beta', 'Alpha']);
  // The same address followed again moves to the top rather than repeating.
  noteVisitedLink(state, { name: 'Alpha again', href: 'https://example.test/a' });
  assert.deepEqual(state.visitedLinks.map((entry) => entry.name), ['Alpha again', 'Beta']);
  assert.equal(state.visitedLinks.length, 2);
  // A link with no text of its own is named by where it goes.
  noteVisitedLink(state, { href: 'https://example.test/c' });
  assert.equal(state.visitedLinks[0].name, 'https://example.test/c');
});

test('a page visit updates in place rather than repeating', () => {
  const state = {};
  notePageVisit(state, 'https://example.test/a', 'Alpha');
  notePageVisit(state, 'https://example.test/b', 'Beta');
  assert.deepEqual(state.pageLog.map((entry) => entry.title), ['Beta', 'Alpha']);
  // Reading the same page again is not a new place to go back to.
  notePageVisit(state, 'https://example.test/b', 'Beta reloaded');
  assert.deepEqual(state.pageLog.map((entry) => entry.title), ['Beta reloaded', 'Alpha']);
  // A blank tab is not a document anybody wants listed.
  notePageVisit(state, 'about:blank', 'blank');
  assert.equal(state.pageLog.length, 2);
  // A page with no title is named by its address.
  notePageVisit(state, 'https://example.test/c', '');
  assert.equal(state.pageLog[0].title, 'https://example.test/c');
});

test('both lists stop at the session limit', () => {
  const state = {};
  for (let i = 0; i < VISITED_LIMIT + 10; i += 1) {
    noteVisitedLink(state, { name: `L${i}`, href: `https://example.test/l${i}` });
    notePageVisit(state, `https://example.test/p${i}`, `P${i}`);
  }
  assert.equal(state.visitedLinks.length, VISITED_LIMIT);
  assert.equal(state.pageLog.length, VISITED_LIMIT);
  // Newest first, so the limit drops the oldest rather than the newest.
  assert.equal(state.visitedLinks[0].name, `L${VISITED_LIMIT + 9}`);
  assert.equal(state.pageLog[0].title, `P${VISITED_LIMIT + 9}`);
  assert.equal(state.visitedLinks.at(-1).name, `L10`);
});
