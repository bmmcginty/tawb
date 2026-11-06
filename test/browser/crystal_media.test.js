'use strict';

// A direct audio response is not an authored HTML player. Firefox creates a
// top-level media document whose Play, Position, Mute and Volume controls live
// entirely in a user-agent shadow root. Difference the JavaScript and native
// Firefox cores on that exact route, including operations: matching labels
// alone would not prove that the returned descriptors still reach controls.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { openDriver } = require('../../src/driver');
const { Core } = require('../../src/core');
const { processesUsing } = require('../../src/proc');
const { callAsync } = require('../crystal_impl');
const { tempDir, removeTempDir } = require('../tmpdir');

const enabled = process.env.TAWB_TEST_CRYSTAL_BROWSER === '1';
const fixture = (name) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', name));
const SCENARIOS = [
  {
    name: 'direct Ogg audio', path: 'stream.ogg', type: 'audio/ogg',
    body: fixture('direct-audio.ogg'), stream: false,
  },
  {
    name: 'direct WebM video', path: 'movie.webm', type: 'video/webm',
    body: fixture('direct-video.webm'), stream: false,
  },
  {
    name: 'long chunked Ogg audio', path: 'long.ogg', type: 'audio/ogg',
    body: fixture('streaming-audio.ogg'), stream: true,
  },
];

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function stopProfile(profile) {
  for (const pid of processesUsing(profile)) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
}

async function javascriptScenario(profile, url) {
  const driver = await openDriver({ engine: 'firefox', profile, log: () => {} });
  const page = driver.context.pages()[0] || await driver.context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const media = document.querySelector('video,audio');
      return media && Number.isFinite(media.duration) && media.duration > 1;
    }, null, { timeout: 5000 });
    await page.evaluate(() => {
      const media = document.querySelector('video,audio');
      media.pause();
      media.currentTime = 1;
    });

    const core = new Core({ driver, page, source: 'ax', sources: ['ax', 'source'] });
    const blocks = await core.rescan({ page });
    const controls = blocks.filter((block) => block.item?.nativeControl);
    const toggle = controls.find((block) => block.item.role === 'button'
      && /mute/i.test(block.item.name));
    const position = controls.find((block) => block.item.role === 'slider'
      && /position|time scrubber/i.test(block.item.name));

    let muteToggled = false;
    let muteStatus = 'missing';
    if (toggle) {
      const before = await page.evaluate(() => document.querySelector('video,audio').muted);
      const activated = await core.activate(toggle.item, page);
      muteStatus = activated.status || 'pressed';
      const after = await page.evaluate(() => document.querySelector('video,audio').muted);
      muteToggled = before !== after;
    }

    let positionFocused = false;
    let positionMoved = false;
    if (position) {
      await page.evaluate(() => { document.querySelector('video,audio').currentTime = 1; });
      const before = await page.evaluate(() => document.querySelector('video,audio').currentTime);
      positionFocused = await core.focusControl(position.item, page);
      if (positionFocused) await core.adjustControl(position.item, 'ArrowRight', page);
      const after = await page.evaluate(() => document.querySelector('video,audio').currentTime);
      positionMoved = before !== after;
    }

    core.source = 'source';
    const source = (await core.rescan({ page })).map((block) => block.text).join('\n');
    return {
      controls: controls.map((block) => ({ role: block.item.role, name: block.item.name })),
      muteToggled,
      muteStatus,
      positionFocused,
      positionMoved,
      sourceHasUserAgent: source.includes('#user-agent-shadow-root'),
      sourceHasControls: source.includes('<native-control'),
    };
  } finally {
    await driver.close().catch(() => {});
  }
}

for (const scenario of SCENARIOS) {
  test(`native Firefox exposes and operates controls in ${scenario.name}`,
    { skip: !enabled }, async () => {
      const root = tempDir('tawb-crystal-media-');
      const nativeProfile = path.join(root, 'native');
      const javascriptProfile = path.join(root, 'javascript');
      const server = http.createServer((_request, response) => {
        const headers = {
          'content-type': scenario.type,
          'cache-control': 'no-store',
        };
        if (!scenario.stream) headers['content-length'] = scenario.body.length;
        response.writeHead(200, headers);
        if (!scenario.stream) {
          response.end(scenario.body);
          return;
        }
        let offset = 0;
        const send = () => {
          if (response.destroyed) return;
          const next = Math.min(offset + 256, scenario.body.length);
          response.write(scenario.body.subarray(offset, next));
          offset = next;
          if (offset === scenario.body.length) response.end();
          else setTimeout(send, 10);
        };
        send();
      });
      await listen(server);
      const url = `http://127.0.0.1:${server.address().port}/${scenario.path}`;

      try {
        const javascript = await javascriptScenario(javascriptProfile, url);
        const crystal = await callAsync('core.media_scenario', {
          profile: nativeProfile,
          url,
        }, { timeoutMs: 120000 });

        assert.deepEqual(crystal, javascript, 'native media handling differs from JavaScript');
        assert.ok(crystal.controls.some((control) => control.role === 'button'
          && /play|pause/i.test(control.name)), 'the browser play control is absent');
        assert.ok(crystal.controls.some((control) => control.role === 'button'
          && /mute/i.test(control.name)), 'the browser mute control is absent');
        assert.ok(crystal.controls.some((control) => control.role === 'slider'
          && /position|time scrubber/i.test(control.name)), 'the browser position control is absent');
        assert.ok(crystal.controls.some((control) => control.role === 'slider'
          && /volume/i.test(control.name)), 'the browser volume control is absent');
        assert.equal(crystal.muteToggled, true, 'Mute did not operate the stream');
        assert.equal(crystal.positionFocused, true, 'the position slider could not be focused');
        assert.equal(crystal.positionMoved, true, 'ArrowRight did not move the position slider');
        assert.equal(crystal.sourceHasUserAgent, true, 'SOURCE omitted the user-agent root');
        assert.equal(crystal.sourceHasControls, true, 'SOURCE omitted native media controls');
      } finally {
        stopProfile(nativeProfile);
        stopProfile(javascriptProfile);
        await closeServer(server);
        removeTempDir(root);
      }
    });
}
