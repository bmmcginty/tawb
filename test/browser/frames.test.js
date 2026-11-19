'use strict';

// Cross-origin frame handling against a real browser. Chromium gives the
// child a renderer and CDP target of its own; Firefox exposes it as a BiDi
// browsing context. Either way it must remain part of one readable page.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { tempDir, removeTempDir } = require('../tmpdir');
const { openDriver } = require('../../src/driver');
const { snapshotFrameTree } = require('../../src/frames');
const { Core } = require('../../src/core');

const ENGINE = process.env.TWEB_TEST_BROWSER || 'chromium';
const profile = tempDir('tweb-frames-');

let driver;
let parentServer;
let childServer;

function listen(server, host) {
  return new Promise((resolve) => server.listen(0, host, resolve));
}

async function closeServer(server) {
  if (server) await new Promise((resolve) => server.close(resolve));
}

test.after(async () => {
  if (driver) await driver.close().catch(() => {});
  await closeServer(parentServer);
  await closeServer(childServer);
  removeTempDir(profile);
});

test('a cross-origin iframe is read and activated through its own context', async () => {
  childServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>child</title>
      <p>Words from the other origin.</p>
      <button onclick="this.textContent = 'Pressed in the other origin'">Press child</button>`);
  });
  // An unspecified host accepts localhost on either loopback family. The
  // parent uses 127.0.0.1, making localhost a different site and therefore an
  // out-of-process iframe in Chromium rather than merely a different origin.
  await listen(childServer);

  parentServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (req.url === '/written') {
      res.end(`<!doctype html><title>written frame parent</title>
        <p>Before the frame</p>
        <iframe title="Email content" src="about:blank"></iframe>
        <p>After the frame</p>
        <script>
          const doc = document.querySelector('iframe').contentDocument;
          doc.open();
          doc.write('<!doctype html><p>Words written into a blank frame.</p>');
          doc.close();
        </script>`);
      return;
    }
    if (req.url === '/reordered') {
      // Move a still-connected iframe in the DOM. Firefox keeps the browsing
      // contexts in the order the frames were made, so the first element no
      // longer owns the first child context. Proton Mail does this to the
      // message pane, and pairing by position alone swapped the documents.
      res.end(`<!doctype html><title>reordered frames parent</title><body>
        <script>
          const make = (title) => {
            const frame = document.createElement('iframe');
            frame.title = title;
            frame.src = 'about:blank';
            document.body.appendChild(frame);
            return frame;
          };
          const first = make('first frame');
          const second = make('second frame');
          document.body.insertBefore(second, first);
          const write = (frame, text) => {
            const doc = frame.contentDocument;
            doc.open();
            doc.write('<!doctype html><p>' + text + '</p>');
            doc.close();
          };
          // Moving a connected frame can reset its document, so write after
          // the new order is in place.
          setTimeout(() => {
            write(second, 'Words in the second frame.');
            write(first, 'Words in the first frame.');
          }, 0);
        </script></body>`);
      return;
    }
    if (req.url === '/hidden') {
      res.end('<!doctype html><p>Hidden tracker document.</p>');
      return;
    }
    // More hidden children than the frame-reading budget come first. The
    // visible frame must be selected by its real element ordinal rather than
    // mistaken for the first tracker or dropped after the first 25 contexts.
    const hidden = Array.from({ length: 30 }, () =>
      '<iframe hidden src="/hidden"></iframe>').join('');
    res.end(`<!doctype html><title>parent</title><main inert><h1>Parent document</h1>
      ${hidden}</main>
      <iframe title="foreign frame" style="position:fixed; left:20px; top:20px; width:300px; height:150px"
        src="http://localhost:${childServer.address().port}/"></iframe>`);
  });
  await listen(parentServer, '127.0.0.1');

  driver = await openDriver({ engine: ENGINE, profile, log: () => {} });
  const page = driver.context.pages()[0] || await driver.context.newPage();
  await page.goto(`http://127.0.0.1:${parentServer.address().port}/`, {
    waitUntil: 'domcontentloaded',
  });

  let blocks = [];
  for (let tries = 0; tries < 20; tries += 1) {
    blocks = await snapshotFrameTree(page, 'ax', { driver });
    if (blocks.some((block) => block.text.includes('Words from the other origin.'))) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.ok(blocks.some((block) => block.text.includes('Words from the other origin.')),
    'the child document was not included in the page');
  assert.ok(!blocks.some((block) => block.text.includes('Hidden tracker document.')),
    'a hidden frame was read in place of the visible one');
  assert.ok(!blocks.some((block) => block.text.includes('Parent document')),
    'the page behind the modal frame was offered as interactive content');
  const button = blocks.find((block) => block.item && block.item.name === 'Press child');
  assert.ok(button, 'the child control was not included in the page');

  if (ENGINE === 'chromium') {
    assert.equal(button.item.frame.ownTarget(), true,
      'the cross-site child was not attached through its own CDP target');
  }

  const core = new Core({ driver, page, source: 'ax', sources: ['ax'] });
  await core.activate(button.item, page);
  blocks = await snapshotFrameTree(page, 'ax', { driver });
  assert.ok(blocks.some((block) => block.text.includes('Pressed in the other origin')),
    'activation did not reach the child document');
});

test('a document written into an about:blank frame is read', async () => {
  driver = driver || await openDriver({ engine: ENGINE, profile, log: () => {} });
  const page = driver.context.pages()[0] || await driver.context.newPage();
  await page.goto(`http://127.0.0.1:${parentServer.address().port}/written`, {
    waitUntil: 'domcontentloaded',
  });

  let blocks = [];
  for (let tries = 0; tries < 20; tries += 1) {
    blocks = await snapshotFrameTree(page, 'ax', { driver });
    if (blocks.some((block) => block.text.includes('Words written into a blank frame.'))) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const before = blocks.findIndex((block) => block.text.includes('Before the frame'));
  const inside = blocks.findIndex((block) => block.text.includes('Words written into a blank frame.'));
  const after = blocks.findIndex((block) => block.text.includes('After the frame'));
  assert.ok(inside > -1, 'the document written into the blank frame was not read');
  assert.ok(before > -1 && before < inside && inside < after,
    'the frame document was not spliced in where the frame sits');
});

test('a frame moved in the DOM is paired with the document it owns', async () => {
  driver = driver || await openDriver({ engine: ENGINE, profile, log: () => {} });
  const page = driver.context.pages()[0] || await driver.context.newPage();
  await page.goto(`http://127.0.0.1:${parentServer.address().port}/reordered`, {
    waitUntil: 'domcontentloaded',
  });

  let blocks = [];
  for (let tries = 0; tries < 20; tries += 1) {
    blocks = await snapshotFrameTree(page, 'ax', { driver });
    if (blocks.some((block) => block.text.includes('Words in the first frame.'))
      && blocks.some((block) => block.text.includes('Words in the second frame.'))) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const secondFrame = blocks.findIndex((block) => block.text.includes('frame: second frame'));
  const secondWords = blocks.findIndex((block) => block.text.includes('Words in the second frame.'));
  const firstFrame = blocks.findIndex((block) => block.text.includes('frame: first frame'));
  const firstWords = blocks.findIndex((block) => block.text.includes('Words in the first frame.'));
  assert.ok(secondFrame > -1 && secondWords > secondFrame,
    'the second frame lost its own document');
  assert.ok(firstFrame > secondWords && firstWords > firstFrame,
    'the first frame lost its own document');
});
