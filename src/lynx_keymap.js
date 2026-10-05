'use strict';

// The Lynx key file, written in Lynx's own words.
//
// `keys-lynx.json` is keyed by Lynx function name rather than by TAWB's action
// id, so the file, the imported map and the keyboard screen all say the same
// thing: LIST, ADDRLIST, NEXT_LINK, FASTFORW_LINK, DOWN_LINK. A reader who
// knows Lynx can read their own bindings without a translation table, and one
// Lynx function is always one entry, because the interface keeps them as
// separate actions rather than folding them together.
//
// The things TAWB can do and Lynx cannot get a name of their own in the same
// namespace, under a TAWB_ prefix. That keeps one lookup table and one file
// rather than two of each, and says plainly which entries are not Lynx's.

const { BROWSE_FUNCTIONS, EDIT_FUNCTIONS } = require('./lynx_config');

// Every Lynx function the interface acts on, plus the extensions.
const EXTENSION_FUNCTIONS = {
  TAWB_CYCLE_VIEW: 'cycle-view',
  TAWB_PAGE_KEYBOARD: 'page-keyboard',
  TAWB_REAL_CLICK: 'real-click',
  TAWB_HOVER_LINE: 'hover-line',
  TAWB_BROWSER_QUESTION: 'browser-question',
  TAWB_CLOSE_POPUP: 'close-popup',
  TAWB_NEW_TAB: 'new-tab',
  TAWB_NEXT_TAB: 'next-tab',
  TAWB_PREVIOUS_TAB: 'previous-tab',
  TAWB_CLOSE_TAB: 'close-tab',
};

const FUNCTION_ACTIONS = { ...BROWSE_FUNCTIONS, ...EDIT_FUNCTIONS, ...EXTENSION_FUNCTIONS };

// The name an action is written under. Lynx's own names come first, so an
// action with both a Lynx function and an extension is written as the function.
const ACTION_FUNCTIONS = new Map();
for (const table of [BROWSE_FUNCTIONS, EDIT_FUNCTIONS, EXTENSION_FUNCTIONS]) {
  for (const [name, action] of Object.entries(table)) {
    if (!ACTION_FUNCTIONS.has(action)) ACTION_FUNCTIONS.set(action, name);
  }
}

const VERSION = 2;
const ACTIONS_VERSION = 1;

function actionForFunction(name) {
  return FUNCTION_ACTIONS[name] || null;
}

function functionForAction(id) {
  return ACTION_FUNCTIONS.get(id) || null;
}

// The function name a keymap should write each of its actions under, for the
// screen that shows them. Empty for the ordinary interface, whose actions are
// not Lynx's.
function functionNames(actions) {
  const names = new Map();
  for (const action of actions) {
    const name = functionForAction(action.id);
    if (name) names.set(action.id, name);
  }
  return names;
}

// A key file as action bindings, whichever version wrote it.
//
// Version 1 was keyed by TAWB action id and was written before the functions
// were given their own actions. It is read here rather than by a separate
// migration step, so a reader who upgrades and opens the keyboard screen has
// their bindings and then saves them in the new shape — no editing by hand.
function parseKeyFile(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  if (parsed.version === VERSION && parsed.functions && typeof parsed.functions === 'object') {
    const actions = {};
    for (const [name, bindings] of Object.entries(parsed.functions)) {
      const action = actionForFunction(name);
      if (!action) continue;
      if (!Array.isArray(bindings) || !bindings.every((item) => typeof item === 'string')) continue;
      actions[action] = bindings;
    }
    return actions;
  }

  if (parsed.version === ACTIONS_VERSION
      && parsed.actions && typeof parsed.actions === 'object') {
    return parsed.actions;
  }

  return null;
}

function serialiseKeyFile(actions) {
  const functions = {};
  for (const action of actions) {
    const name = functionForAction(action.id);
    // An action no Lynx function names cannot be written in a file keyed by
    // Lynx's names. There are none in this interface; if one is ever added
    // without a name, it is left out rather than written under a name that
    // would load back as something else.
    if (!name) continue;
    functions[name] = [...action.bindings];
  }
  return `${JSON.stringify({ version: VERSION, functions }, null, 2)}\n`;
}

module.exports = {
  VERSION, ACTIONS_VERSION, EXTENSION_FUNCTIONS,
  actionForFunction, functionForAction, functionNames,
  parseKeyFile, serialiseKeyFile,
};
