'use strict';

// What the broker costs, and whether it works at all.
//
//   node tools/brokerbench.js
//
// Runs the same page and the same snapshot straight at Firefox and again
// through the broker, then puts two readers on one Firefox at once and takes
// one of them away. Measured while the broker was being written: a snapshot of
// 2401 items over a 97KB tree at 83ms direct and 82ms through the broker,
// against 90ms for a broker that parsed every message to find its id — which
// is why it reads only the head of a frame.

const fs = require('fs'); const os = require('os'); const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const R = require('path').join(__dirname, '..', 'src');
const { launchFirefox } = require(`${R}/firefox`);
const { openDriver } = require(`${R}/driver`);

const say = (m, v) => console.log(m + (v === undefined ? '' : ' ' + JSON.stringify(v)));
const stat = (xs) => {
  const sorted = [...xs].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    mean: +(sum / sorted.length).toFixed(3),
    median: +sorted[Math.floor(sorted.length / 2)].toFixed(3),
    p90: +sorted[Math.floor(sorted.length * 0.9)].toFixed(3),
  };
};

// A page with enough in it that a snapshot is real work.
function bigPage(n) {
  let html = '<!doctype html><meta charset="utf-8"><title>big</title><h1>A long document</h1>';
  for (let i = 0; i < n; i += 1) {
    html += `<section><h2>Section ${i}</h2><p>Paragraph ${i} with a <a href="/link${i}">link ${i}</a> `
      + `and a <button type="button">button ${i}</button> and some ordinary reading text.</p>`
      + `<ul><li>first of ${i}</li><li>second of ${i}</li></ul></section>`;
  }
  return html;
}

async function measure(label, driver, page, url) {
  await page.goto(url, { waitUntil: 'load' });
  const frame = page.mainFrame();
  for (let i = 0; i < 3; i += 1) await driver.axItems(frame); // warm

  const calls = [];
  for (let i = 0; i < 200; i += 1) {
    const t = process.hrtime.bigint();
    await page.evaluate(() => 1);
    calls.push(Number(process.hrtime.bigint() - t) / 1e6);
  }

  const snaps = [];
  let items = 0;
  for (let i = 0; i < 15; i += 1) {
    const t = process.hrtime.bigint();
    const got = await driver.axItems(frame);
    snaps.push(Number(process.hrtime.bigint() - t) / 1e6);
    items = (got || []).length;
  }
  const bytes = JSON.stringify(await driver.axItems(frame) || []).length;
  return { label, call: stat(calls), snapshot: stat(snaps), items, kb: Math.round(bytes / 1024) };
}

function startBroker(upstream, peek) {
  return new Promise((resolve, reject) => {
    const args = [require('path').join(__dirname, '..', 'src', 'broker.js'), upstream, '0'];
    const child = spawn('node', args, { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const line = out.split('\n').find((l) => l.includes('"ready"'));
      if (line) { const { port } = JSON.parse(line); resolve({ child, port }); }
    });
    setTimeout(() => reject(new Error('broker did not start')), 8000);
  });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tweb-broker-'));
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(bigPage(200));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const started = await launchFirefox({ profileDir: dir, log: () => {} });
  say('firefox up', { port: started.port });
  const results = [];
  try {
    // Straight at Firefox, as today.
    {
      const driver = await openDriver({ engine: 'firefox', connect: started.endpoint, profile: dir, log: () => {} });
      const page = driver.context.pages()[0] || await driver.context.newPage();
      results.push(await measure('direct', driver, page, url));
      await driver.close();
    }
    // And through the broker.
    {
      const broker = await startBroker(started.endpoint, true);
      const driver = await openDriver({
        engine: 'firefox', connect: `ws://127.0.0.1:${broker.port}/session`, profile: dir, log: () => {},
      });
      const page = driver.context.pages()[0] || await driver.context.newPage();
      results.push(await measure('through the broker', driver, page, url));
      await driver.close();
      broker.child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 300));
    }

    // The point of the exercise: two readers at once on one Firefox.
    {
      const broker = await startBroker(started.endpoint, true);
      const base = `ws://127.0.0.1:${broker.port}/session`;
      const one = await openDriver({ engine: 'firefox', connect: base, profile: dir, log: () => {} });
      const two = await openDriver({ engine: 'firefox', connect: base, profile: dir, log: () => {} });
      const tabOne = await one.context.newPage();
      const tabTwo = await two.context.newPage();
      await tabOne.goto(`${url}?one`, { waitUntil: 'load' });
      await tabTwo.goto(`${url}?two`, { waitUntil: 'load' });
      const titles = [
        await tabOne.mainFrame().evaluate(() => location.search),
        await tabTwo.mainFrame().evaluate(() => location.search),
      ];
      const ids = [await one.targetIdFor(tabOne), await two.targetIdFor(tabTwo)];
      say('two readers, one Firefox', { titles, distinctTabs: ids[0] !== ids[1] });
      // One leaving must not take the browser from the other.
      await one.close();
      const stillThere = await tabTwo.mainFrame().evaluate(() => location.search).catch((e) => 'LOST: ' + e.message.slice(0, 50));
      say('after the first reader quit, the second', { sees: stillThere });
      await two.close().catch(() => {});
      broker.child.kill('SIGTERM');
    }
  } finally {
    console.log('');
    for (const r of results) {
      say(r.label.padEnd(30), { callMs: r.call, snapshotMs: r.snapshot, items: r.items, treeKb: r.kb });
    }
    server.close();
    try { started.child.kill(); } catch {}
    setTimeout(() => process.exit(0), 500);
  }
})();
