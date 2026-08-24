'use strict';

const ACTION_KEYS = [
  ['line-start', 'Ctrl+A'],
  ['line-end', 'Ctrl+E'],
  ['character-backward', 'Ctrl+B'],
  ['character-forward', 'Ctrl+F'],
  ['backspace', 'Ctrl+H'],
  ['delete-forward', 'Ctrl+D'],
  ['delete-word-backward', 'Ctrl+W'],
  ['delete-line-backward', 'Ctrl+U'],
  ['delete-line-forward', 'Ctrl+K'],
  ['word-backward', 'Alt+B'],
  ['word-forward', 'Alt+F'],
  ['delete-word-forward', 'Alt+D'],
  ['character-backward', 'ArrowLeft'],
  ['character-forward', 'ArrowRight'],
  ['line-start', 'Home'],
  ['line-end', 'End'],
  ['backspace', 'Backspace'],
  ['delete-forward', 'Delete'],
];

function editAction(key, keymap) {
  const found = ACTION_KEYS.find(([, spec]) => keymap.isKey(key, spec));
  return found ? found[0] : null;
}

function wordStart(text, caret) {
  let at = caret;
  while (at > 0 && /\s/.test(text[at - 1])) at -= 1;
  while (at > 0 && !/\s/.test(text[at - 1])) at -= 1;
  return at;
}

function wordEnd(text, caret) {
  let at = caret;
  while (at < text.length && /\s/.test(text[at])) at += 1;
  while (at < text.length && !/\s/.test(text[at])) at += 1;
  return at;
}

function applyBufferEdit(buffer, action) {
  const { text } = buffer;
  const caret = Math.min(Math.max(buffer.caret, 0), text.length);
  let from = caret;
  let to = caret;

  if (action === 'line-start') buffer.caret = 0;
  else if (action === 'line-end') buffer.caret = text.length;
  else if (action === 'character-backward') buffer.caret = Math.max(caret - 1, 0);
  else if (action === 'character-forward') buffer.caret = Math.min(caret + 1, text.length);
  else if (action === 'word-backward') buffer.caret = wordStart(text, caret);
  else if (action === 'word-forward') buffer.caret = wordEnd(text, caret);
  else {
    if (action === 'backspace') from = Math.max(caret - 1, 0);
    else if (action === 'delete-forward') to = Math.min(caret + 1, text.length);
    else if (action === 'delete-word-backward') from = wordStart(text, caret);
    else if (action === 'delete-word-forward') to = wordEnd(text, caret);
    else if (action === 'delete-line-backward') from = 0;
    else if (action === 'delete-line-forward') to = text.length;
    else return false;
    buffer.text = text.slice(0, from) + text.slice(to);
    buffer.caret = from;
  }
  return true;
}

async function sendFieldEdit(keyboard, action) {
  const keys = {
    'line-start': ['Home'],
    'line-end': ['End'],
    'character-backward': ['ArrowLeft'],
    'character-forward': ['ArrowRight'],
    'word-backward': ['Control+ArrowLeft'],
    'word-forward': ['Control+ArrowRight'],
    backspace: ['Backspace'],
    'delete-forward': ['Delete'],
    'delete-word-backward': ['Control+Backspace'],
    'delete-word-forward': ['Control+Delete'],
    'delete-line-backward': ['Shift+Home', 'Backspace'],
    'delete-line-forward': ['Shift+End', 'Backspace'],
  }[action];
  if (!keys) return false;
  for (const key of keys) await keyboard.press(key);
  return true;
}

module.exports = { ACTION_KEYS, editAction, applyBufferEdit, sendFieldEdit, wordStart, wordEnd };
