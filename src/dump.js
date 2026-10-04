'use strict';

// The non-interactive front end. It deliberately owns no terminal: stdout is
// only the AX text, so a pager or mailcap consumer can treat it as ordinary
// copious output.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { resolveAddress, DEFAULT_SEARCH } = require('./address');
const { snapshotFrameTree } = require('./frames');
const { escapeNonAscii } = require('./unicode_escape');

// Mailcap's %s is a filesystem path, not a file: URL. Prefer an existing path
// before applying the address-bar rules; otherwise a relative file such as
// message.html looks exactly like a host name and is sent to https instead.
function resolveDumpTarget(input, {
  cwd = process.cwd(),
  exists = fs.existsSync,
  search = DEFAULT_SEARCH,
} = {}) {
  const wanted = String(input || '').trim();
  if (!wanted) throw new Error('--dump needs a URL or HTML file');

  const local = path.resolve(cwd, wanted);
  if (exists(local)) return pathToFileURL(local).href;

  const resolved = resolveAddress(wanted, { search });
  if (resolved.error) throw new Error(resolved.error);
  return resolved.url;
}

function formatAxBlocks(blocks, { escapeUnicode = false } = {}) {
  if (!blocks.length) return '';
  const text = blocks.map((block) => String(block.text ?? ''));
  return text.map((line) => (escapeUnicode ? escapeNonAscii(line) : line)).join('\n') + '\n';
}

async function dumpAx({
  driver,
  target,
  escapeUnicode = false,
  write = (text) => process.stdout.write(text),
  snapshot = snapshotFrameTree,
}) {
  const page = await driver.context.newPage();
  try {
    await page.goto(target, { waitUntil: 'domcontentloaded' });
    const blocks = await snapshot(page, 'ax', { driver });
    const output = formatAxBlocks(blocks, { escapeUnicode });
    if (output) write(output);
  } finally {
    // A kept or externally managed browser must not collect one mail-viewing
    // tab per invocation. Closing our own tab is safe even when the browser
    // itself belongs to somebody else.
    await page.close().catch(() => {});
  }
}

module.exports = { resolveDumpTarget, formatAxBlocks, dumpAx };
