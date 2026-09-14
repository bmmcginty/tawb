'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const KEY_DEFINITIONS = {
  Escape: { sequences: ['\x1b'] },
  Enter: { sequences: ['\r', '\n'] },
  Backspace: { sequences: ['\x7f', '\x08'] },
  Delete: { cap: 'kdch1', sequences: ['\x1b[3~'] },
  ArrowUp: { cap: 'kcuu1', sequences: ['\x1b[A', '\x1bOA'] },
  ArrowDown: { cap: 'kcud1', sequences: ['\x1b[B', '\x1bOB'] },
  ArrowLeft: { cap: 'kcub1', sequences: ['\x1b[D', '\x1bOD'] },
  ArrowRight: { cap: 'kcuf1', sequences: ['\x1b[C', '\x1bOC'] },
  'Alt+ArrowLeft': { cap: 'kLFT3', sequences: ['\x1b[1;3D', '\x1b[3D'] },
  'Alt+ArrowRight': { cap: 'kRIT3', sequences: ['\x1b[1;3C', '\x1b[3C'] },
  PageUp: { cap: 'kpp', sequences: ['\x1b[5~'] },
  PageDown: { cap: 'knp', sequences: ['\x1b[6~'] },
  Home: { cap: 'khome', sequences: ['\x1b[H', '\x1bOH', '\x1b[1~'] },
  End: { cap: 'kend', sequences: ['\x1b[F', '\x1bOF', '\x1b[4~'] },
  F5: { cap: 'kf5', sequences: ['\x1b[15~', '\x1b[[E'] },
  'Shift+F4': { cap: 'kf16', sequences: ['\x1b[1;2S', '\x1bO2S', '\x1b[14;2~', '\x1b[26~'] },
  // Tab is a control character rather than an escape sequence, so it is named
  // here only to be displayed as Tab instead of Ctrl+I. Shift+Tab has no such
  // luck: terminals disagree, so terminfo's back-tab is asked for first.
  Tab: { sequences: ['\t'] },
  'Shift+Tab': { cap: 'kcbt', sequences: ['\x1b[Z'] },
};

const ACTIONS = [
  ['quit', 'Quit', ['Ctrl+C', 'q']],
  ['location-bar', 'Location bar', ['Ctrl+L']],
  ['history-back', 'Back in page history', ['Alt+-']],
  ['history-forward', 'Forward in page history', ['Alt++']],
  ['activate', 'Activate', ['Enter']],
  ['next-line', 'Next line', ['ArrowDown', 'j']],
  ['previous-line', 'Previous line', ['ArrowUp', 'k']],
  ['next-character', 'Next character', ['ArrowRight']],
  ['previous-character', 'Previous character', ['ArrowLeft']],
  ['next-screen', 'Next screen', ['PageDown']],
  ['previous-screen', 'Previous screen', ['PageUp']],
  ['top', 'Top of page', ['g']],
  ['bottom', 'Bottom of page', ['G']],
  ['line-start', 'Start of line', ['Home']],
  ['line-end', 'End of line', ['End']],
  ['edit-line-start', 'Start of field while editing', ['Ctrl+A']],
  ['edit-line-end', 'End of field while editing', ['Ctrl+E']],
  ['edit-previous-character', 'Previous character while editing', ['Ctrl+B']],
  ['edit-next-character', 'Next character while editing', ['Ctrl+F']],
  ['edit-backspace', 'Delete previous character while editing', ['Backspace', 'Ctrl+H']],
  ['edit-delete', 'Delete next character while editing', ['Delete', 'Ctrl+D']],
  ['edit-previous-word', 'Previous word while editing', ['Alt+B']],
  ['edit-next-word', 'Next word while editing', ['Alt+F']],
  ['edit-backspace-word', 'Delete previous word while editing', ['Ctrl+W']],
  ['edit-delete-word', 'Delete next word while editing', ['Alt+D']],
  ['edit-kill-start', 'Delete to start while editing', ['Ctrl+U']],
  ['edit-kill-end', 'Delete to end while editing', ['Ctrl+K']],
  ['new-tab', 'New tab', ['Ctrl+T']],
  // The browser's own lists. Chrome and Firefox reach these with Ctrl+H,
  // Ctrl+J and Ctrl+Shift+O, and two of those three cannot exist in a
  // terminal: Ctrl+H is Backspace and Ctrl+J is Enter, and both are bytes a
  // terminal has spent since before there were browsers. Ctrl+Shift+O arrives
  // as plain Ctrl+O and is kept; the other two become the Alt keys of the
  // same letters, which is as near as the terminal allows.
  ['bookmarks', 'Bookmarks', ['Ctrl+O']],
  // Ctrl+D is what every browser files a page with, and it is one of the few
  // browser keys a terminal has not already spent: Ctrl+D is end-of-input to a
  // shell, but nothing is reading a line here, and the editing actions have
  // their own Ctrl+D for the character under the cursor while typing.
  ['add-bookmark', 'Bookmark this page', ['Ctrl+D']],
  ['history', 'History', ['Alt+H']],
  ['downloads', 'Downloads', ['Alt+J']],
  // Alt-click is both browsers' native "download this link" gesture. `d` is
  // the terminal-reader convention and leaves Alt+J as the downloads list.
  ['download-link', 'Download link under the cursor', ['d']],
  // A question the browser asked and the reader stepped away from. Escaping
  // one of those dialogs answers nothing — it is not this program's place to
  // press a button nobody chose — so there has to be a way back to it.
  ['browser-question', 'Answer the browser again', ['Alt+Q']],
  ['next-tab', 'Next tab', ['>']],
  ['previous-tab', 'Previous tab', ['<']],
  ['close-tab', 'Close tab', ['Shift+F4']],
  ['next-change', 'Next changed area', ['c']],
  ['previous-change', 'Previous changed area', ['C']],
  ['where', 'Report position', ['=']],
  ['toggle-live', 'Toggle live updates', ['L']],
  // Whether the status row says where the link under the cursor goes. A
  // graphical browser has no switch for this because its status bar costs
  // nothing to ignore; a row that speaks costs a sentence every time the
  // cursor lands on a link, which is a great deal of speech on a page that
  // is mostly links. `u` for the address it shows.
  ['toggle-link-address', 'Toggle link addresses', ['u']],
  // Whether a link that stays on this site is said in full or as the path
  // alone. Uppercase of the switch that turns the row on, because it is the
  // same row said a shorter way.
  ['toggle-short-links', 'Toggle short link addresses', ['U']],
  ['real-click', 'Real click', ['m']],
  ['find-forward', 'Find forward', ['/']],
  ['find-backward', 'Find backward', ['?']],
  ['repeat-find', 'Repeat find', ['Ctrl+G']],
  ['refresh', 'Rescan page view', ['r']],
  ['reload-page', 'Reload page', ['F5']],
  ['cycle-view', 'Cycle view', ['\\']],
  ['keyboard-wizard', 'Keyboard wizard', ['Alt+?']],
  ['next-heading', 'Next heading', ['h']],
  ['previous-heading', 'Previous heading', ['H']],
  ['next-link', 'Next link', ['l']],
  // Uppercase L is already the live-update switch, so backward link starts
  // unbound rather than silently changing either long-standing key.
  ['previous-link', 'Previous link', []],
  ['next-field', 'Next form field', ['f']],
  ['previous-field', 'Previous form field', ['F']],
  ['next-button', 'Next button', ['b']],
  ['previous-button', 'Previous button', ['B']],
  // Tab and Shift+Tab, doing here what they do in a graphical browser: move
  // to the next thing you can interact with, whichever of the three kinds it
  // is. The single-letter jumps above stay, because knowing you are on the
  // next *button* is worth a key of its own.
  ['next-focusable', 'Next link, button or form field', ['Tab']],
  ['previous-focusable', 'Previous link, button or form field', ['Shift+Tab']],
  ['next-text', 'Next non-link text', ['n']],
  ['previous-text', 'Previous non-link text', ['N']],
  ['next-paragraph', 'Next paragraph', ['p']],
  ['previous-paragraph', 'Previous paragraph', ['P']],
  ['close-popup', 'Close open popup', ['Escape']],
].map(([id, label, defaults]) => ({ id, label, defaults }));

// Which actions mean anything while a field is being edited.
//
// Editing and browsing are different keyboards on the same keys, and Ctrl+D is
// where that stops being a detail: browsers file a bookmark with it, readline
// deletes the character under the cursor with it, and both are right. One flat
// sequence-to-action map cannot hold both, and whichever was listed last would
// silently take the key from the other — which is the thing this file exists to
// prevent.
//
// So a second map is built over these ids alone, and it is the one consulted
// while typing. The four that are not `edit-` prefixed are the browse
// movements editing shares on purpose: Home and the arrows do the same thing in
// a field as on a line, and rebinding them once should move both.
const EDITING_ACTIONS = new Set([
  'line-start', 'line-end', 'previous-character', 'next-character',
  ...ACTIONS.map((action) => action.id).filter((id) => id.startsWith('edit-')),
]);

function configPath(env = process.env, home = os.homedir()) {
  const base = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(base, 'tawb', 'keys.json');
}

function readTerminfo({ env = process.env, run = spawnSync } = {}) {
  const found = {};
  if (!env.TERM) return found;
  for (const [name, definition] of Object.entries(KEY_DEFINITIONS)) {
    if (!definition.cap) continue;
    const result = run('tput', [definition.cap], {
      env, encoding: null, timeout: 500, stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result && result.status === 0 && result.stdout && result.stdout.length) {
      found[name] = result.stdout.toString('utf8');
    }
  }
  return found;
}

function ctrlSequence(letter) {
  const code = letter.toUpperCase().charCodeAt(0);
  return code >= 64 && code <= 95 ? String.fromCharCode(code - 64) : null;
}

function rawSpec(sequence) {
  return `raw:${Buffer.from(sequence, 'utf8').toString('base64')}`;
}

class Keymap {
  constructor({ terminfo = readTerminfo(), file = configPath(), load = true } = {}) {
    this.file = file;
    this.terminfo = terminfo;
    this.actions = ACTIONS.map((action) => ({ ...action, bindings: [...action.defaults] }));
    this.byId = new Map(this.actions.map((action) => [action.id, action]));
    this.namedSequences = new Map();
    this.sequenceNames = new Map();
    this.buildNames();
    if (load) this.load();
    this.rebuild();
  }

  buildNames() {
    for (const [name, definition] of Object.entries(KEY_DEFINITIONS)) {
      const sequences = [...definition.sequences];
      if (this.terminfo[name]) sequences.unshift(this.terminfo[name]);
      this.namedSequences.set(name, [...new Set(sequences)]);
      for (const sequence of sequences) {
        if (!this.sequenceNames.has(sequence)) this.sequenceNames.set(sequence, name);
      }
    }
  }

  sequencesFor(spec) {
    if (this.namedSequences.has(spec)) return this.namedSequences.get(spec);
    if (spec.startsWith('raw:')) {
      try { return [Buffer.from(spec.slice(4), 'base64').toString('utf8')]; } catch { return []; }
    }
    const ctrl = /^Ctrl\+(.+)$/i.exec(spec);
    if (ctrl && ctrl[1].length === 1) return [ctrlSequence(ctrl[1])].filter(Boolean);
    const altShift = /^Alt\+Shift\+(.+)$/i.exec(spec);
    if (altShift && [...altShift[1]].length === 1) return [`\x1b${altShift[1].toUpperCase()}`];
    const alt = /^Alt\+(.+)$/i.exec(spec);
    if (alt && [...alt[1]].length === 1) return [`\x1b${alt[1].toLowerCase()}`];
    return [...spec].length === 1 ? [spec] : [];
  }

  nameForSequence(sequence) {
    if (this.sequenceNames.has(sequence)) return this.sequenceNames.get(sequence);
    if (sequence.length === 1) {
      const code = sequence.charCodeAt(0);
      if (code >= 1 && code <= 26) return `Ctrl+${String.fromCharCode(64 + code)}`;
      if (code === 0) return 'Ctrl+@';
      if (code >= 32) return sequence;
    }
    if (sequence.startsWith('\x1b') && [...sequence.slice(1)].length === 1) {
      const character = sequence.slice(1);
      if (/^[A-Z]$/.test(character)) return `Alt+Shift+${character}`;
      return `Alt+${character.toUpperCase()}`;
    }
    return rawSpec(sequence);
  }

  display(spec) {
    return spec.startsWith('raw:') ? `sequence ${JSON.stringify(this.sequencesFor(spec)[0] || '')}` : spec;
  }

  load() {
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return; }
    if (!parsed || typeof parsed.actions !== 'object') return;
    for (const [id, bindings] of Object.entries(parsed.actions)) {
      const action = this.byId.get(id);
      if (!action || !Array.isArray(bindings) || !bindings.every((item) => typeof item === 'string')) continue;
      action.bindings = [...new Set(bindings.filter((item) => this.sequencesFor(item).length))];
    }
  }

  rebuild() {
    this.sequenceActions = new Map();
    this.editingActions = new Map();
    for (const action of this.actions) {
      for (const binding of action.bindings) {
        for (const sequence of this.sequencesFor(binding)) {
          this.sequenceActions.set(sequence, action.id);
          if (EDITING_ACTIONS.has(action.id)) this.editingActions.set(sequence, action.id);
        }
      }
    }
  }

  actionFor(sequence) { return this.sequenceActions.get(sequence) || null; }

  // The same question asked from inside a field. See EDITING_ACTIONS.
  editingActionFor(sequence) { return this.editingActions.get(sequence) || null; }
  isKey(sequence, name) { return this.sequencesFor(name).includes(sequence); }

  // Which other actions would lose a binding if this one took the key. The
  // wizard asks before taking a key away from something the reader is still
  // using, so it has to know what it would be taking it from.
  conflicts(id, spec) {
    const owners = new Set();
    for (const sequence of this.sequencesFor(spec)) {
      const owner = this.sequenceActions.get(sequence);
      if (owner && owner !== id) owners.add(owner);
    }
    return [...owners].map((owner) => this.byId.get(owner));
  }

  assign(id, sequence, { add = false } = {}) {
    const action = this.byId.get(id);
    if (!action) return null;
    const binding = this.nameForSequence(sequence);
    const sequences = new Set(this.sequencesFor(binding));
    let displaced = null;
    for (const other of this.actions) {
      if (other === action) continue;
      const kept = other.bindings.filter((item) =>
        !this.sequencesFor(item).some((candidate) => sequences.has(candidate)));
      if (kept.length !== other.bindings.length) displaced = other;
      other.bindings = kept;
    }
    action.bindings = add
      ? [...new Set([...action.bindings, binding])]
      : [binding];
    this.rebuild();
    return { binding, displaced };
  }

  unbind(id) {
    const action = this.byId.get(id);
    if (!action) return;
    action.bindings = [];
    this.rebuild();
  }

  reset() {
    for (const action of this.actions) action.bindings = [...action.defaults];
    this.rebuild();
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const contents = `${JSON.stringify({ version: 1, actions: Object.fromEntries(
      this.actions.map((action) => [action.id, action.bindings]),
    ) }, null, 2)}\n`;
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, contents, { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
}

module.exports = {
  ACTIONS, EDITING_ACTIONS, KEY_DEFINITIONS, Keymap, configPath, readTerminfo, rawSpec,
};
