'use strict';

// What the Lynx interface does about a key, once the ordinary browse path has
// been passed over.
//
// Nothing here draws a page or reads a buffer on its own: every operation it
// needs comes from the host the terminal loop hands in. What lives here is the
// Lynx decision — which action opens a Lynx screen, when a digit starts the
// number prompt, when Tab between fields enters typing, when a list keeps the
// browse map rather than filtering, and the words the reader hears for each.
//
// The gate is always the interface, never the keymap. A Lynx keymap loaded on
// a default-interface state derives nothing from these keys, which is the
// isolation the interface promises and test/lynx_isolation.test.js checks.

function createLynxActions(host) {
  const actionFor = (state, chunk) => (state.keys || host.fallbackKeymap).actionFor(chunk);
  const preferencesOf = (state) => state.keys && state.keys.preferences;

  return {
    // The one gate every other decision in this file begins with. Kept as a
    // named predicate so the string itself lives only in this module and in
    // the interface policy.
    active(state) {
      return state.interface === 'lynx';
    },

    // A digit starts a number prompt when the profile numbers links or fields.
    // Digits are not bound by the default Lynx map, so this catches them
    // before the unchanged key resolves to nothing.
    digit(chunk, state) {
      if (state.interface !== 'lynx') return false;
      const preferences = preferencesOf(state);
      if (!(preferences && (preferences.numberLinks || preferences.numberFields))) return false;
      if (!/^\d+$/.test(chunk)) return false;
      host.openLinkNumberPrompt(state, chunk);
      return true;
    },

    // The browse actions that only Lynx has. Returns true when it handled one,
    // so the ordinary dispatcher can stop. `link-number` is here without the
    // interface gate because that is how it has always behaved: the action
    // exists only in the Lynx map, and reaching it opened the prompt.
    async action(action, state, page) {
      if (action === 'link-number') {
        host.openLinkNumberPrompt(state);
        return true;
      }
      if (state.interface !== 'lynx') return false;
      if (action === 'help') { host.openHelp(state, page); return true; }
      if (action === 'context-help') { host.describeCurrent(state, page); return true; }
      if (action === 'main-menu') { await host.openMainMenu(state, page); return true; }
      if (action === 'toggle-trace') { await host.toggleTrace(state); return true; }
      if (action === 'trace-log') { await host.openTraceLog(state, page); return true; }
      if (action === 'options') { host.openOptions(state, page); return true; }
      return false;
    },

    // Lynx enters a text field as soon as a movement lands on it, unless the
    // profile asks for TEXTFIELDS_NEED_ACTIVATION.
    async afterQuickNav(found, state, page) {
      if (state.interface !== 'lynx' || !found) return;
      const preferences = preferencesOf(state);
      if (preferences && preferences.textfieldsNeedActivation) return;
      const item = host.currentItem(state);
      if (item && host.isField(item.role) && await host.beginTyping(state, page, item)) {
        host.setStatus(state, 'Enter text. Use arrows or Tab to move off of field.');
      }
    },

    // The status line says which key shuts the popup that just opened.
    popupCloseHint(state) {
      return state.interface === 'lynx' ? 'q or Left' : 'q or Esc';
    },

    // Searching follows the profile's explicit Searching Type option rather
    // than TAWB's smart case. Null outside the interface, which leaves the
    // ordinary rule in charge.
    searchCase(state) {
      if (state.interface !== 'lynx') return null;
      const preferences = preferencesOf(state);
      return preferences ? preferences.searchCase : null;
    },

    // Which action, if any, this list key names. Read through the browse map
    // as well, because a Lynx internal page is navigated with it.
    libraryAction(state, chunk) {
      if (state.interface !== 'lynx') return null;
      return actionFor(state, chunk);
    },

    // A Lynx internal page keeps the browse map, so printable commands must
    // not become TAWB's list filter.
    libraryKeepsBrowseMap(state) {
      return state.interface === 'lynx';
    },

    // Up and Down move off a field in Lynx, where the ordinary interface
    // leaves them to the terminal.
    tabArrow(state, chunk) {
      return state.interface === 'lynx'
        && (host.keyIs(chunk, 'ArrowUp', state) || host.keyIs(chunk, 'ArrowDown', state));
    },

    // TEXTFIELDS_NEED_ACTIVATION keeps Tab from landing the reader in an
    // editable field.
    tabNeedsActivation(state) {
      if (state.interface !== 'lynx') return false;
      const preferences = preferencesOf(state);
      return !!(preferences && preferences.textfieldsNeedActivation);
    },

    // What the status line says after Tab lands on an editable field.
    tabTypingStatus(state, name) {
      return state.interface === 'lynx'
        ? 'Enter text. Use arrows or Tab to move off of field.'
        : `Typing into "${name}" — Tab: next control, Esc: stop, Enter: submit.`;
    },

    // The mode to be in after Tab lands on a non-editable control. Lynx stays
    // in the browse map; the ordinary interface uses its forms map.
    tabLandedMode(state) {
      return state.interface === 'lynx' ? 'browse' : 'forms';
    },

    // Lynx's one-command line-editor escape: a key bound to `edit-command`
    // hands the keyboard back to the browse map for exactly one command.
    typeCommand(state, chunk) {
      if (state.interface !== 'lynx') return false;
      return (state.keys || host.fallbackKeymap).editingActionFor(chunk) === 'edit-command';
    },
  };
}

module.exports = { createLynxActions };
