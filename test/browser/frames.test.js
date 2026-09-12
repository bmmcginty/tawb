'use strict';

// Cross-origin frame handling against a real browser. Chromium gives the
// child a renderer and CDP target of its own; Firefox exposes it as a BiDi
// browsing context. Either way it must remain part of one readable page.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');

const { tempDir } = require('../tmpdir');
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
  fs.rmSync(profile, {
    recursive: true, force: true, maxRetries: 5, retryDelay: 100,
  });
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
    res.end(`<!doctype html><title>parent</title><h1>Parent document</h1>
      <iframe title="foreign frame" src="http://localhost:${childServer.address().port}/"></iframe>`);
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
