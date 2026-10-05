'use strict';

// The arithmetic behind Lynx's number prompt, kept apart from the terminal
// prompt itself. Nothing here reads or writes the screen: it turns the text a
// reader has typed into a command, and works out which number a relative step
// (`+`, `-`) lands on. Keeping it pure is what lets the prompt's editing be
// tested without a terminal, and keeps Lynx's numbering out of the render loop.

// A number prompt accepts a count, an optional command suffix, and an optional
// sign, in either order: `12`, `3p`, `2+p`, `2p-`, `4-g`. `p` asks for a page
// rather than a link, `g` moves without activating, and a sign steps relative
// to the number the reader is standing on.
function parseLynxNumberExpression(text) {
  const match = /^(\d+)([gGpP]?)([+-]?)$/.exec(text)
    || /^(\d+)([+-])([gGpP]?)$/.exec(text);
  if (!match) return null;
  const [, digits, first = '', second = ''] = match;
  const suffixes = first + second;
  const command = /[pP]/.test(suffixes) ? 'page'
    : /[gG]/.test(suffixes) ? 'move' : 'follow';
  const relative = suffixes.includes('+') ? 1 : suffixes.includes('-') ? -1 : 0;
  return { number: Number(digits), command, relative };
}

// Which number a relative step lands on, measured from the numbered item that
// is on the reader's own line or the nearest one before it. On a composite
// line several numbers can share a row, so the column breaks the tie that the
// line alone cannot. With nothing before the reader, forward counts from zero
// and backward counts down from the first target, which is Lynx's own answer.
function relativeLinkNumber(prompt, amount, direction) {
  const targets = prompt.targets || [];
  const before = targets.filter((target) => target.line < prompt.cursor
    || (target.line === prompt.cursor && (target.col || 0) <= (prompt.col || 0)));
  const current = before.at(-1);
  if (current && current.line === prompt.cursor) return current.number + (direction * amount);
  if (direction > 0) return (current ? current.number : 0) + amount;
  if (current) return current.number + 1 - amount;
  return targets.length ? targets[0].number - amount : -1;
}

module.exports = { parseLynxNumberExpression, relativeLinkNumber };
