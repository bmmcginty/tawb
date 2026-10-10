'use strict';

// The Lynx effective-configuration importer, differenced between the
// JavaScript original and the Crystal port: the same key descriptions,
// effective map dumps, preference output, and .lynxrc files are read by both,
// and a missing or failing Lynx falls back to the same built-in defaults.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const lynxConfig = require('../src/lynx_config');
const { lynxConfigImplementations } = require('./crystal_impl');

const implementations = lynxConfigImplementations(lynxConfig);

const BROWSE_DUMP = [
  'q           QUIT          quit the browser',
  'Q           ABORT         quit unconditionally',
  'g           GOTO          enter an address',
  'G           ECGOTO        edit the current address',
  "E           ELGOTO        edit the current link's address",
  '^R          RELOAD        reload the current document',
  'x           NOCACHE       reload without cache',
  'z           INTERRUPT     stop loading',
  '^T          TRACE_TOGGLE  toggle trace',
  ';           TRACE_LOG     view trace',
  '<space>     NEXT_PAGE     view the next page',
  'Up Arrow    PREV_LINK     make the previous link current',
  'Down Arrow  NEXT_LINK     make the next link current',
  '<tab>       FASTFORW_LINK next link or text area',
  'Back Tab    FASTBACKW_LINK previous link or text area',
  '>           DOWN_LINK     move down the page to another link',
  '<           UP_LINK       move up the page to a previous link',
  ')           DOWN_HALF     move down half a page',
  '(           UP_HALF       move up half a page',
  'Right Arrow ACTIVATE      activate the current link',
  '?           HELP          display help',
  'm           MAIN_MENU     return to main screen',
  'r           DEL_BOOKMARK  remove bookmark',
  'k           KEYMAP        show key bindings',
  'l           LIST          list references',
  'A           ADDRLIST      list reference addresses',
  '=           INFO          document information',
  'o           OPTIONS       options menu',
  '0           F_LINK_NUM    follow a number',
  '^           FIRST_LINK    first link',
  '$           LAST_LINK     last link',
  '\\           SOURCE        toggle source',
  '!           SHELL         escape to a shell',
].join('\n');

const EDIT_DUMP = [
  '  DELN   Delete next/curr char        -  ^D, ^R',
  '  DELP   Delete prev char             -  ^H, <delete>, Remove key',
  '  FORWW  Word forward                 -  ^N',
  '  LKCMD  Invoke command prompt        -  ^V',
  '  PASS   Fields only                  -  Up Arrow, Down Arrow,',
  '                                         Page Up, Back Tab',
  '  CHAR   Insert printable char        -  32-126, 128-255',
].join('\n');

const BROWSE_EXPECTATIONS = {
  'confirm-quit': ['q'],
  abort: ['Q'],
  goto: ['g'],
  'location-edit': ['G'],
  'link-address': ['E'],
  'source-view': ['\\'],
  'reload-page': ['Ctrl+R'],
  'reload-no-cache': ['x'],
  interrupt: ['z'],
  'toggle-trace': ['Ctrl+T'],
  'trace-log': [';'],
  'next-screen': ['Space'],
  'previous-focusable': ['ArrowUp'],
  'next-focusable': ['ArrowDown'],
  'fast-forward-link': ['Tab'],
  'fast-backward-link': ['Shift+Tab'],
  'down-link': ['>'],
  'up-link': ['<'],
  'next-half-screen': [')'],
  'previous-half-screen': ['('],
  activate: ['ArrowRight'],
  help: ['?'],
  'main-menu': ['m'],
  'delete-bookmark': ['r'],
  'keyboard-wizard': ['k'],
  'list-links': ['l'],
  'list-addresses': ['A'],
  'document-info': ['='],
  options: ['o'],
  'link-number': ['0'],
  'first-focusable': ['^'],
  'last-focusable': ['$'],
};

for (const implementation of implementations) {
  test(`${implementation.name}: Lynx key names become portable key specifications`, () => {
    assert.equal(implementation.keySpec('^A'), 'Ctrl+A');
    assert.equal(implementation.keySpec('<space>'), 'Space');
    assert.equal(implementation.keySpec('Right Arrow'), 'ArrowRight');
    assert.equal(implementation.keySpec('Back Tab'), 'Shift+Tab');
    assert.equal(implementation.keySpec('F12'), 'F12');
    assert.equal(implementation.keySpec('Do key'), null);
  });

  test(`${implementation.name}: the effective browse map is translated by function name`, () => {
    const parsed = implementation.parseBrowseMap(BROWSE_DUMP);
    for (const [action, keys] of Object.entries(BROWSE_EXPECTATIONS)) {
      assert.deepEqual(parsed.bindings[action], keys, action);
    }
    assert.deepEqual(parsed.unsupported, ['SHELL']);
  });

  test(`${implementation.name}: custom effective output carries control and function keys`, () => {
    const output = fs.readFileSync(path.join(
      __dirname, 'fixtures', 'lynx-keymap-custom-effective.txt'), 'utf8');
    const parsed = implementation.parseBrowseMap(output);
    assert.deepEqual(parsed.bindings['confirm-quit'], ['x']);
    assert.deepEqual(parsed.bindings.goto, ['Ctrl+X']);
    assert.deepEqual(parsed.bindings['document-info'], ['F2']);
    assert.deepEqual(parsed.bindings['next-focusable'], ['ArrowDown']);
    assert.deepEqual(parsed.bindings.activate, ['ArrowRight']);
  });

  test(`${implementation.name}: the line editor map is translated separately`, () => {
    const parsed = implementation.parseEditMap(EDIT_DUMP);
    assert.deepEqual(parsed.bindings['edit-delete'], ['Ctrl+D', 'Ctrl+R']);
    assert.deepEqual(parsed.bindings['edit-backspace'], ['Ctrl+H', 'Backspace']);
    assert.deepEqual(parsed.bindings['edit-next-word'], ['Ctrl+N']);
    assert.deepEqual(parsed.bindings['edit-command'], ['Ctrl+V']);
    assert.ok(parsed.unsupported.includes('PASS'));
  });

  test(`${implementation.name}: malformed output degrades to what can be read`, () => {
    const garbage = [
      '',
      'not a key map at all',
      'q           lowercase      not a function name',
      'g           GOTO',
      'zzz',
      ['x'.repeat(20), 'QUIT', 'too long a key column'].join(' '),
    ].join('\n');
    const parsed = implementation.parseBrowseMap(garbage);
    assert.deepEqual(parsed.bindings['confirm-quit'], []);
    assert.deepEqual(parsed.bindings.goto, []);
    assert.deepEqual(parsed.unsupported, []);

    const edit = implementation.parseEditMap('  BOL broken line without a dash\n\n  EOL    End line\n');
    assert.deepEqual(edit.bindings['edit-line-end'], []);
  });

  test(`${implementation.name}: preferences follow config and then .lynxrc precedence`, () => {
    const preferences = implementation.parsePreferences(`
DEFAULT_KEYPAD_MODE:LINKS_ARE_NUMBERED
NUMBER_LINKS_ON_LEFT:FALSE
NUMBER_FIELDS_ON_LEFT:FALSE
TEXTFIELDS_NEED_ACTIVATION:TRUE
SHOW_CURSOR:FALSE
`, 'keypad_mode=LINKS_AND_FORM_FIELDS_ARE_NUMBERED\nshow_cursor=on\n');
    assert.deepEqual(preferences, {
      keypadMode: 'LINKS_AND_FIELDS_ARE_NUMBERED',
      numberLinks: true,
      numberFields: true,
      numberLinksOnLeft: false,
      numberFieldsOnLeft: false,
      textfieldsNeedActivation: true,
      searchCase: 'CASE_INSENSITIVE',
      showCursor: true,
    });

    assert.equal(implementation.parsePreferences('SHOW_CURSOR:TRUE\n').showCursor, true);
    assert.equal(implementation.parsePreferences('SHOW_CURSOR:FALSE\n').showCursor, false);
    assert.equal(implementation.parsePreferences('').showCursor, false,
      'the Lynx default hides the cursor');
    assert.equal(implementation.parsePreferences('', 'show_cursor=on\n').showCursor, true);
    assert.equal(implementation.parsePreferences('SHOW_CURSOR:TRUE\n', 'show_cursor=off\n').showCursor,
      false, '.lynxrc wins, as it does in Lynx');
  });

  test(`${implementation.name}: Lynx is asked for both maps and its shown config`, () => {
    const { imported, seen } = implementation.read({
      env: { HOME: '/home/me' },
      config: '/home/me/lynx.cfg',
      home: { path: '/home/me/.lynxrc', rc: 'keypad_mode=LINKS_ARE_NUMBERED\n' },
      dumps: {
        'LYNXKEYMAP:': { status: 0, stdout: 'j           NEXT_LINK     next link\n' },
        'LYNXEDITMAP:': { status: 0, stdout: '  BOL    Begin line                   -  ^A\n' },
        '-show_cfg': { status: 0, stdout: 'TEXTFIELDS_NEED_ACTIVATION:TRUE\n' },
      },
    });
    assert.equal(imported.available, true);
    assert.deepEqual(imported.bindings['next-focusable'], ['j']);
    assert.deepEqual(imported.bindings['edit-line-start'], ['Ctrl+A']);
    assert.equal(seen.length, 3);
    assert.equal(seen[0].LC_ALL, 'C');
    assert.equal(seen[0].LANG, 'C');
    assert.equal(seen[0].LYNX_CFG, '/home/me/lynx.cfg');
    assert.equal(imported.preferences.keypadMode, 'LINKS_ARE_NUMBERED');
    assert.equal(imported.preferences.numberLinks, true);
    assert.equal(imported.preferences.textfieldsNeedActivation, true);
  });

  test(`${implementation.name}: a config path is passed only when one is given`, () => {
    const { seen } = implementation.read({
      env: { HOME: '/home/me' },
      dumps: {},
    });
    assert.equal(seen.length, 3);
    assert.equal(seen[0].LYNX_CFG, undefined);
  });

  test(`${implementation.name}: one unreadable map makes the whole import fall back`, () => {
    const { imported } = implementation.read({
      env: { HOME: '/home/me' },
      dumps: {
        'LYNXKEYMAP:': { status: 0, stdout: 'q           QUIT          quit the browser\n' },
        'LYNXEDITMAP:': { status: 1, stdout: '' },
      },
    });
    assert.equal(imported.available, false);
    assert.deepEqual(imported.bindings, {});
    assert.equal(imported.preferences.keypadMode, 'NUMBERS_AS_ARROWS');
  });

  test(`${implementation.name}: a missing or failing Lynx selects built-in defaults`, () => {
    const { imported } = implementation.read({
      env: {},
      dumps: {
        'LYNXKEYMAP:': { status: 1, stdout: '' },
        'LYNXEDITMAP:': { status: 1, stdout: '' },
      },
    });
    assert.equal(imported.available, false);
    assert.deepEqual(imported.bindings, {});
    assert.equal(imported.preferences.keypadMode, 'NUMBERS_AS_ARROWS');
  });

  test(`${implementation.name}: empty maps still import with Lynx's own defaults`, () => {
    const { imported } = implementation.read({
      env: { HOME: '/home/nowhere' },
      dumps: {
        'LYNXKEYMAP:': { status: 0, stdout: '' },
        'LYNXEDITMAP:': { status: 0, stdout: '' },
        '-show_cfg': { status: 1, stdout: '' },
      },
    });
    assert.equal(imported.available, true);
    assert.deepEqual(imported.bindings.goto, []);
    assert.equal(imported.preferences.showCursor, false, 'Lynx hides the cursor by default');
    assert.equal(imported.preferences.keypadMode, 'NUMBERS_AS_ARROWS');
  });
}
