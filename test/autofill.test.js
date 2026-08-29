'use strict';

// A field the browser filled in itself.
//
// Both engines fill a saved sign-in visually and keep the value from page
// script until a person interacts with the page — which is what stops a
// hostile page reading a credential the reader never meant to give it. Two
// consequences follow, and both are the reader's problem rather than the
// page's: the field reads as empty when it is not, and a form submitted
// without a real press arrives at the server with those fields empty.

const test = require('node:test');
const assert = require('node:assert');

const { renderLine } = require('../src/aria');
const { submitsAutofilled } = require('../src/click');

// An element as much as these functions need of one.
function field({ autofill = false, prefixed = false, known = [':autofill', ':-webkit-autofill'] } = {}) {
  return {
    matches(selector) {
      if (!known.includes(selector)) throw new Error(`unknown pseudo-class ${selector}`);
      if (selector === ':autofill') return autofill;
      return prefixed;
    },
  };
}

function form(fields) {
  const shape = { elements: fields };
  return { form: shape, closest: () => shape };
}

test('a filled field says so, because it reads as empty and is not', () => {
  assert.equal(
    renderLine({ role: 'textbox', name: 'Password', autofilled: true }),
    '[Password: filled by the browser]',
  );
  // Nothing invented where the browser has not filled anything.
  assert.equal(renderLine({ role: 'textbox', name: 'Password' }), '[Password]');
  // A value the page did put there is the reader's own text and wins.
  assert.equal(
    renderLine({ role: 'textbox', name: 'Search', value: 'braille' }),
    '[Search: braille]',
  );
});

test('a button that would send a remembered sign-in is recognised', () => {
  const filled = form([field({ autofill: true }), field()]);
  assert.equal(submitsAutofilled(filled), true);

  // Chromium's older prefixed spelling answers too, for a build that knows
  // only that one.
  const prefixedOnly = form([field({ prefixed: true, known: [':-webkit-autofill'] })]);
  assert.equal(submitsAutofilled(prefixedOnly), true);

  // An ordinary form the reader filled in themselves is left alone: pressing
  // it needs no mouse, and a real click can fail where the default action
  // cannot.
  assert.equal(submitsAutofilled(form([field(), field()])), false);

  // An engine that knows neither spelling throws rather than answering, and
  // that must not take the activation with it.
  assert.equal(submitsAutofilled(form([field({ known: [] })])), false);

  // Something that is in no form at all.
  assert.equal(submitsAutofilled({ closest: () => null }), false);
  assert.equal(submitsAutofilled(null), false);
});
