'use strict';

// A file chooser the browser cannot draw for itself.
//
// Both Linux browsers ask a desktop portal for a file or folder rather than
// drawing one: Chromium's `SelectFileDialogLinuxPortal` and GTK's
// `GtkFileChooserNative`, which Firefox uses, both call
// `org.freedesktop.portal.FileChooser`. On a desktop that is the right thing
// and somebody else answers. On a machine where TAWB had to make the session
// bus for the browser — a terminal, a container, a browser under Xvfb — nobody
// answers, and the browser is left with a chooser that never appears. Chromium
// never gets as far as drawing one at all: its only file dialog in this build
// is the portal.
//
// So on a bus this program owns, the portal name is claimed and this answers.
// It is a frontend, not a backend: the name the callers use is
// `org.freedesktop.portal.Desktop`, and no backend is consulted. The desktop's
// own portal is left alone — the name is claimed only if nobody owns it.
//
// What is implemented is one interface, FileChooser, and the request object it
// answers with. Everything else on the portal is answered "unknown method",
// which is what any caller gets on a bus with no portal on it and is a
// state both browsers tolerate.
//
// The shape of a request is fixed by the specification and is not ours to
// choose:
//
//   * the client makes up a token, puts it in `handle_token`, and subscribes to
//     `Response` on `/org/freedesktop/portal/desktop/request/<sender>/<token>`
//     *before* calling, because the answer may arrive before the call returns;
//   * the sender is the caller's unique name with the leading colon dropped
//     and every dot replaced by an underscore;
//   * the call returns that object path, and the answer arrives later as a
//     signal on it.
//
// Answering anything other than that exact path leaves the client waiting for
// a signal that will never come, which looks exactly like a hang.

const PORTAL_NAME = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const FILECHOOSER = 'org.freedesktop.portal.FileChooser';
const REQUEST = 'org.freedesktop.portal.Request';
// How a program that is not sandboxed tells the portal what it is. Chromium
// registers its application id before it uses any portal interface, and a
// portal that answers "unknown method" is one it treats as not there.
const HOST_REGISTRY = 'org.freedesktop.host.portal.Registry';
const PROPERTIES = 'org.freedesktop.DBus.Properties';

// What this frontend answers for. The real one answers 4 on this machine; a
// caller uses it to decide whether to ask for newer options, and claiming more
// than is implemented would invite exactly those options.
const VERSION = 4;

// The two answers a request can have. Zero is "the reader chose something";
// one is "the reader declined", which is what makes Escape a cancellation
// rather than a chooser that waits for ever.
const RESPONSE_SUCCESS = 0;
const RESPONSE_CANCELLED = 1;

// Callers build the request path themselves, so it has to be reproducible.
function requestPathFor(sender, token) {
  const who = String(sender || '').replace(/^:/, '').replace(/\./g, '_');
  return `${PORTAL_PATH}/request/${who}/${token}`;
}

// One entry of a `a{sv}` dictionary. On the wire a dictionary arrives as the
// pairs it is made of, so this is a search and not a lookup.
function optionOf(options, name) {
  if (!options) return undefined;
  if (Array.isArray(options)) {
    for (const entry of options) {
      if (Array.isArray(entry) && entry[0] === name) return entry[1];
    }
    return undefined;
  }
  return options[name];
}

// `current_folder` travels as a byte string with a trailing nul rather than as
// a string, which is the portal's own convention for a path.
function optionText(value) {
  if (typeof value === 'string') return value.replace(/\0+$/, '');
  if (Array.isArray(value)) {
    return Buffer.from(value.map((each) => Number(each) & 0xff)).toString('utf8').replace(/\0+$/, '');
  }
  return '';
}

// Which of the options a caller may pass are worth reading. The rest —
// `modal`, `filters`, `current_filter`, `accept_label`, `choices` — describe
// how the desktop's own chooser should look, and none of them survive being
// turned into a line on a terminal.
function readOptions(options) {
  const token = optionOf(options, 'handle_token');
  return {
    directory: optionOf(options, 'directory') === true,
    multiple: optionOf(options, 'multiple') === true,
    handleToken: typeof token === 'string' && token ? token : null,
    currentFolder: optionText(optionOf(options, 'current_folder')),
    currentName: optionText(optionOf(options, 'current_name')),
  };
}

// A file URI for an absolute path. Percent-encoding is not optional: a name
// with a space in it is the ordinary case, and a URI that does not encode it
// is a name the browser cannot open.
function fileUri(path) {
  const encoded = String(path).split('/').map((part) => encodeURIComponent(part)).join('/');
  return `file://${encoded.startsWith('/') ? '' : '/'}${encoded}`;
}

// What a caller asked for, in the terms the question is put in. Saving is
// never multiple and never a folder: the interface already says which of the
// two it is, and options claiming otherwise ask for something the interface
// cannot mean.
function readRequest(options, saving) {
  const held = readOptions(options);
  return {
    directory: saving ? false : held.directory,
    multiple: saving ? false : held.multiple,
    token: held.handleToken,
    initial: held.currentFolder,
    name: held.currentName,
    saving,
  };
}

function fileUriBody(paths) {
  return paths.map(fileUri);
}

// Serve FileChooser on a connection this program already holds.
//
// `ask` is what puts the question in front of the reader: it is given what the
// caller wants and answers with chosen paths, or null when the reader declined.
// It may be asynchronous; it is never awaited before the method call returns,
// because the reply has to carry the request path immediately.
//
// `allow` is asked whether this sender may raise a chooser at all. The bus is
// already a boundary — only the browser this program launched is on a bus this
// program owns — but a chooser is a question put to a person, and only the
// browser being read should be able to put one.
// `translate` turns the paths the reader chose into paths the caller can
// actually open. A caller that shares this program's filesystem needs no
// translation and the default answers with what it was given. A Flatpak
// browser does not share it: see flatpak.js, where a chosen path is
// re-exported through the document portal. Answering null means the chosen
// path could not be made reachable, and the request is cancelled rather than
// answered with a path the caller would fail to find.
function serveFileChooser(connection, {
  ask = () => null, log = () => {}, allow = () => true, translate = (paths) => paths,
} = {}) {
  // The question is answered by whoever is reading, and that is not known when
  // the name is claimed: Chromium decides once, at startup, whether there is a
  // portal at all, so the name has to be owned before the browser starts and
  // the terminal is only ready a moment later.
  let handler = ask;
  const pending = new Map();
  const running = new Set();
  const registered = new Map();
  let answered = 0;
  let stopped = false;
  let counter = 0;

  const answer = (path, code, paths) => {
    if (stopped) return;
    const options = [[
      'uris', { signature: 'as', value: paths && paths.length ? fileUriBody(paths) : [] },
    ]];
    connection.emitSignal({
      path, iface: REQUEST, member: 'Response', signature: 'ua{sv}',
      body: [code, options],
    });
  };

  const run = async (path, request, sender) => {
    let paths = null;
    try {
      paths = await handler(request);
    } catch (err) {
      log('portal.ask.failed', { error: String(err.message || err).slice(0, 160) });
      paths = null;
    }
    // A request the client closed while the reader was still choosing has
    // already been answered, with the cancelled code, by the Close that
    // removed it. Answering again would put a second Response on a path the
    // specification gives one answer — and the second one would carry the
    // path the reader chose after the browser had stopped waiting for it.
    if (!pending.has(path)) {
      log('portal.abandoned', {
        kind: request.directory ? 'directory' : 'file',
        chosen: (paths || []).length,
      });
      return;
    }
    pending.delete(path);

    // The caller may not share this program's filesystem, and a path it
    // cannot open is worse than no answer: the browser finds nothing and says
    // nothing about why.
    let reachable = paths;
    if (paths && paths.length) {
      try {
        reachable = await translate(paths, { sender, request });
      } catch (err) {
        log('portal.translate.failed', { error: String(err.message || err).slice(0, 160) });
        reachable = null;
      }
      if (!reachable || !reachable.length) {
        answer(path, RESPONSE_CANCELLED, null);
        answered += 1;
        log('portal.unreachable', {
          kind: request.directory ? 'directory' : 'file',
          chosen: paths.length,
        });
        return;
      }
    }

    answer(path, reachable && reachable.length ? RESPONSE_SUCCESS : RESPONSE_CANCELLED, reachable);
    answered += 1;
    log('portal.responded', {
      kind: request.directory ? 'directory' : 'file',
      chosen: (reachable || []).length,
    });
  };

  connection.onMethodCall((message, { reply, fail }) => {
    if (stopped) return false;

    // A request object answered rather than asked: cancellation is the only
    // method one has, and it comes from the client that raised it.
    if (message.path && message.path.startsWith(`${PORTAL_PATH}/request/`)) {
      const held = pending.get(message.path);
      if (message.iface !== REQUEST) return false;
      if (message.member !== 'Close') return false;
      if (!held) {
        fail('org.freedesktop.DBus.Error.UnknownObject', 'no such request');
        return true;
      }
      pending.delete(message.path);
      reply();
      answer(message.path, RESPONSE_CANCELLED, null);
      log('portal.closed', {});
      return true;
    }

    if (message.path !== PORTAL_PATH) return false;

    if (message.iface === HOST_REGISTRY) {
      if (message.member !== 'Register') return false;
      const [appId] = message.body || [];
      // Remembered rather than checked: this program already knows which
      // browser it launched and which connection is it.
      if (typeof appId === 'string') registered.set(message.sender, appId);
      log('portal.registered', { appId: String(appId || '').slice(0, 60) });
      reply();
      return true;
    }

    if (message.iface === PROPERTIES) {
      if (message.member === 'Get') {
        const [wanted, property] = message.body || [];
        if (wanted !== FILECHOOSER) return false;
        if (property === 'version') {
          reply('v', [{ signature: 'u', value: VERSION }]);
          return true;
        }
        fail('org.freedesktop.DBus.Error.UnknownProperty', `no ${property} here`);
        return true;
      }
      if (message.member === 'GetAll') {
        reply('a{sv}', [[['version', { signature: 'u', value: VERSION }]]]);
        return true;
      }
      return false;
    }

    if (message.iface !== FILECHOOSER) {
      log('portal.other', {
        iface: String(message.iface || '').slice(0, 60),
        member: String(message.member || '').slice(0, 40),
      });
      return false;
    }
    if (message.member !== 'OpenFile' && message.member !== 'SaveFile') {
      log('portal.other', { iface: String(message.iface).slice(0, 60),
        member: String(message.member || '').slice(0, 40) });
      return false;
    }

    const sender = message.sender;
    if (!allow(sender)) {
      fail('org.freedesktop.portal.Error.NotAllowed', 'this sender may not choose files');
      return true;
    }

    const [, title, rawOptions] = message.body || [];
    const saving = message.member === 'SaveFile';
    const held = readRequest(rawOptions, saving);
    counter += 1;
    const token = held.token || `tawb_${counter}`;
    const path = requestPathFor(sender, token);

    const request = {
      directory: held.directory,
      multiple: held.multiple,
      title: typeof title === 'string' ? title : '',
      initial: held.initial,
      name: held.name,
      saving,
    };
    pending.set(path, request);
    // The path first, then the question: the client is already listening and
    // cannot hear an answer to a call that has not returned.
    reply('o', [path]);
    log('portal.chooser', {
      kind: request.directory ? 'directory' : 'file',
      sender: String(sender || '').slice(0, 40),
    });
    const task = Promise.resolve().then(() => run(path, request, sender));
    running.add(task);
    task.catch(() => {}).then(() => running.delete(task));
    return true;
  });

  return {
    version: VERSION,
    // Whoever is reading, from now on. Before this the chooser answers
    // "nothing was chosen" rather than leaving a browser waiting.
    setAsk(next) {
      handler = next;
    },
    // Every question has been answered. A test needs this to know when the
    // terminal is finished with, and so does a shutdown that would rather not
    // leave a browser waiting on a path it will never get.
    async idle() {
      while (running.size) await Promise.all([...running]);
      return answered;
    },
    openRequests() {
      return [...pending.keys()];
    },
    registrations() {
      return new Map(registered);
    },
    stop() {
      // Answer before going quiet, or the browser is left holding a request
      // nothing will ever speak to again.
      const waiting = [...pending.keys()];
      pending.clear();
      for (const path of waiting) answer(path, RESPONSE_CANCELLED, null);
      stopped = true;
    },
  };
}

module.exports = {
  serveFileChooser, requestPathFor, readOptions, readRequest, fileUri, fileUriBody,
  PORTAL_NAME, PORTAL_PATH, FILECHOOSER, REQUEST, PROPERTIES, VERSION,
  RESPONSE_SUCCESS, RESPONSE_CANCELLED,
};
