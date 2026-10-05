'use strict';

// A browser started on TAWB's private accessibility bus must still be able to
// reach the network.
//
//     TWEB_TEST_BROWSER=chromium node --test test/browser/a11y_net.test.js
//     TWEB_TEST_BROWSER=firefox  node --test test/browser/a11y_net.test.js
//
// On a machine with no desktop session, TAWB starts a session bus of its own
// and hands the browser DBUS_SESSION_BUS_ADDRESS and AT_SPI_BUS_ADDRESS. The
// machine's normal session configuration makes the desktop's services — a
// portal, dconf, GVfs, a keyring — activatable on that bus, and D-Bus's
// StartServiceByName blocks until the service has started or failed. A
// launcher that cannot come up on a terminal therefore wedges the browser
// before it sends its first request. The private bus is configured without
// those service directories; this proves a request actually arrives.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { tempDir, removeTempDir } = require('../tmpdir');
const { openDriver } = require('../../src/driver');

const ENGINE = process.env.TWEB_TEST_BROWSER || 'chromium';
const profile = tempDir('tweb-a11y-net-');
let driver;
let server;
let exportedBus;

test.before(async () => {
  // Force the private-bus path even on a machine that has a desktop session,
  // so this test exercises the case it exists for wherever it runs.
  exportedBus = process.env.DBUS_SESSION_BUS_ADDRESS;
  process.env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/tmp/tawb-a11y-net-no-such-bus';

  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>reached</title><p>hello</p>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  driver = await openDriver({ engine: ENGINE, profile, log: () => {} });
});

test.after(async () => {
  if (driver) await driver.close().catch(() => {});
  if (server) await new Promise((resolve) => server.close(resolve));
  if (exportedBus === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
  else process.env.DBUS_SESSION_BUS_ADDRESS = exportedBus;
  removeTempDir(profile);
});

test('a browser on a private accessibility bus reaches a loopback page', async () => {
  const page = driver.context.pages()[0] || await driver.context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'domcontentloaded' });
  assert.equal(await page.evaluate(() => document.title), 'reached');
  assert.equal(await page.evaluate(() => document.body.textContent.trim()), 'hello');
});
