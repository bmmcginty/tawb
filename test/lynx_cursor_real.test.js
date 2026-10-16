'use strict';

// Where real Lynx starts reading a fresh document.
//
// TAWB has header rows Lynx does not, so physical row equality is not the
// contract. The semantic current item is: the first Down must leave from the
// same link in both programs. SHOW_CURSOR makes Lynx expose that item through
// the terminal cursor rather than only through reverse video.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { tempDir, removeTempDir } = require('./tmpdir');
const { LynxTty, available } = require('./lynx_tty');

const skip = available() ? false : 'needs both lynx and tmux';
const root = skip ? null : tempDir('tawb-real-lynx-cursor-');
const page = skip ? null : path.join(root, 'page.html');

if (!skip) {
  fs.writeFileSync(page, [
    '<!doctype html><title>Initial placement</title>',
    '<h1>Page heading</h1>',
    '<p>Static introduction before any controls.</p>',
    '<a href="destination.html">first link</a>',
    '<a href="destination.html#second">second link</a>',
  ].join('\n'));
}

test.after(() => {
  if (!skip) removeTempDir(root);
});

test('real Lynx starts a fresh document on its first focusable item',
  { skip }, async () => {
    const tty = new LynxTty({
      session: `tawb-real-lynx-cursor-${process.pid}`,
      home: root,
      page,
      extraArgs: ['-show_cursor'],
    });
    try {
      await tty.start({ ready: 'first link' });
      const cursor = tty.cursor();
      assert.match(tty.line(cursor.y), /first link/,
        `Lynx put its cursor on: ${tty.line(cursor.y).trim()}`);
      assert.doesNotMatch(tty.line(cursor.y), /Page heading|Static introduction/);
    } finally {
      tty.stop();
    }
  });
