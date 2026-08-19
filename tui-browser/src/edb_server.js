'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { extractForEdbrowse, resolveDescriptor, applyFieldValues } = require('./edb_page');
const { clickThrough, prepareRealClick } = require('./click');
const {
  snapshotFrameTree, readDocument, everyChildFrame, orderedChildFrames, frameKey,
} = require('./frames');
const { Core, ALL_SOURCES } = require('./core');
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
  // `urls` and `startAt` are carried over when the browser is replaced: the
  // pages are gone, but the numbers are in the reader's buffer, and a number
  // that still remembers where it was pointing can be offered back.
  constructor(core, urls = new Map(), startAt = 1) {
    this.core = core;
    this.numbers = new Map();   // page -> number
    this.pages = new Map();     // number -> page
    this.registries = new Map();// number -> Registry
    this.urls = urls;           // number -> the url it last held
    this.next = startAt;
  }

  remember(number, url) {
    if (url && url !== 'about:blank') this.urls.set(number, url);
  }

  lastUrl(number) {
    return this.urls.get(number) || null;
  }

  live() {
    return this.core.tabs();
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

// The address bar.
//
// There is no key here to press for one, and a reader should not have to
// remember an incantation to reach the web — least of all `b tweb://` plus a
// scheme they were not thinking about. So every page tweb serves begins with
// a field to type an address into, which is the one form of instruction that
// cannot be forgotten: it is in the buffer, on line one, where the reader
// already is.
//
// One line, one field, one button, because edbrowse numbers input fields
// within the current line: on line 1 of any tweb page,
//
//     i=example.com
//     i*
//
// with no number to count out and no url to remember. `action` is relative to
// the <base href> every page carries, which points at the tab.
function openBar(action = '../open') {
  return `<p><form action="${action}" method="post">Open: `
    + `<input name="url" value=""> <input type="submit" name="go" value="Go">`
    + `</form></p>`;
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
    + `<body>\n${openBar()}\n${header}\n${parts.join('\n')}\n</body></html>\n`;
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
    + `<base href="${escapeHtml(base)}"></head>\n<body>\n${openBar()}\n`
    + `<p><a href="./">the page</a> <a href="../tabs">tabs</a></p>\n`
    + `<h1>${escapeHtml(heading)}</h1>\n`
    + `<pre>\n${body}\n</pre>\n</body></html>\n`;
}

// ---------------------------------------------------------------------------
// What the reader typed
// ---------------------------------------------------------------------------

// Every url bar in the world accepts `timeanddate.com`, and a reader who has
// just typed a page's name should not have to think about which of two
// transport protocols a site prefers. What arrives here is whatever came
// after tweb:// — or whatever was typed into the open field on the page —
// and it becomes something a browser can be sent to, or an admission that it
// is not an address at all.
//
// Bare host with a dot: https, because that is the web now, and a site that
// is still plaintext will redirect us there itself. localhost and the
// loopback addresses get http, since they usually have no certificate.
// Anything with no dot in it is not an address; say so, and offer to search
// for it rather than quietly sending what was typed to a search engine.
function normaliseTarget(text) {
  const wanted = String(text || '').trim();
  if (!wanted) return { error: 'nothing to open' };
  // A scheme, and not a windows path or a bare host:port.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(wanted) || /^(mailto|data|about|file):/i.test(wanted)) {
    return { url: wanted };
  }
  const host = wanted.split(/[/?#]/)[0];
  if (/^(localhost|127(\.\d{1,3}){3}|\[::1\])(:\d+)?$/i.test(host) || /\.local(:\d+)?$/i.test(host)) {
    return { url: `http://${wanted}` };
  }
  if (/^[^\s@]+\.[a-z][a-z0-9-]{1,}(:\d+)?$/i.test(host)) return { url: `https://${wanted}` };
  return { search: wanted };
}

const SEARCH_URL = 'https://duckduckgo.com/html/?q=';

// ---------------------------------------------------------------------------
// Acting on the page
// ---------------------------------------------------------------------------

async function handleFor(page, desc) {
  const resolved = await page.evaluate(resolveDescriptor, desc);
  if (!resolved) return null;
  const handle = await page.evaluateHandle(() => window[Symbol.for('tweb.resolved')]);
  return { handle, how: resolved.how };
}

async function activate(page, desc, { real = false, core = null } = {}) {
  const found = await handleFor(page, desc);
  if (!found) return { ok: false, why: 'that element is no longer on the page' };

  // Resolving is ours — a descriptor we handed out in a form is not something
  // the core knows about — but what happens to the element once we have it is
  // the core's, timeouts and all. It is the same click the reader makes.
  if (!real) {
    await core.activateHandle(found.handle, page);
    return { ok: true, how: found.how };
  }

  const clicked = await core.realClickHandle(found.handle, page);
  if (!clicked.ok) return { ok: false, why: `a real click cannot reach it: it ${clicked.reason}` };
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

// The browser libraries describe failures to whoever is driving them, not to
// whoever is reading. "Target page, context or browser has been closed" names
// no cause and suggests no action; the reader wants the sentence a person
// would say. Anything not recognised is passed through unchanged, because a
// message we did not anticipate is still better than one we invented.
const EXPLANATIONS = [
  [/Target page, context or browser has been closed/i,
    'the browser closed. Ask for a page again and tweb will start another.'],
  [/Cannot navigate to invalid URL|Invalid url/i,
    'that is not an address a browser can be sent to.'],
  [/net::ERR_NAME_NOT_RESOLVED|NS_ERROR_UNKNOWN_HOST/i,
    'that host does not resolve.'],
  [/net::ERR_CONNECTION_REFUSED|NS_ERROR_CONNECTION_REFUSED/i,
    'nothing is listening there.'],
  [/Timeout .* exceeded|did not answer within/i,
    'the browser did not answer in time. Type rf to try again.'],
];

function explain(message) {
  for (const [pattern, said] of EXPLANATIONS) {
    if (pattern.test(message)) return said;
  }
  return message;
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

// A browser is the reader's to close, and they do — the window goes away,
// this process keeps a Playwright context that answers every call with
// "Target page, context or browser has been closed", and the reader gets that
// sentence instead of a page for the rest of the session. So notice it
// instead: ask the driver whether the browser is still there before touching
// it, and if it is not, start one again exactly the way this session started
// the first one. Tab numbers survive the restart pointing at nothing, which
// is why Tabs carries the urls over: the reader is offered the page back
// rather than told a number is meaningless.
function browserAlive(driver) {
  try {
    return typeof driver.alive === 'function' ? driver.alive() : true;
  } catch {
    return false;
  }
}

async function startEdbServer({
  driver, reopen = null, port = 0, token = null,
} = {}) {
  // One core, and pages named per request rather than held: the reader has a
  // tab it is on, and this serves however many edbrowse asks about. Every
  // core method that touches a page takes it as an argument for that reason.
  let core = new Core({ driver, page: null, source: 'ax', sources: ALL_SOURCES });
  let tabs = new Tabs(core);
  const secret = token || crypto.randomBytes(9).toString('hex');

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const message = String(err && err.message || err);
      log('edb.error', { url: req.url, error: message.slice(0, 200) });
      send(res, 500, `<html><body><p>tweb: ${escapeHtml(explain(message))}</p>`
        + `<p><a href="/t/${secret}/tabs">the tabs</a></p></body></html>`);
    });
  });

  // Returns true if a new browser had to be started, so the caller can say so
  // rather than silently answering about a page the reader never opened.
  // Starting one takes seconds; `starting` is what stops two requests that
  // arrive during those seconds from starting two browsers.
  let starting = null;
  async function ensureBrowser() {
    if (browserAlive(core.driver)) return false;
    if (starting) { await starting; return true; }
    log('edb.browser.gone', { engine: core.driver.name });
    if (!reopen) {
      throw new Error('the browser has closed, and nothing here knows how to start another');
    }
    starting = reopen();
    try {
      const fresh = await starting;
      core = new Core({ driver: fresh, page: null, source: 'ax', sources: ALL_SOURCES });
      tabs = new Tabs(core, tabs.urls, tabs.next);
      log('edb.browser.restarted', { engine: fresh.name });
    } finally {
      starting = null;
    }
    return true;
  }

  const tabUrl = (number) => `/t/${secret}/${number}/`;
  const openUrl = (target) => `/t/${secret}/open?url=${encodeURIComponent(target)}`;

  // Pages of our own — the tab list, and everything tweb has to say when it
  // cannot do what was asked — carry the address bar too, because those are
  // exactly the pages a reader is on when they want to go somewhere else.
  //
  // And a <base>, because the entry-point plugin can land the reader here
  // directly (`b tweb://tabs`), and then the buffer's own filename is a
  // tweb:// url that no relative link on this page resolves against.
  const ours = (res, title, body) => send(res, 200,
    `<html><head><title>${escapeHtml(title)}</title>`
    + `<base href="http://${HOST}:${server.address().port}/t/${secret}/"></head>\n`
    + `<body>\n${openBar(`/t/${secret}/open`)}\n${body}\n</body></html>\n`);

  // A tab number that names nothing: closed by the reader, or lost with the
  // browser it lived in. Either way the useful answer is the page it held.
  function goneTab(res, number, { restarted = false } = {}) {
    const last = tabs.lastUrl(number);
    const said = restarted
      ? 'The browser closed while you were reading it, and tweb has started another.'
      : 'That tab is not open any more.';
    const links = [`<a href="/t/${secret}/tabs">the tabs</a>`];
    if (last) links.unshift(`<a href="${openUrl(last)}">open ${escapeHtml(last)} again</a>`);
    return ours(res, 'that tab is gone', `<p>${said}</p>\n<p>${links.join(' — ')}</p>`);
  }

  // Nothing to read is what a document behind a closed shadow root looks
  // like, and it is what a bot check looks like, so this is where edbrowse
  // stopped being shown one at all.
  const nothingRead = (extracted) => !extracted || !extracted.tokens || !extracted.tokens.length;

  // Documents the page's own markup never mentions, in the order the browser
  // reports them. An <iframe> inside a closed shadow root is not findable by
  // walking for elements, so the frame tokens the extractor produced account
  // for some of the child documents and not necessarily all.
  async function unmentionedFrames(frame, extracted) {
    const mentioned = (extracted.tokens || []).filter((t) => t.kind === 'frame').length;
    const ordered = await orderedChildFrames(frame).catch(() => []);
    const all = await everyChildFrame(frame);
    const placed = new Set(ordered.map(frameKey));
    const hidden = all.filter((child) => !placed.has(frameKey(child)));
    return { ordered, hidden, mentioned };
  }

  async function readPage(frame) {
    const extracted = await readDocument(frame, extractForEdbrowse, core.driver, nothingRead);
    const { ordered, hidden } = await unmentionedFrames(frame, extracted);
    // Appended rather than placed, because nothing says where in the page
    // they belonged — the same answer the reader gives.
    hidden.forEach((child, index) => {
      let host = String(child.url() || '');
      try { host = new URL(host).host || host; } catch { /* keep it raw */ }
      extracted.tokens.push({
        kind: 'frame',
        desc: { tag: 'iframe', path: `hidden/${index}`, name: host, ordinal: index },
        name: host,
      });
    });
    return { extracted, ordered, hidden };
  }

  async function render(res, number, base) {
    const page = tabs.page(number);
    if (!page) return goneTab(res, number);
    tabs.remember(number, page.url());
    const { extracted, hidden } = await readPage(page.mainFrame());
    const html = tokensToHtml(extracted, tabs.registry(number), base, number);
    log('edb.render', {
      tab: number, tokens: extracted.tokens.length, hiddenFrames: hidden.length, bytes: html.length,
    });
    return send(res, 200, html);
  }

  async function renderView(res, number, view, base) {
    const page = tabs.page(number);
    if (!page) return goneTab(res, number);
    const blocks = await snapshotFrameTree(page, view, { driver: core.driver });
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

    // Before anything touches the browser, make sure there is one.
    const restarted = await ensureBrowser();

    if (!rest.length || rest[0] === 'tabs') {
      const list = tabs.list();
      const rows = await Promise.all(list.map(async ({ number, page }) => {
        const title = await page.title().catch(() => page.url());
        return `<p><a href="${number}/">${escapeHtml(title || page.url())}</a>`
          + ` — <a href="${number}/close">close</a></p>`;
      }));
      return ours(res, 'tweb tabs', rows.join('\n') || '<p>No tabs open.</p>');
    }

    // open?url=… is how the entry-point plugin hands us a url: a new tab,
    // then a redirect to it, so the buffer ends up holding the tab's own
    // address rather than the command that opened it.
    if (rest[0] === 'open') {
      // Either from the plugin, which puts it in the query, or from the open
      // field at the top of every page, which posts it.
      const typed = req.method === 'POST'
        ? new URLSearchParams(await readBody(req)).get('url')
        : url.searchParams.get('url');
      const target = normaliseTarget(typed);
      if (target.error) return send(res, 400, `<html><body><p>tweb: ${escapeHtml(target.error)}</p></body></html>`);
      if (target.search) {
        return ours(res, 'not an address',
          `<p>${escapeHtml(target.search)} is not a url — it has no host in it.</p>\n`
          + `<p><a href="${openUrl(SEARCH_URL + encodeURIComponent(target.search))}">`
          + `search the web for it</a> — <a href="/t/${secret}/tabs">the tabs</a></p>`);
      }
      const wanted = target.url;
      const opened = await core.driver.newTab();
      await opened.goto(wanted, { waitUntil: 'domcontentloaded' });
      await settle();
      const number = tabs.numberFor(opened);
      tabs.remember(number, wanted);
      log('edb.open', { tab: number, url: wanted.slice(0, 120) });
      return redirect(res, tabUrl(number));
    }

    const number = Number(rest[0]);
    if (!Number.isFinite(number)) return send(res, 404, '<html><body><p>tweb: no such tab</p></body></html>');
    const page = tabs.page(number);
    if (!page) return goneTab(res, number, { restarted });
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
      if (!target) return ours(res, 'stale', '<p>That form is from an older version of this page. Type rf.</p>');

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
        const result = await activate(page, pressed.desc, { real: true, core });
        how = result.ok ? 'clicked' : 'refused';
        if (!result.ok) {
          return ours(res, 'cannot', `<p>${escapeHtml(result.why)}</p>`
            + `<p><a href="${tabUrl(number)}">back to the page</a></p>`);
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
            const el = window[Symbol.for('tweb.resolved')];
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
      if (!record) return ours(res, 'stale', '<p>That link is from an older version of this page. Type rf.</p>');
      const real = rest[2] === 'click';
      const before = page.url();
      const result = await activate(page, record.desc, { real, core });
      if (!result.ok) return ours(res, 'cannot', `<p>${escapeHtml(result.why)}</p><p><a href="${tabUrl(number)}">back to the page</a></p>`);
      const navigated = await settleAfter(page, before);
      log('edb.activate', { tab: number, id: what, real, how: result.how, navigated });
      return redirect(res, tabUrl(number));
    }

    // f<id>: a frame, rendered as its own page
    if (/^f\d+$/.test(what)) {
      const registry = tabs.registry(number);
      const record = registry.get(Number(what.slice(1)));
      if (!record) return ours(res, 'stale', '<p>That frame is from an older version of this page. Type rf.</p>');
      const desc = record.desc;
      const { ordered, hidden } = await unmentionedFrames(page.mainFrame(), { tokens: [] });
      let frame = null;
      if (String(desc.path).startsWith('hidden/')) {
        // One the markup never mentioned; it is named by where it sat in the
        // browser's own list, which is the only order it has.
        frame = hidden[Number(desc.path.slice('hidden/'.length)) || 0] || null;
      } else {
        // Frames the markup did mention are matched by position, the same
        // assumption the reader has always made: the Nth frame element
        // belongs to the Nth child context.
        const index = Number(desc.path.split('/').pop()) || 0;
        frame = ordered[Math.min(index, Math.max(ordered.length - 1, 0))] || null;
      }
      if (!frame) return ours(res, 'gone', '<p>That frame is not there any more.</p>');
      const { extracted } = await readPage(frame);
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
    get tabs() { return tabs; },
    get driver() { return core.driver; },
    get core() { return core; },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = {
  startEdbServer, readEndpoint, endpointPath, tokensToHtml, linesToHtml,
  Registry, Tabs, escapeHtml, normaliseTarget, explain, openBar,
};
