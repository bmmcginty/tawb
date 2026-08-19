'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { extractForEdbrowse, resolveDescriptor, applyFieldValues } = require('./edb_page');
const { clickThrough, prepareRealClick } = require('./click');
const { snapshotFrameTree } = require('./frames');
const { log } = require('./log');

// Serving the live browser to edbrowse, over http on the loopback address.
//
// edbrowse renders html and drives forms better than a line list ever will,
// and it is an editor as well as a browser. What it cannot do is run a page:
// its javascript engine is not a browser engine, and the sites that matter
// are applications. So we run the page in a real browser, as always, and
// hand edbrowse the result as ordinary html from an ordinary http origin.
//
// http rather than a protocol plugin, for a reason that is not aesthetic:
// edbrowse refuses to submit a form to any protocol but http, https, gopher
// and mailto (its html.c, "cannot submit using protocol %s"), so a plugin
// can show a page but never fill one in. Over http, every part of edbrowse
// works with no special cases — g, i=, i*, ib, A, rf and the back key.
//
// Two rules make refresh behave. Anything that acts on the page answers 302
// back to the tab's own url, so the buffer never holds an address that would
// re-click a button when the reader types rf; and every response says
// no-cache, because edbrowse caches and rf would otherwise hand back the
// render before last.

const HOST = '127.0.0.1';
const SETTLE_MS = 600;          // let a click's consequences begin before rendering
const NAVIGATION_WATCH_MS = 1500; // how long a click gets to turn into a navigation
const ACTION_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------
// Element identity
//
// An id names a descriptor: a path through the document, the tag, the
// accessible name, the position in document order. The registry only
// remembers which descriptor got which number, so the same element keeps its
// id across renders and a link in a buffer from ten minutes ago still means
// what it said. Resolution happens in the page, from the descriptor alone
// (edb_page.js), so nothing here is load-bearing state: another process with
// a connection to the browser could resolve the same id.
// ---------------------------------------------------------------------------

class Registry {
  constructor() {
    this.byKey = new Map();
    this.byId = new Map();
    this.next = 1;
  }

  // `kind` is how this id will be used from the other side — a control to
  // press, a field to fill, a form, a frame — because a form submission
  // arrives as names and values with nothing to say which was which.
  idFor(desc, kind = 'control') {
    const key = `${desc.tag}|${desc.path}|${desc.name}`;
    let id = this.byKey.get(key);
    if (id == null) {
      id = this.next;
      this.next += 1;
      this.byKey.set(key, id);
    }
    // Keep the freshest ordinal: it is what picks between duplicates when
    // the path has stopped matching.
    this.byId.set(id, { desc, kind });
    return id;
  }

  get(id) {
    return this.byId.get(id) || null;
  }
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

class Tabs {
  constructor(driver) {
    this.driver = driver;
    this.numbers = new Map();   // page -> number
    this.pages = new Map();     // number -> page
    this.registries = new Map();// number -> Registry
    this.next = 1;
  }

  live() {
    return this.driver.listTabs().filter((page) => {
      try { return !page.isClosed(); } catch { return true; }
    });
  }

  numberFor(page) {
    let number = this.numbers.get(page);
    if (number == null) {
      number = this.next;
      this.next += 1;
      this.numbers.set(page, number);
      this.pages.set(number, page);
      this.registries.set(number, new Registry());
    }
    return number;
  }

  list() {
    return this.live().map((page) => ({ number: this.numberFor(page), page }));
  }

  page(number) {
    const page = this.pages.get(number);
    if (!page) return null;
    try { if (page.isClosed()) return null; } catch { /* shim without isClosed */ }
    return page;
  }

  registry(number) {
    if (!this.registries.has(number)) this.registries.set(number, new Registry());
    return this.registries.get(number);
  }
}

// ---------------------------------------------------------------------------
// Writing the page out for edbrowse
// ---------------------------------------------------------------------------

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Tokens in, html out. The only interesting decisions are which elements
// become links (all activatable ones, named by whatever names them, so an
// icon button is not an empty {} in the buffer) and how fields that sit
// outside any form are handled — see below.
function tokensToHtml(extracted, registry, base, tab) {
  const parts = [];
  let formDepth = 0;
  let formId = 0;
  let sawSubmit = false;

  const idOf = (desc, kind) => registry.idFor(desc, kind);

  for (const token of extracted.tokens) {
    switch (token.kind) {
      case 'text':
        parts.push(escapeHtml(token.text));
        break;

      case 'open':
        parts.push(`<${token.tag}>`);
        break;

      case 'close':
        parts.push(`</${token.tag}>`);
        break;

      case 'image':
        parts.push(`<img alt="${escapeHtml(token.text)}">`);
        break;

      case 'link': {
        const id = idOf(token.desc);
        // Inside a form, a control that is not a navigation is the form's
        // submit button in all but name — most sites build one out of an
        // anchor or a div. Emitting it as a real submit button is what lets
        // edbrowse's i* send the fields the reader just filled in; left as a
        // link, g would activate it with the old values still in the page.
        if (formDepth > 0 && !token.navigational) {
          parts.push(`<input type="submit" name="e${id}" value="${escapeHtml(token.name)}">`);
          sawSubmit = true;
          break;
        }
        parts.push(`<a href="e${id}">${escapeHtml(token.name)}</a>`);
        break;
      }

      case 'frame': {
        const id = idOf(token.desc, 'frame');
        parts.push(`<p><a href="f${id}">[frame: ${escapeHtml(token.name)}]</a></p>`);
        break;
      }

      case 'form-open': {
        const id = idOf(token.desc, 'form');
        parts.push(`<form action="submit/e${id}" method="post">`);
        formDepth += 1;
        formId = id;
        sawSubmit = false;
        break;
      }

      case 'form-close':
        if (formDepth > 0) {
          // A form with nothing to press is common on an application, where
          // the page submits in script and the reader is expected to press
          // Enter. Give edbrowse something to press; the server side knows
          // that pressing it means "fill these in, then press Enter in the
          // page".
          if (!sawSubmit) {
            parts.push(`<input type="submit" name="e${formId}" value="Submit">`);
          }
          parts.push('</form>');
          formDepth -= 1;
        }
        break;

      case 'field': {
        const isButton = token.type === 'submit' || token.type === 'button'
          || token.type === 'image' || token.type === 'reset';
        const id = idOf(token.desc, isButton ? 'control' : 'field');
        const loose = formDepth === 0;
        if (!loose && isButton) sawSubmit = true;
        // A field with no form around it is the normal case on an
        // application: the site collects it in script. edbrowse can only
        // submit fields that are in a form, so each loose field gets one of
        // its own, whose button means "type this in and press Enter" —
        // which is what a person does to a search box.
        if (loose) parts.push(`<form action="submit/e${id}" method="post">`);
        parts.push(fieldHtml(token, id));
        if (loose) parts.push(`<input type="submit" name="enter" value="Enter"></form>`);
        break;
      }

      default:
        break;
    }
  }

  const title = escapeHtml(extracted.title || extracted.url);
  // One line of our own at the top, and only one: it says which page this
  // really is — edbrowse's own fu would only show the loopback address — and
  // it is how the other three views and the tab list are reached, since
  // there is no key here to press for them.
  const header = `<p>tweb ${tab}: ${escapeHtml(extracted.url)}`
    + ` <a href="ax">ax</a> <a href="render">text</a> <a href="source">source</a>`
    + ` <a href="../tabs">tabs</a></p>`;
  return `<html><head><title>${title}</title><base href="${escapeHtml(base)}"></head>\n`
    + `<body>\n${header}\n${parts.join('\n')}\n</body></html>\n`;
}

function fieldHtml(token, id) {
  const name = `e${id}`;
  const label = escapeHtml(token.label);

  if (token.tag === 'select') {
    const options = (token.options || []).map((option) => {
      const selected = option.selected ? ' selected' : '';
      const disabled = option.disabled ? ' disabled' : '';
      return `<option${selected}${disabled}>${escapeHtml(option.text)}</option>`;
    }).join('');
    return `${label}: <select name="${name}">${options}</select>`;
  }

  if (token.tag === 'textarea') {
    return `${label}: <textarea name="${name}">${escapeHtml(token.value)}</textarea>`;
  }

  const type = token.type;
  if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') {
    return `<input type="submit" name="${name}" value="${escapeHtml(token.value || token.label)}">`;
  }
  if (type === 'checkbox' || type === 'radio') {
    const checked = token.checked ? ' checked' : '';
    return `${label}: <input type="${type}" name="${name}"${checked}>`;
  }
  if (type === 'hidden') return '';
  const kind = type === 'password' ? 'password' : 'text';
  return `${label}: <input type="${kind}" name="${name}" value="${escapeHtml(token.value)}">`;
}

// The other three views, as edbrowse can hold them: the reader's own line
// lists, preformatted so edbrowse leaves them alone. This is how the AX tree
// stays reachable from here, which matters because it is the view that is
// right when a page's markup is wrong.
function linesToHtml(title, base, heading, lines) {
  const body = lines.map((line) => escapeHtml(line)).join('\n');
  return `<html><head><title>${escapeHtml(title)}</title>`
    + `<base href="${escapeHtml(base)}"></head>\n<body>\n<h1>${escapeHtml(heading)}</h1>\n`
    + `<pre>\n${body}\n</pre>\n</body></html>\n`;
}

// ---------------------------------------------------------------------------
// Acting on the page
// ---------------------------------------------------------------------------

async function handleFor(page, desc) {
  const resolved = await page.evaluate(resolveDescriptor, desc);
  if (!resolved) return null;
  const handle = await page.evaluateHandle(() => window.__twebResolved);
  return { handle, how: resolved.how };
}

async function activate(page, desc, { real = false, driver = null } = {}) {
  const found = await handleFor(page, desc);
  if (!found) return { ok: false, why: 'that element is no longer on the page' };

  if (!real) {
    await found.handle.evaluate(clickThrough);
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    return { ok: true, how: found.how };
  }

  const ready = await found.handle.evaluate(prepareRealClick);
  if (!ready || !ready.ok) {
    return { ok: false, why: `a real click cannot reach it: it ${ready ? ready.reason : 'is gone'}` };
  }
  await driver.realClick(page, found.handle, { timeoutMs: ACTION_TIMEOUT_MS });
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  return { ok: true, how: found.how };
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

function endpointPath() {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'tui-browser', 'edb.json');
}

function writeEndpoint(record) {
  const file = endpointPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record));
  return file;
}

function readEndpoint() {
  try {
    return JSON.parse(fs.readFileSync(endpointPath(), 'utf8'));
  } catch {
    return null;
  }
}

function send(res, status, body, type = 'text/html; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type,
    // edbrowse caches, and rf would hand back the render before last.
    'cache-control': 'no-cache, no-store',
    pragma: 'no-cache',
  });
  res.end(body);
}

function sendPage(res, title, body) {
  send(res, 200, `<html><head><title>${escapeHtml(title)}</title></head>\n`
    + `<body>\n${body}\n</body></html>\n`);
}

function redirect(res, to) {
  res.writeHead(302, { location: to, 'cache-control': 'no-cache, no-store' });
  res.end('');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function settle(ms = SETTLE_MS) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// After something is pressed, wait long enough to be describing the page the
// reader will see rather than the one they left. A click that navigates is
// the slow case and the one worth waiting for; a click that only changes the
// page in place gets the short wait and no more.
async function settleAfter(page, before) {
  const deadline = Date.now() + NAVIGATION_WATCH_MS;
  while (Date.now() < deadline) {
    await settle(120);
    let now = before;
    try { now = page.url(); } catch { /* the tab went away */ }
    if (now !== before) {
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      return true;
    }
  }
  return false;
}

async function startEdbServer({ driver, port = 0, token = null } = {}) {
  const tabs = new Tabs(driver);
  const secret = token || crypto.randomBytes(9).toString('hex');

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log('edb.error', { url: req.url, error: String(err && err.message || err).slice(0, 200) });
      send(res, 500, `<html><body><p>tweb: ${escapeHtml(String(err && err.message || err))}</p></body></html>`);
    });
  });

  const tabUrl = (number) => `/t/${secret}/${number}/`;

  async function render(res, number, base) {
    const page = tabs.page(number);
    if (!page) return sendPage(res, 'gone', '<p>That tab has closed.</p>');
    const extracted = await page.evaluate(extractForEdbrowse);
    const html = tokensToHtml(extracted, tabs.registry(number), base, number);
    log('edb.render', { tab: number, tokens: extracted.tokens.length, bytes: html.length });
    return send(res, 200, html);
  }

  async function renderView(res, number, view, base) {
    const page = tabs.page(number);
    if (!page) return sendPage(res, 'gone', '<p>That tab has closed.</p>');
    const blocks = await snapshotFrameTree(page, view, { driver });
    const heading = { ax: 'Accessibility tree', render: 'Visible text', source: 'Markup' }[view] || view;
    log('edb.view', { tab: number, view, blocks: blocks.length });
    return send(res, 200,
      linesToHtml(`${heading} — tab ${number}`, base, heading, blocks.map((b) => b.text)));
  }

  async function handle(req, res) {
    const url = new URL(req.url, `http://${HOST}`);
    const parts = url.pathname.split('/').filter(Boolean);

    // /t/<token>/...
    if (parts[0] !== 't' || parts[1] !== secret) {
      return send(res, 404, '<html><body><p>tweb: no such page</p></body></html>');
    }
    const rest = parts.slice(2);

    if (!rest.length || rest[0] === 'tabs') {
      const list = tabs.list();
      const rows = await Promise.all(list.map(async ({ number, page }) => {
        const title = await page.title().catch(() => page.url());
        return `<p><a href="${number}/">${escapeHtml(title || page.url())}</a>`
          + ` — <a href="${number}/close">close</a></p>`;
      }));
      return sendPage(res, 'tweb tabs', rows.join('\n') || '<p>No tabs open.</p>');
    }

    // open?url=… is how the entry-point plugin hands us a url: a new tab,
    // then a redirect to it, so the buffer ends up holding the tab's own
    // address rather than the command that opened it.
    if (rest[0] === 'open') {
      const wanted = url.searchParams.get('url');
      if (!wanted) return send(res, 400, '<html><body><p>tweb: no url</p></body></html>');
      const opened = await driver.newTab();
      await opened.goto(wanted, { waitUntil: 'domcontentloaded' });
      await settle();
      const number = tabs.numberFor(opened);
      log('edb.open', { tab: number, url: wanted.slice(0, 120) });
      return redirect(res, tabUrl(number));
    }

    const number = Number(rest[0]);
    if (!Number.isFinite(number)) return send(res, 404, '<html><body><p>tweb: no such tab</p></body></html>');
    const page = tabs.page(number);
    if (!page) return sendPage(res, 'gone', '<p>That tab has closed.</p>');
    const base = `http://${HOST}:${server.address().port}${tabUrl(number)}`;
    const what = rest[1] || '';

    if (!what) return render(res, number, base);
    if (what === 'ax' || what === 'render' || what === 'source') {
      return renderView(res, number, what, base);
    }

    if (what === 'close') {
      await page.close().catch(() => {});
      return redirect(res, `/t/${secret}/tabs`);
    }

    // submit/e<id>
    //
    // The reader filled the form in edbrowse; the values live there, not in
    // the page. So: put them into the live elements, let the site's own
    // input and change handlers run, and only then press the button — as a
    // person would press it, because a submit is exactly where sites ask
    // whether a person is present.
    if (what === 'submit') {
      const targetId = Number(String(rest[2] || '').replace(/^e/, ''));
      const registry = tabs.registry(number);
      const target = registry.get(targetId);
      if (!target) return sendPage(res, 'stale', '<p>That form is from an older version of this page. Type rf.</p>');

      const body = await readBody(req);
      const fields = new URLSearchParams(body);
      const entries = [];
      let pressed = null;
      for (const [name, value] of fields) {
        if (name === 'enter') continue; // our own button on a loose field
        const record = registry.get(Number(String(name).replace(/^e/, '')));
        if (!record) continue;
        if (record.kind === 'control') { pressed = record; continue; }
        if (record.kind !== 'field') continue;
        entries.push({ path: record.desc.path, tag: record.desc.tag, value });
      }

      const before = page.url();
      const applied = entries.length
        ? await page.evaluate(applyFieldValues, entries)
        : { applied: 0, missed: [] };

      let how = 'nothing';
      if (pressed) {
        const result = await activate(page, pressed.desc, { real: true, driver });
        how = result.ok ? 'clicked' : 'refused';
        if (!result.ok) {
          return sendPage(res, 'cannot', `<p>${escapeHtml(result.why)}</p>`
            + '<p><a href="./">back to the page</a></p>');
        }
      } else {
        // Nothing to press: the page submits in script and expects Enter,
        // which is what a person would do in a search box. Type it into the
        // field the reader was filling, through the browser's own keyboard.
        const field = target.kind === 'field' ? target.desc
          : (entries.length ? { ...entries[entries.length - 1], name: '' } : null);
        if (field) {
          await page.evaluate(resolveDescriptor, field);
          await page.evaluate(() => {
            const el = window.__twebResolved;
            if (el && typeof el.focus === 'function') el.focus();
          });
          await page.keyboard.press('Enter');
          how = 'enter';
        }
      }

      const navigated = await settleAfter(page, before);
      log('edb.submit', {
        tab: number, fields: entries.length, applied: applied.applied, how, navigated,
      });
      return redirect(res, tabUrl(number));
    }

    // e<id> and e<id>/click
    if (/^e\d+$/.test(what)) {
      const registry = tabs.registry(number);
      const record = registry.get(Number(what.slice(1)));
      if (!record) return sendPage(res, 'stale', '<p>That link is from an older version of this page. Type rf.</p>');
      const real = rest[2] === 'click';
      const before = page.url();
      const result = await activate(page, record.desc, { real, driver });
      if (!result.ok) return sendPage(res, 'cannot', `<p>${escapeHtml(result.why)}</p><p><a href="./">back to the page</a></p>`);
      const navigated = await settleAfter(page, before);
      log('edb.activate', { tab: number, id: what, real, how: result.how, navigated });
      return redirect(res, tabUrl(number));
    }

    // f<id>: a frame, rendered as its own page
    if (/^f\d+$/.test(what)) {
      const registry = tabs.registry(number);
      const record = registry.get(Number(what.slice(1)));
      if (!record) return sendPage(res, 'stale', '<p>That frame is from an older version of this page. Type rf.</p>');
      const desc = record.desc;
      const frames = page.mainFrame().childFrames ? await page.mainFrame().childFrames() : [];
      // Frames are matched by position, the same assumption the reader has
      // always made: the Nth frame element belongs to the Nth child context.
      const index = Number(desc.path.split('/').pop()) || 0;
      const frame = frames[Math.min(index, Math.max(frames.length - 1, 0))];
      if (!frame) return sendPage(res, 'gone', '<p>That frame is not there any more.</p>');
      const extracted = await frame.evaluate(extractForEdbrowse);
      return send(res, 200, tokensToHtml(extracted, registry, base, number));
    }

    return send(res, 404, '<html><body><p>tweb: no such page</p></body></html>');
  }

  await new Promise((resolve) => server.listen(port, HOST, resolve));
  const actual = server.address().port;
  const record = { port: actual, token: secret, pid: process.pid, startedAt: Date.now() };
  const file = writeEndpoint(record);
  log('edb.listen', { port: actual, endpoint: file });

  return {
    port: actual,
    token: secret,
    url: `http://${HOST}:${actual}/t/${secret}/tabs`,
    tabUrl: (n) => `http://${HOST}:${actual}${tabUrl(n)}`,
    tabs,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = {
  startEdbServer, readEndpoint, endpointPath, tokensToHtml, linesToHtml,
  Registry, Tabs, escapeHtml,
};
