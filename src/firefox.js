'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const {
  writeEndpointRecord, readEndpointRecord, runningEndpoint, waitForEndpoint, freePort,
} = require('./endpoint');
const {
  killProcessGroup, requireBrowserUser, watchChildStartup, browserStartupError,
  startupTimeoutMs, snapPackageName, snapCanReach, snapProfileDir, xvfbDisplayOption,
} = require('./proc');
const { recordBrowser, sweepStrandedBrowsers } = require('./registry');
const { openAccessibilityBus } = require('./a11y_bus');

// Getting hold of a Firefox that is not pretending to be a robot.
//
// The same rule applies here as for Chromium: we start an ordinary browser and
// observe it, because a browser that cannot clear a bot check is not a
// degraded reader, it is a broken one. Firefox makes that harder in exactly
// one way, and it is worth being precise about what that way is.
//
// Measured on Firefox 147, against a probe collecting the signals anti-bot
// scripts actually read — automation globals, document attributes, plugins,
// permissions state, hover and pointer media queries, window against screen
// geometry, WebGL strings, whether patched getters still report native code —
// an automated Firefox differs from an ordinary one in a single boolean:
//
//   navigator.webdriver: false -> true
//
// Nothing else. Not one other field. And that boolean has one source: the
// parent process publishes shared-data keys while its automation agents are
// active, and `navigator.webdriver` in a content process reads them back.
//
// So we clear them through privileged JavaScript in the parent process, using
// Marionette's chrome context. Some Firefox releases publish a key again when
// the BiDi session starts, so the parent-process agent installed at startup
// clears them a second time after that session exists. Nothing in any page is
// touched: no getter is
// redefined, no toString is patched, so there is no tampering for a site to
// notice. The browser simply stops announcing something about itself.
//
// Marionette is then left running, on purpose, because it is the only way out
// of a problem BiDi has no answer for. Closing a BiDi connection does not end
// its session — Firefox only unregisters the connection — and a pure-BiDi
// session cannot be reattached to or ended from anywhere else, so a reader
// that dies without saying session.end strands the session and locks every
// later reader out until Firefox restarts. Marionette shares that single
// session slot, and its own connection handler deletes the session
// unconditionally when a connection closes. So connecting to Marionette and
// hanging up releases a stranded session, in milliseconds, with no restart.
//
// Local port exposure is out of scope for this project: anything that can
// reach Marionette can already reach the browser's own protocol port and
// drive it. What is in scope is the consequence for us — while Marionette
// listens, anything that connects to it and disconnects will drop our session
// too, which is one more reason to end it cleanly ourselves.
//
// Each instance gets its own Marionette port, written into the profile.
// Firefox's default is 2828 for every browser, so with two profiles running
// the second reader would clear the first browser's flag and knock out the
// first browser's session.

const CANDIDATES = ['firefox', 'firefox-esr', 'librewolf'];
const STARTUP_TIMEOUT_MS = 45000;
// Firefox can expose its BiDi port before Marionette is ready to create and
// run a privileged session, especially on a cold start on a slower machine.
// Give every Marionette operation the same full minute rather than imposing
// three different, shorter limits at different points in startup and recovery.
const MARIONETTE_TIMEOUT_MS = 60000;
const STARTUP_NOTICE_MS = 10000;

function sayStartup(onStartup, message) {
  try { onStartup(message); } catch { /* display trouble must not stop the browser */ }
}

async function waitWithStartup(promise, onStartup, phase) {
  const started = Date.now();
  sayStartup(onStartup, `${phase}…`);
  const timer = setInterval(() => {
    const seconds = Math.max(1, Math.round((Date.now() - started) / 1000));
    sayStartup(onStartup, `${phase} (${seconds}s)…`);
  }, STARTUP_NOTICE_MS);
  try {
    return await promise;
  } finally {
    clearInterval(timer);
  }
}

// Both agents publish their own key, and either one being true is enough to
// give the browser away.
const ACTIVE_KEYS = ['RemoteAgent:Active', 'Marionette:Active'];

const CLEAR_SCRIPT = `
  const keys = ${JSON.stringify(ACTIVE_KEYS)};
  const state = () => Object.fromEntries(
    keys.map((key) => [key, Services.ppmm.sharedData.get(key) ?? false]));
  const before = state();
  for (const key of keys) Services.ppmm.sharedData.set(key, false);
  Services.ppmm.sharedData.flush();
  return { before, after: state() };
`;

function osDescription() {
  try {
    const text = fs.readFileSync('/etc/os-release', 'utf8');
    const found = /^PRETTY_NAME=(?:"([^"]*)"|'([^']*)'|(.*))$/m.exec(text);
    return found ? (found[1] || found[2] || found[3] || '').trim() : null;
  } catch {
    return null;
  }
}

function firefoxRuntimeInfo(executable, env = process.env) {
  let resolved = executable;
  try { resolved = fs.realpathSync(executable); } catch { /* the spawn error will name it */ }
  return {
    executable,
    resolvedExecutable: resolved,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    kernel: os.release(),
    os: osDescription(),
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    imageRevision: env.TAWB_IMAGE_REVISION || null,
  };
}

// Media has to be allowed to start without a user gesture, because there is
// no gesture to give.
//
// The reader activates a control through the DOM's own default action —
// element.click() — rather than by driving a mouse at coordinates, since a
// blind user has no viewport and legitimate targets sit off-screen. That
// click carries no user activation, so Firefox refuses to play the audio it
// starts: `NotAllowedError: The play method is not allowed by the user agent`
// on a Bandcamp album page, while Chrome played the same page.
//
// The gesture the browser is looking for did happen — the reader pressed
// Enter on the play button — it simply cannot be conveyed through the
// protocol. So the profile is configured the way a user who ticked Firefox's
// own "Allow Audio and Video" would have it, per profile and nothing to do
// with any page. `block-autoplay-until-in-foreground` matters too: the tab
// being read is not always the tab the browser has on screen, and playback
// that waits for the foreground never starts.
const MEDIA_PREFS = {
  'media.autoplay.default': 0,          // 0 allow, 1 block audible, 5 block all
  'media.autoplay.blocking_policy': 0,  // ask once per profile, not per gesture
  'media.block-autoplay-until-in-foreground': false,
};

// The password manager, which the remote agent turns off and a reader needs
// on.
//
// Firefox's automation preferences disable both halves of it — `signon.
// autofillForms` and `signon.rememberSignons`, "so that tests that include
// forms are not influenced by the presence of the persistent doorhanger
// notification". That is right for a test suite and wrong for a person: it
// means the browser never offers to remember a password and never fills one
// in, silently, with nothing on screen to explain why.
//
// Setting them here is enough, because the agent applies its preferences only
// where the user has none: `if (!Services.prefs.prefHasUserValue(k))`, in
// remote/shared/RecommendedPreferences.sys.mjs. A value in user.js is a user
// value.
//
// These are the browser's own defaults, not new behaviour: an ordinary
// Firefox remembers passwords and fills them in. Autofill over plain http
// stays off, as it is in an ordinary Firefox.
const PASSWORD_PREFS = {
  'signon.rememberSignons': true,
  'signon.autofillForms': true,
};

// Alt-click is Firefox's browser-native save-target gesture, but a preference
// can turn it into an ordinary click. TAWB uses that gesture for its explicit
// download-link action, so the profile must leave its documented meaning on.
const DOWNLOAD_PREFS = {
  'browser.altClickSave': true,
};

// Firefox reads user.js at startup, so everything here has to be in the
// profile before launch. Ours are rewritten every time rather than appended
// to, so a stale port or a pref we have since changed does not survive.
function writeProfilePrefs(profileDir, prefs) {
  const target = path.join(profileDir, 'user.js');
  const ours = Object.keys(prefs);
  let kept = [];
  try {
    kept = fs.readFileSync(target, 'utf8').split('\n')
      .filter((line) => line.trim() && !ours.some((name) => line.includes(`"${name}"`)));
  } catch { /* no user.js yet */ }
  const written = ours.map((name) => `user_pref("${name}", ${JSON.stringify(prefs[name])});`);
  fs.writeFileSync(target, [...kept, ...written].join('\n') + '\n');
}

// Ubuntu's Firefox is a Snap, and a Snap cannot read ~/.local/share at all —
// see the note on confinement in proc.js. Such a build gets its profile inside
// the snap's own data area, which is the one place it is allowed to write.
function defaultProfileDir(executable = (findFirefox() || {}).executable) {
  const snap = snapPackageName(executable);
  if (snap) return snapProfileDir(snap, 'firefox-profile');
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'tawb', 'firefox-profile');
}

// Pointed at a profile its confinement forbids, a Snap Firefox does not exit:
// it opens a window explaining itself on a virtual screen nobody can see, and
// the launcher waits out the whole timeout for a port that never opens. Say so
// before launching rather than after 45 seconds of nothing.
function requireReachableProfile({ executable, name }, profileDir) {
  const snap = snapPackageName(executable);
  if (!snap || snapCanReach(profileDir)) return;
  throw new Error(
    `${name} at ${executable} runs the ${snap} snap, and a Snap cannot open ${profileDir}: `
    + 'its confinement allows only non-hidden directories under your home directory. '
    + `Use a profile it can reach, such as ${snapProfileDir(snap, 'firefox-profile')}, `
    + 'or install Firefox from a package that is not confined.',
  );
}

function which(command) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* keep looking */ }
  }
  return null;
}

function findFirefox() {
  for (const name of CANDIDATES) {
    const found = which(name);
    if (found) return { executable: found, name };
  }
  return null;
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.setTimeout(1000);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
}

// The virtual screen is given a desktop's dimensions. xvfb-run defaults to
// 640x480, and a 640x480 screen is not a small window, it is a different web:
// pages serve their narrow layout, sticky bars cover most of what is left,
// and a control in the middle of the page can end up with a cookie banner
// permanently on top of it. 1280x1024 is an ordinary desktop and costs
// nothing but virtual pixels.
const SCREEN = '1280x1024x24';

// What the browser was given for a display, kept so a startup failure can say
// whether it was a real one or a virtual one.
let lastDisplayNote = null;

// A headless browser fails the checks a real one passes, so with no display we
// run under Xvfb — a real browser drawing to a virtual screen.
function buildCommand(executable, args) {
  if (process.env.DISPLAY) {
    lastDisplayNote = `Display: ${process.env.DISPLAY}`;
    return { command: executable, args };
  }
  const xvfb = which('xvfb-run');
  if (!xvfb) {
    throw new Error(
      'No DISPLAY is set and xvfb-run was not found. A browser with a display '
      + 'is required (headless browsers fail bot checks that a real one passes). '
      + 'Install xvfb, or run inside a graphical session.',
    );
  }
  lastDisplayNote = `Display: none, so the browser was run under ${xvfb}`;
  // Which display-picking option this xvfb-run understands. See proc.js:
  // two browsers starting at once must not both be handed the same display.
  const display = xvfbDisplayOption(xvfb);
  return { command: xvfb, args: [display, '-s', `-screen 0 ${SCREEN}`, executable, ...args] };
}

// ---------------------------------------------------------------------------
// What the parent process installs, once, so that closed shadow roots can be
// reached later without asking Marionette anything.
//
// This is the whole answer to a problem that looked unsolvable. Firefox can
// see into a closed shadow root only through openOrClosedShadowRoot, which is
// privileged, and the privileged channel — Marionette — cannot be used while
// the reader is running: it shares one WebDriver session slot with BiDi, and
// merely connecting to it deletes the session already there. Patching that
// limit from inside was the other idea, and it is the worse one: it means
// monkey-patching internals that move between Firefox versions, to reach a
// two-session configuration nobody supports.
//
// So nothing is asked of Marionette at runtime. While we legitimately hold
// the session at startup — the same session that clears the automation flag —
// a process script is installed into every content process, present and
// future. It hands each window a function of its own, `__twebPierce()`, which
// when called walks the document with privilege and returns the pairs it
// found — each a host element and the closed shadow root on it. It returns
// them rather than marking the elements, because a mark left on a page's own
// objects is exactly what must not be there in the one document where being
// noticed decides everything: a challenge frame.
//
// After that the page can reach its own shadow roots by asking, an ordinary
// script call with no protocol round trip, and the accessibility walk needs
// to know nothing about how that became possible. It is the same property the
// Chromium driver sets by a different route.
// Runs in every content process, with privilege. Handed to each window as a
// function it can call for itself.
const PIERCE_CHILD_SCRIPT = `
  if (!globalThis.__twebShadowInstalled) {
    globalThis.__twebShadowInstalled = true;
    Services.obs.addObserver(function (win) {
      try {
        const candidates = (root) => Array.from(root.querySelectorAll(
          'button,input,[role="button"],[role="slider"],[role="menuitem"],'
          + '[role="menuitemcheckbox"],[role="menuitemradio"]'));
        const visible = (el) => {
          try {
            const style = win.getComputedStyle(el);
            const box = el.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden'
              && Number(style.opacity) !== 0 && box.width > 0 && box.height > 0;
          } catch (e) { return false; }
        };
        const mediaControls = (host, shadow) => {
          if (!['audio', 'video'].includes(String(host.localName || '').toLowerCase())) return [];
          const media = Array.from(win.document.querySelectorAll('video,audio')).indexOf(host);
          return candidates(shadow).map((control, index) => {
            if (!visible(control)) return null;
            const type = String(control.getAttribute('type') || control.type || '').toLowerCase();
            const explicit = String(control.getAttribute('role') || '').toLowerCase();
            const role = explicit || (type === 'range' ? 'slider' : 'button');
            const name = String(control.getAttribute('aria-label')
              || control.getAttribute('title') || control.textContent || '').trim();
            if (!name || ![
              'button', 'slider', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
            ].includes(role)) return null;
            const value = role === 'slider'
              ? String(control.getAttribute('aria-valuetext') || control.value || '') : '';
            return { role, name, value, index, media };
          }).filter(Boolean);
        };
        const pierce = function () {
          const found = [];
          const walk = (root) => {
            for (const el of root.querySelectorAll('*')) {
              let shadow = null;
              try { shadow = el.openOrClosedShadowRoot; } catch (e) { shadow = null; }
              if (!shadow) continue;
              try {
                found.push([
                  el.wrappedJSObject || el,
                  shadow.wrappedJSObject || shadow,
                  mediaControls(el, shadow),
                  ['audio', 'video'].includes(String(el.localName || '').toLowerCase())
                    ? 'user-agent' : 'closed',
                ]);
              } catch (e) { /* not a node we can hand over */ }
              walk(shadow);
            }
          };
          walk(win.document);
          return Cu.cloneInto(found, win.wrappedJSObject, { wrapReflectors: true });
        };
        const nativeControl = function (media, index) {
          const host = win.document.querySelectorAll('video,audio')[media];
          if (!host) return null;
          let shadow = null;
          try { shadow = host.openOrClosedShadowRoot; } catch (e) { return null; }
          const control = shadow && candidates(shadow)[index];
          return control && visible(control) ? control : null;
        };
        const pressNative = function (media, index) {
          const control = nativeControl(media, index);
          if (!control) return false;
          control.click();
          return true;
        };
        const focusNative = function (media, index) {
          const control = nativeControl(media, index);
          if (!control) return false;
          control.focus();
          // A user-agent shadow root does not expose activeElement back across
          // its boundary. Finding the visible control and completing focus()
          // is the strongest answer the privileged side can report; the
          // trusted key event is the behavioural verification.
          return true;
        };
        // Under a symbol rather than a name, like everything else this
        // program leaves on a page: a string property is listed by
        // getOwnPropertyNames and by Object.keys, and this one is installed
        // in every document there is — including the ones looking hardest for
        // exactly this.
        win.wrappedJSObject[Symbol.for('tweb.pierce')] =
          Cu.exportFunction(pierce, win.wrappedJSObject);
        win.wrappedJSObject[Symbol.for('tweb.nativeControl')] =
          Cu.exportFunction(pressNative, win.wrappedJSObject);
        win.wrappedJSObject[Symbol.for('tweb.focusNativeControl')] =
          Cu.exportFunction(focusNative, win.wrappedJSObject);
      } catch (e) { /* a window we cannot reach; the rest still get it */ }
    }, 'content-document-global-created');
  }
`;

// ---------------------------------------------------------------------------
// The browser's own lists: bookmarks, history and downloads
//
// BiDi does not answer for these and no content page should: Places lives in
// the parent process, behind APIs only privileged code may call, and Firefox
// has no equivalent of chrome://history that content can safely be pointed at.
//
// While we legitimately hold Marionette in chrome context at startup, an
// agent is installed in the parent process. It listens on a loopback-only raw
// TCP socket and calls PlacesUtils and Downloads directly. Raw TCP is the
// security boundary: webpages can issue HTTP requests and open WebSockets,
// but cannot speak arbitrary TCP. Firefox's own length-prefixed DevTools
// transport rejects both HTTP and WebSocket handshakes before dispatching a
// command. Local programs acting as the user need no second secret.
//
// The listener belongs to Firefox rather than this process. It therefore
// survives BiDi sessions, brokers and --keep-browser reconnects, and vanishes
// with the browser. No function or capability is installed in page context.
// ---------------------------------------------------------------------------

// Firefox's own folders are stored under internal names and shown to everyone
// under translated ones. A reader who has only ever seen the browser's words
// for them should not have to learn a second set here.
const FIREFOX_ROOT_LABELS = {
  toolbar_____: 'Bookmarks toolbar',
  menu________: 'Bookmarks menu',
  unfiled_____: 'Other bookmarks',
  mobile______: 'Mobile bookmarks',
};

// Runs in the parent process, where Places and Downloads are. Loaded as a
// subscript rather than left in the sandbox that installed it: that sandbox
// belongs to the Marionette session, which ends moments later, and a listener
// whose closure died with it would answer nothing.
const LIBRARY_PARENT_BODY = `
  const { PlacesUtils } = ChromeUtils.importESModule(
    "resource://gre/modules/PlacesUtils.sys.mjs");
  const { Downloads } = ChromeUtils.importESModule(
    "resource://gre/modules/Downloads.sys.mjs");
  const ROOTS = __ROOTS__;

  // Newest first, and no further back than the reader can use. This is
  // nsINavHistoryService — the query the Library itself runs.
  const history = function ({ max }) {
    const service = PlacesUtils.history.QueryInterface(Ci.nsINavHistoryService);
    const query = service.getNewQuery();
    const options = service.getNewQueryOptions();
    options.sortingMode = options.SORT_BY_DATE_DESCENDING;
    options.resultType = options.RESULTS_AS_URI;
    options.maxResults = max;
    const root = service.executeQuery(query, options).root;
    root.containerOpen = true;
    const out = [];
    try {
      for (let i = 0; i < root.childCount; i++) {
        const node = root.getChild(i);
        out.push({
          title: String(node.title || ""),
          url: String(node.uri || ""),
          when: node.time ? Math.round(node.time / 1000) : null,
        });
      }
    } finally {
      root.containerOpen = false;
    }
    return Promise.resolve(out);
  };

  // The whole bookmark tree, flattened, each entry carrying the folders above
  // it. A tag is stored as a bookmark too — under the tags root, pointing at
  // the page it tags — so that subtree is left out: listing it shows every
  // tagged page once per tag, filed under folders the reader never made.
  const bookmarks = async function () {
    const tree = await PlacesUtils.promiseBookmarksTree();
    const out = [];
    const walk = (node, trail) => {
      if (!node) return;
      if (node.guid === PlacesUtils.bookmarks.tagsGuid) return;
      if (node.uri) {
        out.push({
          title: String(node.title || ""),
          url: String(node.uri),
          folder: trail.join("/"),
          when: node.dateAdded ? Math.round(node.dateAdded / 1000) : null,
        });
        return;
      }
      const name = ROOTS[node.guid] || String(node.title || "");
      const here = name ? trail.concat([name]) : trail;
      for (const child of node.children || []) walk(child, here);
    };
    walk(tree, []);
    return out;
  };

  // Every download the browser still remembers, finished or not.
  const downloads = async function () {
    const list = await Downloads.getList(Downloads.ALL);
    const all = await list.getAll();
    return all.map((item) => {
      const target = (item.target && item.target.path) || "";
      const state = item.succeeded ? "complete"
        : item.canceled ? (item.hasPartialData ? "paused" : "cancelled")
        : item.error ? "failed"
        : item.stopped ? "stopped" : "in progress";
      return {
        title: target.split("/").pop() || target,
        file: target,
        url: String((item.source && item.source.url) || ""),
        state,
        bytes: Number(item.currentBytes) || 0,
        totalBytes: Number(item.totalBytes) || 0,
        when: item.startTime ? Number(new Date(item.startTime)) : null,
      };
    });
  };

  // Filing a bookmark, which is the one thing here that writes. It goes
  // through PlacesUtils like the reading does, because the bookmark tree is
  // the browser's own and its file is not ours to write into.
  //
  // A browser does not make a second bookmark of a page you have already
  // bookmarked; Firefox's own star opens the editor instead. So an existing
  // one is reported rather than duplicated. New ones are filed in "Other
  // bookmarks", which is where the star files one.
  const save = async function ({ url, title }) {
    const existing = await PlacesUtils.bookmarks.fetch({ url }).catch(() => null);
    if (existing) {
      const parent = await PlacesUtils.bookmarks.fetch(existing.parentGuid).catch(() => null);
      return {
        existed: true,
        title: String(existing.title || ""),
        folder: ROOTS[existing.parentGuid] || String((parent && parent.title) || ""),
      };
    }
    const guid = PlacesUtils.bookmarks.unfiledGuid;
    const made = await PlacesUtils.bookmarks.insert({ parentGuid: guid, url, title });
    return {
      existed: false,
      title: String(made.title || title || ""),
      folder: ROOTS[guid] || "Other bookmarks",
    };
  };

  // Some Firefox releases appear to publish automation state again while a
  // BiDi session starts. This agent outlives the Marionette session that
  // installed it, so diagnostics can observe each transition and the reader
  // can clear the keys after BiDi has finished. Keeping this in the parent
  // process avoids changing anything a webpage can inspect.
  const automationState = async function () {
    const keys = __ACTIVE_KEYS__;
    return Object.fromEntries(
      keys.map((key) => [key, Services.ppmm.sharedData.get(key) ?? false]));
  };
  const clearAutomation = async function () {
    const before = await automationState();
    for (const key of __ACTIVE_KEYS__) Services.ppmm.sharedData.set(key, false);
    Services.ppmm.sharedData.flush();
    return { before, after: await automationState() };
  };

  const answer = {
    bookmarks, history, downloads, save, automationState, clearAutomation,
  };
  const { require: devtoolsRequire } = ChromeUtils.importESModule(
    "resource://devtools/shared/loader/Loader.sys.mjs");
  const { DebuggerTransport } = devtoolsRequire(
    "resource://devtools/shared/transport/transport.js");
  const clients = new Set();
  const server = Cc["@mozilla.org/network/server-socket;1"]
    .createInstance(Ci.nsIServerSocket);

  // An ephemeral loopback port. A normal page cannot open raw TCP, and the
  // DevTools packet reader rejects the GET line of HTTP and WebSocket before
  // it can become an object below.
  server.init(-1, true, -1);
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIServerSocketListener"]),
    onSocketAccepted(_server, socket) {
      const input = socket.openInputStream(0, 0, 0);
      const output = socket.openOutputStream(0, 0, 0);
      const transport = new DebuggerTransport(input, output);
      clients.add(transport);
      transport.hooks = {
        async onPacket(packet) {
          const data = packet && typeof packet === "object" ? packet : {};
          const kind = String(data.kind || "");
          const ask = answer[kind];
          if (!ask) {
            transport.send({ error: "unknown list" });
            return;
          }
          const request = {
            max: Math.max(1, Math.min(5000, Number(data.max) || 1000)),
            url: data.url == null ? null : String(data.url).slice(0, 10000),
            title: data.title == null ? null : String(data.title).slice(0, 1000),
          };
          try {
            transport.send({ result: await ask(request) });
          } catch (e) {
            transport.send({ error: String((e && e.message) || e) });
          }
        },
        onBulkPacket() { transport.close(); },
        onTransportClosed() { clients.delete(transport); },
      };
      transport.ready();
    },
    onStopListening() {},
  };
  server.asyncListen(listener);

  // The message manager outlives the Marionette sandbox and holds this
  // closure, which in turn holds the server, listener and active transports.
  Services.ppmm.addMessageListener("tweb:library-agent-keepalive", function () {
    return server.port;
  });
`;

function libraryParentScript() {
  const parent = LIBRARY_PARENT_BODY
    .replace('__ROOTS__', JSON.stringify(FIREFOX_ROOT_LABELS))
    .replaceAll('__ACTIVE_KEYS__', JSON.stringify(ACTIVE_KEYS));
  return `${parent}\nreturn server.port;`;
}

// Loads the above into every content process, present and future.
const PIERCE_PARENT_SCRIPT = `
  const source = 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(PIERCE_CHILD_SCRIPT)});
  Services.ppmm.loadProcessScript(source, true);
  return true;
`;

// Marionette, used for one thing only.
//
// Its wire format is a length-prefixed JSON array: `<bytes>:[type, id, name,
// params]`. We need three commands and then we are done with it.
// ---------------------------------------------------------------------------

function marionetteCommand(port, commands, { timeout = MARIONETTE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let buffer = Buffer.alloc(0);
    let nextId = 1;
    const pending = new Map();
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      socket.end();
      err ? reject(err) : resolve(value);
    };

    const timer = setTimeout(() => finish(new Error('Marionette did not answer in time')), timeout);
    const send = (name, params = {}) => {
      const id = nextId++;
      const payload = JSON.stringify([0, id, name, params]);
      socket.write(`${Buffer.byteLength(payload)}:${payload}`);
      return new Promise((res, rej) => pending.set(id, { res, rej }));
    };

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const colon = buffer.indexOf(0x3a);
        if (colon < 0) return;
        const length = Number(buffer.subarray(0, colon).toString());
        if (!Number.isFinite(length)) return finish(new Error('unreadable Marionette framing'));
        const start = colon + 1;
        if (buffer.length < start + length) return;
        let message;
        try {
          message = JSON.parse(buffer.subarray(start, start + length).toString());
        } catch {
          return finish(new Error('unreadable Marionette message'));
        }
        buffer = buffer.subarray(start + length);
        if (!Array.isArray(message)) continue; // the handshake
        const [, id, error, result] = message;
        const waiter = pending.get(id);
        if (!waiter) continue;
        pending.delete(id);
        error ? waiter.rej(new Error(JSON.stringify(error).slice(0, 200))) : waiter.res(result);
      }
    });

    socket.on('error', (err) => finish(err));
    socket.on('connect', async () => {
      try {
        const value = await commands(send);
        clearTimeout(timer);
        finish(null, value);
      } catch (err) {
        clearTimeout(timer);
        finish(err);
      }
    });
  });
}

// Stops the browser announcing itself, and reports what it found.
//
// Marionette is left running afterwards: see the note at the top of this file.
// Disconnecting from it deletes the session it just created, which is also how
// the BiDi session that follows is able to start at all — the two share one
// slot.
async function clearAutomationFlag({ port, stopAfter = false } = {}) {
  let installFault = null;
  let libraryPort = null;
  return marionetteCommand(port, async (send) => {
    await send('WebDriver:NewSession', {});
    await send('Marionette:SetContext', { value: 'chrome' });
    const result = await send('WebDriver:ExecuteScript', { script: CLEAR_SCRIPT, args: [] });
    // The same session, because this is the only moment one can be had: from
    // here until the browser closes, the slot belongs to the reader's BiDi
    // connection.
    await send('WebDriver:ExecuteScript', { script: PIERCE_PARENT_SCRIPT, args: [] })
      .catch(() => { /* an older Firefox without ppmm; piercing is simply absent */ });
    await send('WebDriver:ExecuteScript', {
      script: libraryParentScript(), args: [],
    }).then((installed) => {
      const value = installed && installed.value;
      if (Number.isInteger(value) && value > 0) libraryPort = value;
    }).catch((err) => {
      // Not fatal: the reader works without its lists. But a browser that
      // silently has none is a browser nobody can debug, so say what
      // happened where the rest of the startup account goes.
      installFault = String((err && err.message) || err).slice(0, 300);
    });
    if (stopAfter) {
      send('WebDriver:ExecuteScript', {
        script: `const { Marionette } = ChromeUtils.importESModule(
          "chrome://remote/content/components/Marionette.sys.mjs"); Marionette.uninit(); return true;`,
        args: [],
      }).catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
    }
    const value = { ...((result && result.value) || {}), libraryPort };
    return installFault ? { ...value, libraryFault: installFault } : value;
  });
}

// Releases a WebDriver session that a dead reader left behind.
//
// No commands are sent and none are needed: Marionette deletes the session
// when a connection to it closes, whatever that connection did. Connecting and
// hanging up is the whole operation.
//
// This must only be used against a session whose owner is gone. Marionette
// cannot tell whose session it is deleting, so knocking while another reader
// is alive would take the page out from under them.
function releaseStrandedSession(port, { timeout = MARIONETTE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    let settled = false;
    const finish = (released) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(released);
    };
    socket.setTimeout(timeout);
    // The handshake proves Marionette is really there before we count it.
    socket.on('data', () => { socket.end(); finish(true); });
    socket.on('error', () => finish(false));
    socket.on('timeout', () => finish(false));
  });
}

// Starts an ordinary Firefox, silences the announcement, and returns where to
// attach. The caller verifies from inside a page before trusting any of it.
async function launchFirefox({
  profileDir = defaultProfileDir(), keepBrowser = false, log = () => {}, onStartup = () => {},
} = {}) {
  const found = findFirefox();
  if (!found) {
    throw new Error(
      `No Firefox found. Looked for: ${CANDIDATES.join(', ')}. `
      + 'Install Firefox, or use --browser chromium.',
    );
  }

  sayStartup(onStartup, 'Preparing Firefox profile…');
  log('firefox.environment', firefoxRuntimeInfo(found.executable));
  requireBrowserUser(found.name);
  requireReachableProfile(found, profileDir);
  fs.mkdirSync(profileDir, { recursive: true });

  // Before starting another one, take down any left behind by sessions that
  // are no longer running. This is where a browser orphaned by a crash — or
  // by the out-of-memory kill that a pile of them causes — is finally reaped.
  sweepStrandedBrowsers({ log });

  // A Firefox already serving this profile is one to join. Firefox allows one
  // instance per profile and refuses the second outright, so this is a
  // correctness fix as much as a speed one — and it is the whole of the
  // startup difference against Chromium, which has been quietly rejoining a
  // running browser in 50ms while Firefox cold-started every time.
  // Somewhere for the browser to describe its own windows to. Firefox needs
  // no command-line flag for this, but a private headless bus also gives its
  // GTK bridge the standard GNOME_ACCESSIBILITY startup signal; otherwise no
  // AT-SPI tree is registered. See a11y_bus.js and native_prompt.js.
  const a11y = await openAccessibilityBus({ log });
  if (!a11y.available) log('a11y.unavailable', { reason: a11y.reason });

  const running = await runningEndpoint(profileDir);
  if (running) {
    sayStartup(onStartup, 'Joining the running Firefox…');
    const record = readEndpointRecord(profileDir) || {};
    log('firefox.rejoin', { port: running, marionette: record.marionettePort || null, profileDir });
    return {
      child: null,
      port: running,
      marionettePort: record.marionettePort || null,
      endpoint: `ws://127.0.0.1:${running}/session`,
      executable: null,
      profileDir,
      cleared: null,
      rejoined: true,
      libraryPort: record.libraryPort || null,
      diagnostics: null,
      a11y,
    };
  }

  const port = await freePort();
  const marionettePort = await freePort();
  writeProfilePrefs(profileDir, {
    ...MEDIA_PREFS, ...PASSWORD_PREFS, ...DOWNLOAD_PREFS, 'marionette.port': marionettePort,
  });

  const args = [
    '--no-remote',
    '-profile', profileDir,
    `--remote-debugging-port=${port}`,
    '--marionette',
    // Required for the chrome-context clear below, and the reason Marionette
    // is shut down the moment it is done.
    '--remote-allow-system-access',
    'about:blank',
  ];

  const { command, args: spawnArgs } = buildCommand(found.executable, args);
  const displayNote = lastDisplayNote;
  sayStartup(onStartup, 'Starting Firefox…');
  log('firefox.spawn', { executable: found.executable, port, marionette: marionettePort, profileDir });

  // Detached, so the browser is not taken down by the terminal session ending
  // or the reader crashing. It is still killed explicitly on a clean exit
  // unless --keep-browser asked for it to stay, in which case the next session
  // rejoins it instead of waiting four seconds for a cold start.
  // Both output streams are captured: under xvfb-run the browser's stderr
  // arrives on stdout, so listening to stderr alone hears nothing.
  const child = spawn(command, spawnArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    // Only ever an addition: the bus this session started, for a machine that
    // had none of its own.
    env: { ...process.env, ...a11y.env },
  });
  const startup = watchChildStartup(child);
  child.unref();

  const spawnedAt = Date.now();
  const timeoutMs = startupTimeoutMs(STARTUP_TIMEOUT_MS);
  const deadline = spawnedAt + timeoutMs;
  let ready = false;
  let nextNotice = spawnedAt + STARTUP_NOTICE_MS;
  while (Date.now() < deadline) {
    if (await portOpen(port)) { ready = true; break; }
    if (startup.closed) break;
    if (Date.now() >= nextNotice) {
      sayStartup(onStartup, `Firefox is still starting (${Math.round((Date.now() - spawnedAt) / 1000)}s)…`);
      nextNotice += STARTUP_NOTICE_MS;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  const portMs = Date.now() - spawnedAt;
  if (!ready) {
    killProcessGroup(child.pid);
    throw browserStartupError({
      name: found.name,
      executable: found.executable,
      profileDir,
      port,
      timeoutMs,
      state: startup,
      context: [displayNote],
    });
  }
  startup.unref();

  writeEndpointRecord(profileDir, {
    port, marionettePort, pid: child.pid, startedAt: Date.now(),
  });
  recordBrowser({ pid: child.pid, port, profileDir, engine: 'firefox' });

  let cleared = null;
  const clearStarted = Date.now();
  const marionetteReady = await waitWithStartup(
    waitForEndpoint(marionettePort, Date.now() + MARIONETTE_TIMEOUT_MS),
    onStartup,
    'Firefox opened; waiting for its startup service',
  );
  if (marionetteReady) {
    try {
      cleared = await waitWithStartup(
        clearAutomationFlag({ port: marionettePort }),
        onStartup,
        'Preparing Firefox for browsing',
      );
      if (cleared.libraryPort) {
        writeEndpointRecord(profileDir, {
          ...(readEndpointRecord(profileDir) || {}), libraryPort: cleared.libraryPort,
        });
      }
      log('firefox.automation.cleared', { ...cleared, portMs, clearMs: Date.now() - clearStarted });
    } catch (err) {
      log('firefox.automation.error', { error: String(err.message || err).slice(0, 200) });
    }
  } else {
    log('firefox.automation.error', { error: 'Marionette never opened its port' });
  }

  return {
    child,
    port,
    marionettePort,
    libraryPort: cleared && cleared.libraryPort ? cleared.libraryPort : null,
    endpoint: `ws://127.0.0.1:${port}/session`,
    executable: found.executable,
    profileDir,
    cleared,
    rejoined: false,
    diagnostics: startup,
    a11y,
  };
}

module.exports = {
  launchFirefox, requireReachableProfile, clearAutomationFlag, releaseStrandedSession, findFirefox,
  defaultProfileDir, writeProfilePrefs, MEDIA_PREFS, PASSWORD_PREFS, ACTIVE_KEYS, CLEAR_SCRIPT,
  PIERCE_PARENT_SCRIPT, PIERCE_CHILD_SCRIPT,
  libraryParentScript, FIREFOX_ROOT_LABELS, MARIONETTE_TIMEOUT_MS,
  firefoxRuntimeInfo,
};
