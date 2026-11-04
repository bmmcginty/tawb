'use strict';

// The order the keyboard screen reads in.
//
// This is a display order, not the order in keys.js. ACTIONS is ordered so a
// shared key resolves to the right action; moving a row there would change
// which action a key reaches. The wizard follows this table instead, grouping
// actions by the screen they belong to and then by what they do.
//
// An action that is not named here still appears: it goes into a trailing
// "Other" section rather than vanishing, which is what keeps a newly added
// action visible until somebody places it.

const WIZARD_SECTIONS = [
  {
    key: 'leave',
    title: 'Leave, and run a command',
    actions: ['quit', 'confirm-quit', 'abort', 'command'],
  },
  {
    key: 'move',
    title: 'Page: move',
    actions: [
      'next-character', 'previous-character',
      'next-line', 'previous-line',
      'next-half-screen', 'previous-half-screen',
      'next-screen', 'previous-screen',
      'top', 'bottom',
      'line-start', 'line-end',
    ],
  },
  {
    key: 'jump',
    title: 'Page: jump by feature',
    actions: [
      'next-heading', 'previous-heading',
      'next-link', 'previous-link',
      'next-field', 'previous-field',
      'next-button', 'previous-button',
      'next-focusable', 'previous-focusable',
      'fast-forward-link', 'fast-backward-link',
      'down-link', 'up-link',
      'first-focusable', 'last-focusable',
      'next-text', 'previous-text',
      'next-paragraph', 'previous-paragraph',
    ],
  },
  {
    key: 'act',
    title: 'Page: act on the current line',
    actions: [
      'activate', 'real-click', 'hover-line', 'close-popup',
      'download-link', 'page-keyboard', 'link-number',
    ],
  },
  {
    key: 'find',
    title: 'Page: find',
    actions: [
      'find-forward', 'find-backward',
      'repeat-find', 'repeat-find-forward', 'repeat-find-backward',
    ],
  },
  {
    key: 'where',
    title: 'Page: address, history and tabs',
    actions: [
      'location-bar', 'goto', 'location-edit', 'link-address',
      'history-back', 'history-forward', 'main-menu',
      'new-tab', 'next-tab', 'previous-tab', 'close-tab',
    ],
  },
  {
    key: 'view',
    title: 'Page: view, refresh and status',
    actions: [
      'cycle-view', 'source-view',
      'refresh', 'reload-page', 'reload-no-cache', 'interrupt',
      'next-change', 'previous-change',
      'where', 'messages', 'document-info',
      'toggle-live', 'toggle-link-address', 'toggle-short-links',
    ],
  },
  {
    key: 'lists',
    title: 'Lists: page references and browser data',
    actions: [
      'list-links', 'list-addresses',
      'bookmarks', 'add-bookmark', 'delete-bookmark',
      'history', 'downloads',
      'visited-links', 'session-history',
    ],
  },
  {
    key: 'dialogs',
    title: 'Browser dialogs',
    actions: ['browser-question'],
  },
  {
    key: 'editing',
    title: 'Editing a field',
    actions: [
      'edit-previous-character', 'edit-next-character',
      'edit-backspace', 'edit-delete',
      'edit-previous-word', 'edit-next-word',
      'edit-backspace-word', 'edit-delete-word',
      'edit-kill-start', 'edit-kill-end',
      'edit-line-start', 'edit-line-end',
      'edit-command',
    ],
  },
  {
    key: 'help',
    title: 'Help, setup and diagnostics',
    actions: [
      'help', 'context-help', 'options', 'keyboard-wizard',
      'toggle-trace', 'trace-log',
    ],
  },
];

// The actions this profile has, in the table's order, with any action the
// table does not name collected into a final section. Empty sections are
// dropped: a profile that has none of a section's actions does not need to
// read its heading.
function sectionsFor(actions) {
  const byId = new Map(actions.map((action) => [action.id, action]));
  const placed = new Set();
  const sections = [];
  for (const definition of WIZARD_SECTIONS) {
    const rows = [];
    for (const id of definition.actions) {
      const action = byId.get(id);
      if (!action || placed.has(id)) continue;
      placed.add(id);
      rows.push(action);
    }
    if (rows.length) sections.push({ key: definition.key, title: definition.title, rows });
  }
  const other = actions.filter((action) => !placed.has(action.id));
  if (other.length) sections.push({ key: 'other', title: 'Other', rows: other });
  return sections;
}

module.exports = { WIZARD_SECTIONS, sectionsFor };
