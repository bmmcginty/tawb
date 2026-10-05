'use strict';

// The non-interactive front end. It deliberately owns no terminal: stdout is
// only page text, so a pager or mailcap consumer can treat it as ordinary
// copious output. Which text is the front end's to decide — the ordinary one
// prints the AX blocks as they read, and the Lynx front end prints the same
// Lynx presentation the full-screen reader would show.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { resolveAddress, DEFAULT_SEARCH } = require('./address');
const { snapshotFrameTree } = require('./frames');
const { layoutLines } = require('./layout');
const { lynxBlocks } = require('./lynx_display');
const { needsLayoutMetadata } = require('./interfaces');
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

// The Lynx presentation as plain lines: the same renderLynxItem vocabulary,
// numbering, joined prose and laid-out table columns the full-screen reader
// shows, with the terminal's own styling left out because there is no
// terminal. The margin, the marker and any suffix are display metadata, so
// they are put back exactly where renderLynxRow would put them.
function formatLynxBlocks(blocks, { preferences = {}, escapeUnicode = false, width = 80 } = {}) {
  if (!blocks.length) return '';
  const transform = escapeUnicode ? escapeNonAscii : String;
  const lines = layoutLines(lynxBlocks(blocks, preferences, transform), width);
  const text = lines.map((line) => ' '.repeat(line.displayIndent || 0)
    + (line.displayPrefix || '') + line.text + (line.displaySuffix || ''));
  return text.join('\n') + '\n';
}

async function dumpAx({
  driver,
  target,
  frontEnd = 'default',
  preferences = {},
  escapeUnicode = false,
  width = 80,
  write = (text) => process.stdout.write(text),
  snapshot = snapshotFrameTree,
}) {
  const page = await driver.context.newPage();
  try {
    await page.goto(target, { waitUntil: 'domcontentloaded' });
    // Only the Lynx display reads the extractor's inline-flow and table-cell
    // metadata, so only that front end asks for it. See needsLayoutMetadata.
    const blocks = await snapshot(page, 'ax', {
      driver, layout: needsLayoutMetadata(frontEnd),
    });
    const output = frontEnd === 'lynx'
      ? formatLynxBlocks(blocks, { preferences, escapeUnicode, width })
      : formatAxBlocks(blocks, { escapeUnicode });
    if (output) write(output);
  } finally {
    // A kept or externally managed browser must not collect one mail-viewing
    // tab per invocation. Closing our own tab is safe even when the browser
    // itself belongs to somebody else.
    await page.close().catch(() => {});
  }
}

module.exports = { resolveDumpTarget, formatAxBlocks, formatLynxBlocks, dumpAx };
