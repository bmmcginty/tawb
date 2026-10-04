'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  lynxKeySpec, parseBrowseMap, parseEditMap, parsePreferences, readLynxConfig,
} = require('../src/lynx_config');

test('Lynx key names become portable TAWB key specifications', () => {
  assert.equal(lynxKeySpec('^A'), 'Ctrl+A');
  assert.equal(lynxKeySpec('<space>'), 'Space');
  assert.equal(lynxKeySpec('Right Arrow'), 'ArrowRight');
  assert.equal(lynxKeySpec('Back Tab'), 'Shift+Tab');
  assert.equal(lynxKeySpec('Do key'), null);
});

test('the effective Lynx browse map is translated by function name', () => {
  const parsed = parseBrowseMap([
    'q           QUIT          quit the browser',
    'g           GOTO          enter an address',
    'G           ECGOTO        edit the current address',
    '^R          RELOAD        reload the current document',
    '<space>     NEXT_PAGE     view the next page',
    'Up Arrow    PREV_LINK     make the previous link current',
    'Right Arrow ACTIVATE      activate the current link',
    '?           HELP          display help',
    'l           LIST          list references',
    'A           ADDRLIST      list reference addresses',
    '=           INFO          document information',
    '0           F_LINK_NUM    follow a number',
    '\\           SOURCE        toggle source',
    '!           SHELL         escape to a shell',
  ].join('\n'));

  assert.deepEqual(parsed.bindings.quit, ['q']);
  assert.deepEqual(parsed.bindings.goto, ['g']);
  assert.deepEqual(parsed.bindings['location-edit'], ['G']);
  assert.deepEqual(parsed.bindings['source-view'], ['\\']);
  assert.deepEqual(parsed.bindings['reload-page'], ['Ctrl+R']);
  assert.deepEqual(parsed.bindings['next-screen'], ['Space']);
  assert.deepEqual(parsed.bindings['previous-focusable'], ['ArrowUp']);
  assert.deepEqual(parsed.bindings.activate, ['ArrowRight']);
  assert.deepEqual(parsed.bindings['keyboard-wizard'], ['?']);
  assert.deepEqual(parsed.bindings['list-links'], ['l']);
  assert.deepEqual(parsed.bindings['list-addresses'], ['A']);
  assert.deepEqual(parsed.bindings['document-info'], ['=']);
  assert.deepEqual(parsed.bindings['link-number'], ['0']);
  assert.deepEqual(parsed.unsupported, ['SHELL']);
});

test('the effective Lynx line editor map is translated separately', () => {
  const parsed = parseEditMap(`
  DELN   Delete next/curr char        -  ^D, ^R
  DELP   Delete prev char             -  ^H, <delete>, Remove key
  FORWW  Word forward                 -  ^N
  LKCMD  Invoke command prompt        -  ^V
  PASS   Fields only                  -  Up Arrow, Down Arrow,
                                         Page Up, Back Tab
  CHAR   Insert printable char        -  32-126, 128-255
`);
  assert.deepEqual(parsed.bindings['edit-delete'], ['Ctrl+D', 'Ctrl+R']);
  assert.deepEqual(parsed.bindings['edit-backspace'], ['Ctrl+H', 'Backspace']);
  assert.deepEqual(parsed.bindings['edit-next-word'], ['Ctrl+N']);
  assert.deepEqual(parsed.bindings['edit-command'], ['Ctrl+V']);
  assert.ok(parsed.unsupported.includes('PASS'));
});

test('Lynx interaction preferences follow config and then .lynxrc precedence', () => {
  const preferences = parsePreferences(`
DEFAULT_KEYPAD_MODE:LINKS_ARE_NUMBERED
NUMBER_LINKS_ON_LEFT:FALSE
NUMBER_FIELDS_ON_LEFT:FALSE
TEXTFIELDS_NEED_ACTIVATION:TRUE
`, 'keypad_mode=LINKS_AND_FORM_FIELDS_ARE_NUMBERED\n');
  assert.deepEqual(preferences, {
    keypadMode: 'LINKS_AND_FIELDS_ARE_NUMBERED',
    numberLinks: true,
    numberFields: true,
    numberLinksOnLeft: false,
    numberFieldsOnLeft: false,
    textfieldsNeedActivation: true,
  });
});

test('Lynx is queried without a shell and with its requested config', () => {
  const calls = [];
  const outputs = {
    'LYNXKEYMAP:': 'j           NEXT_LINK     next link\n',
    'LYNXEDITMAP:': '  BOL    Begin line                   -  ^A\n',
  };
  const imported = readLynxConfig({
    executable: '/opt/lynx', config: '/home/me/lynx.cfg', env: { HOME: '/home/me' },
    run: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: args[0] === '-show_cfg'
        ? 'TEXTFIELDS_NEED_ACTIVATION:TRUE\n'
        : outputs[args[1]] };
    },
    readFile: () => 'keypad_mode=LINKS_ARE_NUMBERED\n',
  });

  assert.equal(imported.available, true);
  assert.deepEqual(imported.bindings['next-focusable'], ['j']);
  assert.deepEqual(imported.bindings['edit-line-start'], ['Ctrl+A']);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].command, '/opt/lynx');
  assert.equal(calls[0].options.env.LYNX_CFG, '/home/me/lynx.cfg');
  assert.equal(calls[0].options.env.LC_ALL, 'C');
  assert.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'ignore']);
  assert.equal(Object.hasOwn(calls[0].options, 'shell'), false);
  assert.equal(imported.preferences.keypadMode, 'LINKS_ARE_NUMBERED');
  assert.equal(imported.preferences.numberLinks, true);
  assert.equal(imported.preferences.textfieldsNeedActivation, true);
});

test('a missing or failing Lynx cleanly selects built-in defaults', () => {
  const imported = readLynxConfig({ run: () => ({ status: 1, stdout: '' }) });
  assert.equal(imported.available, false);
  assert.deepEqual(imported.bindings, {});
  assert.equal(imported.preferences.keypadMode, 'NUMBERS_AS_ARROWS');
});
