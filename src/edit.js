'use strict';

const EDIT_ACTIONS = {
  'line-start': 'line-start',
  'line-end': 'line-end',
  'previous-character': 'character-backward',
  'next-character': 'character-forward',
  'edit-line-start': 'line-start',
  'edit-line-end': 'line-end',
  'edit-previous-character': 'character-backward',
  'edit-next-character': 'character-forward',
  'edit-backspace': 'backspace',
  'edit-delete': 'delete-forward',
  'edit-previous-word': 'word-backward',
  'edit-next-word': 'word-forward',
  'edit-backspace-word': 'delete-word-backward',
  'edit-delete-word': 'delete-word-forward',
  'edit-kill-start': 'delete-line-backward',
  'edit-kill-end': 'delete-line-forward',
};

// Asked of the editing keyboard rather than the browsing one, because they
// share keys that mean different things: Ctrl+D deletes a character here and
// files a bookmark out there. See EDITING_ACTIONS in keys.js.
function editAction(key, keymap) {
  return EDIT_ACTIONS[keymap.editingActionFor(key)] || null;
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

module.exports = { EDIT_ACTIONS, editAction, applyBufferEdit, sendFieldEdit, wordStart, wordEnd };
