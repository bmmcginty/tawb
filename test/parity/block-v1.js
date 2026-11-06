'use strict';

// Complete extraction-block observation shared by real-browser parity tests.
// Protocol frame objects are runtime-owned handles, so their identity is
// normalized to presence. Every other item field is retained recursively;
// adding extractor metadata therefore changes this contract automatically
// instead of disappearing behind a hand-picked comparison.

function normalize(value, key = '') {
  if (key === 'frame' || key === 'pressFrame') return value == null ? null : true;
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map((entry) => normalize(entry));
  if (typeof value === 'object') {
    const answer = {};
    // Extractor converters represent an absent optional field as undefined,
    // null, or no key depending on protocol. Normalize those empty forms
    // without dropping any concrete value.
    for (const name of Object.keys(value).sort()) {
      if (value[name] != null) answer[name] = normalize(value[name], name);
    }
    return answer;
  }
  return value;
}

function firstDifference(actual, expected, at = '$') {
  if (Object.is(actual, expected)) return null;
  if (actual === null || expected === null
      || typeof actual !== 'object' || typeof expected !== 'object') {
    return { at, actual, expected };
  }
  if (Array.isArray(actual) !== Array.isArray(expected)) return { at, actual, expected };
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (!Object.is(actualKeys.join('\0'), expectedKeys.join('\0'))) {
    const actualOnly = {};
    const expectedOnly = {};
    for (const key of actualKeys) {
      if (!expectedKeys.includes(key)) actualOnly[key] = actual[key];
    }
    for (const key of expectedKeys) {
      if (!actualKeys.includes(key)) expectedOnly[key] = expected[key];
    }
    return { at, actualOnly, expectedOnly, actualKeys, expectedKeys };
  }
  for (const key of actualKeys) {
    const difference = firstDifference(actual[key], expected[key], `${at}.${key}`);
    if (difference) return difference;
  }
  return null;
}

function blockV1(block) {
  const own = (name) => Object.prototype.hasOwnProperty.call(block, name);
  return {
    kind: own('kind') ? normalize(block.kind) : null,
    text: own('text') ? normalize(block.text) : null,
    startsBlock: own('startsBlock') ? normalize(block.startsBlock) : null,
    isParagraph: own('isParagraph') ? normalize(block.isParagraph) : null,
    spans: own('spans') ? normalize(block.spans) : null,
    item: own('item') ? normalize(block.item) : null,
  };
}

module.exports = { blockV1, firstDifference };
