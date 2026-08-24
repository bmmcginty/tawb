'use strict';

const { spawnSync } = require('node:child_process');

const KEY_DEFINITIONS = {
  Escape: { sequences: ['\x1b'] },
  Enter: { sequences: ['\r', '\n'] },
  Backspace: { sequences: ['\x7f', '\x08'] },
  ArrowUp: { cap: 'kcuu1', sequences: ['\x1b[A', '\x1bOA'] },
  ArrowDown: { cap: 'kcud1', sequences: ['\x1b[B', '\x1bOB'] },
  ArrowLeft: { cap: 'kcub1', sequences: ['\x1b[D', '\x1bOD'] },
  ArrowRight: { cap: 'kcuf1', sequences: ['\x1b[C', '\x1bOC'] },
  PageUp: { cap: 'kpp', sequences: ['\x1b[5~'] },
  PageDown: { cap: 'knp', sequences: ['\x1b[6~'] },
  Home: { cap: 'khome', sequences: ['\x1b[H', '\x1bOH', '\x1b[1~'] },
  End: { cap: 'kend', sequences: ['\x1b[F', '\x1bOF', '\x1b[4~'] },
  'Shift+F4': { cap: 'kf16', sequences: ['\x1b[1;2S', '\x1bO2S', '\x1b[14;2~', '\x1b[26~'] },
};

const ACTIONS = [
  ['quit', 'Quit', ['Ctrl+C', 'q']],
  ['location-bar', 'Location bar', ['Ctrl+L']],
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
  ['next-tab', 'Next tab', ['>']],
  ['previous-tab', 'Previous tab', ['<']],
  ['close-tab', 'Close tab', ['Shift+F4']],
  ['next-change', 'Next changed area', ['c']],
  ['previous-change', 'Previous changed area', ['C']],
  ['where', 'Report position', ['=']],
  ['toggle-live', 'Toggle live updates', ['L']],
  ['real-click', 'Real click', ['m']],
  ['find-forward', 'Find forward', ['/']],
  ['find-backward', 'Find backward', ['?']],
  ['repeat-find', 'Repeat find', ['Ctrl+G']],
  ['refresh', 'Refresh', ['r']],
  ['cycle-view', 'Cycle view', ['\\']],
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
  ['next-text', 'Next non-link text', ['n']],
  ['previous-text', 'Previous non-link text', ['N']],
  ['next-paragraph', 'Next paragraph', ['p']],
  ['previous-paragraph', 'Previous paragraph', ['P']],
  ['close-popup', 'Close open popup', ['Escape']],
].map(([id, label, defaults]) => ({ id, label, defaults }));

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

class Keymap {
  constructor({ terminfo = readTerminfo() } = {}) {
    this.terminfo = terminfo;
    this.actions = ACTIONS.map((action) => ({ ...action, bindings: [...action.defaults] }));
    this.byId = new Map(this.actions.map((action) => [action.id, action]));
    this.namedSequences = new Map();
    this.sequenceNames = new Map();
    this.buildNames();
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

  rebuild() {
    this.sequenceActions = new Map();
    for (const action of this.actions) {
      for (const binding of action.bindings) {
        for (const sequence of this.sequencesFor(binding)) this.sequenceActions.set(sequence, action.id);
      }
    }
  }

  actionFor(sequence) { return this.sequenceActions.get(sequence) || null; }
  isKey(sequence, name) { return this.sequencesFor(name).includes(sequence); }
}

module.exports = { ACTIONS, KEY_DEFINITIONS, Keymap, readTerminfo };
