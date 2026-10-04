'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const { CdpPage } = require('../src/cdp_page');
const { FirefoxPage } = require('../src/driver_firefox');

test('Chromium receives ignoreCache for a Lynx no-cache reload', async () => {
  const session = new EventEmitter();
  const sent = [];
  session.send = async (method, params) => {
    sent.push({ method, params });
    if (method === 'Page.reload') {
      queueMicrotask(() => session.emit('Page.lifecycleEvent', {
        frameId: 'main', name: 'DOMContentLoaded',
      }));
    }
    return {};
  };
  const page = new CdpPage({}, session, 'target');
  page.mainFrameId = 'main';
  await page.reload({ waitUntil: 'domcontentloaded', ignoreCache: true, timeout: 1000 });
  assert.deepEqual(sent.find((call) => call.method === 'Page.reload').params,
    { ignoreCache: true });
});

test('Firefox receives ignoreCache for a Lynx no-cache reload', async () => {
  const sent = [];
  const session = {
    async send(method, params) { sent.push({ method, params }); return {}; },
  };
  const page = new FirefoxPage(session, 'context', {});
  await page.reload({ waitUntil: 'domcontentloaded', ignoreCache: true });
  assert.deepEqual(sent.find((call) => call.method === 'browsingContext.reload').params, {
    context: 'context', wait: 'interactive', ignoreCache: true,
  });
});
