'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function settingsPath(env = process.env, home = os.homedir()) {
  const base = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(base, 'tawb', 'settings');
}

// Read options with the same quoting and escaping people use at a shell, but
// without executing a shell or expanding variables. A comment begins with #
// where a new argument could begin; # inside an argument remains literal.
function splitSettings(text) {
  const args = [];
  let word = '';
  let started = false;
  let quote = null;
  let escaped = false;
  let comment = false;

  const finishWord = () => {
    if (!started) return;
    args.push(word);
    word = '';
    started = false;
  };

  for (const character of String(text)) {
    if (comment) {
      if (character === '\n') comment = false;
      continue;
    }
    if (escaped) {
      word += character;
      started = true;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else word += character;
      started = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (character === '#' && !started) {
      comment = true;
      continue;
    }
    if (/\s/.test(character)) {
      finishWord();
      continue;
    }
    word += character;
    started = true;
  }

  if (escaped) throw new Error('unfinished escape');
  if (quote) throw new Error(`unterminated ${quote} quote`);
  finishWord();
  return args;
}

function readSettings({ env = process.env, home = os.homedir(), file = null } = {}) {
  const target = file || settingsPath(env, home);
  let text;
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  try {
    return splitSettings(text);
  } catch (err) {
    throw new Error(`Cannot read settings from ${target}: ${err.message}`);
  }
}

module.exports = { settingsPath, splitSettings, readSettings };
