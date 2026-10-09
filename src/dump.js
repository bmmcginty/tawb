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
const { lynxBlocks, lynxRowText } = require('./lynx_display');
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

// The top document's DOMContentLoaded says nothing about the documents
// embedded in it. A child frame commits after the parent has parsed the
// <iframe> — an out-of-process one starts a renderer to do it, which on a
// busy machine can still be pending when the frame walk asks — and a child
// still on about:blank reads as an empty document. The interactive reader
// re-renders as pages change, so a frame that missed the first picture
// arrives with the next; a dump runs once, and there is no later re-render
// to mend it. So the dump gives the embedded documents a bounded chance to
// arrive: poll until no child frame is a placeholder, the top document
// reports itself complete — a document is not complete while anything
// embedded in it still loads — or two seconds pass. A placeholder that is
// going nowhere is covered by the document completing, which it does as
// soon as such a frame's own (empty) document does; the deadline is for a
// page that hangs.
const SETTLE_DEADLINE_MS = 2000;
const SETTLE_STEP_MS = 50;

function placeholderUrl(url) {
  return !url || url === 'about:blank';
}

// The children the walk will descend into, and whether any of them is still
// a placeholder. Direct children only: a grandchild of a freshly committed
// child is reached only after the walk has spent its round trips on the
// parent, and its own document reports complete only once every frame below
// it is done.
async function pendingChildFrames(frame) {
  let children;
  try {
    children = await frame.childFrames();
  } catch {
    return false; // the frame went away mid-settle; let the walk decide
  }
  if (!Array.isArray(children)) return false;
  return children.some((child) => {
    let url = '';
    try { url = child.url() || ''; } catch { url = ''; }
    return placeholderUrl(url);
  });
}

async function topDocumentComplete(page) {
  try {
    return (await page.evaluate(() => document.readyState)) === 'complete';
  } catch {
    return false; // not answerable is not complete; the deadline decides
  }
}

async function settleEmbeddedFrames(page, {
  deadlineMs = SETTLE_DEADLINE_MS, stepMs = SETTLE_STEP_MS,
} = {}) {
  // A page without the frame surface — the tests' fakes, a driver yet to
  // grow one — has nothing to wait for that this can see.
  if (typeof page.mainFrame !== 'function') return;
  for (const deadline = Date.now() + deadlineMs; Date.now() < deadline;) {
    if (!await pendingChildFrames(page.mainFrame())) return;
    if (await topDocumentComplete(page)) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

// The Lynx presentation as plain lines: the same renderLynxItem vocabulary,
// numbering, joined prose and laid-out table columns the full-screen reader
// shows, with the terminal's own styling left out because there is no
// terminal. lynxRowText is the same row composition renderLynxRow uses, so
// the two presentations cannot disagree about where the margin or a marker
// goes.
function formatLynxBlocks(blocks, { preferences = {}, escapeUnicode = false, width = 80 } = {}) {
  if (!blocks.length) return '';
  const transform = escapeUnicode ? escapeNonAscii : String;
  const lines = layoutLines(lynxBlocks(blocks, preferences, transform), width);
  return lines.map((line) => lynxRowText(line, line.text)).join('\n') + '\n';
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
    await settleEmbeddedFrames(page);
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

module.exports = {
  resolveDumpTarget, formatAxBlocks, formatLynxBlocks, dumpAx, settleEmbeddedFrames,
};
