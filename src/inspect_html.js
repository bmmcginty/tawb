'use strict';

const { buildBlocks } = require('./blocks');

// Accessibility semantics and the node that produced them, on one line.
// This is deliberately derived from the exact items AX view uses rather than
// walking a second tree and trying to align the two afterwards.
function inspectBlocks(items, frame) {
  const blocks = [];
  for (const item of items || []) {
    if (!item || item.role === '__break__') continue;
    const semantic = buildBlocks([item])[0];
    if (!semantic) continue;
    const markup = item.markup || '<generated-accessibility-node>';
    const origin = item.shadow ? ` #${item.shadow}-shadow-root` : '';
    const nested = item.nestedIn ? ` — focusable inside ${item.nestedIn}` : '';
    blocks.push({
      ...semantic,
      text: `${semantic.text}    ${markup}${origin}${nested}`,
      item: { ...item, frame },
    });
  }
  return blocks;
}

module.exports = { inspectBlocks };
