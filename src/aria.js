'use strict';

// How a line reads.
//
// An accessibility item — a role, a name, sometimes a value — becomes the one
// line of text a reader hears. The markers are chosen for speech and braille
// rather than for the eye: {like this} is something you go to, [*like this]
// is something you press, [like this] holds a value.
//
// The role sets are here rather than in ax_own.js because they are the
// reader's vocabulary, not the extractor's: the quick-navigation keys, the
// field editor and the line renderer all have to agree on what counts as a
// link, a button or a field, and they agree by sharing these.

// Roles we render as {Name} — things you "go to"
const LINK_ROLES = new Set(['link']);
// Roles we render as [*Name] — things you "activate"
const BUTTON_ROLES = new Set([
  'button', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'tab', 'switch', 'checkbox', 'radio', 'option',
]);
// Roles we render as [Name] / [Name: value] — things that hold a value or take typing
const FIELD_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'listbox', 'slider', 'spinbutton']);

// Everything a graphical browser's Tab key stops on: the three sets above,
// which between them are every control this reader knows how to activate or
// type into. Tab is the one key a sighted user's muscle memory already has
// for "the next thing I can interact with", and it does not care which of
// the three kinds the next one turns out to be.
const FOCUSABLE_ROLES = new Set([...LINK_ROLES, ...BUTTON_ROLES, ...FIELD_ROLES]);

// Whether a control that opens something is open, in the words a screen
// reader uses. Words rather than a symbol on purpose: an arrow glyph is noise
// on a braille display and silence in speech, and this is the difference
// between "press this to see the menu" and "the menu you asked for is already
// on the page, below". Absent means the control does not open anything, which
// is most of them, and says nothing.
function expansion(item) {
  if (item.expanded === true) return ', expanded';
  if (item.expanded === false) return ', collapsed';
  return '';
}

// State is said in words rather than encoded in punctuation: every one of
// these distinctions has to survive speech and a braille display. False is
// meaningful for toggles and checkable controls, but not for attributes such
// as selected/current whose ordinary false state would add noise everywhere.
function stateText(item) {
  const states = [];
  if (item.checked === 'mixed') states.push('partly checked');
  else if (item.checked === true) states.push('checked');
  else if (item.checked === false) states.push('not checked');
  if (item.pressed === true) states.push('pressed');
  else if (item.pressed === false) states.push('not pressed');
  if (item.selected === true) states.push('selected');
  if (item.current) states.push(item.current === true ? 'current' : `current ${item.current}`);
  if (item.readonly) states.push('read only');
  if (item.required) states.push('required');
  if (item.invalid) states.push(item.invalid === true ? 'invalid' : `invalid: ${item.invalid}`);
  if (item.orientation) states.push(item.orientation);
  if (item.disabled) states.push('unavailable');
  return states.length ? `, ${states.join(', ')}` : '';
}

function renderLine(item) {
  const { role, name, value, level } = item;
  if (role === 'heading') {
    const marker = level ? '#'.repeat(Number(level)) + ' ' : '## ';
    return marker + name;
  }
  if (LINK_ROLES.has(role)) return `{${name}${expansion(item)}${stateText(item)}}`;
  if (BUTTON_ROLES.has(role)) {
    const attached = item.file && value ? `: ${value}` : '';
    return `[*${name}${attached}${expansion(item)}${stateText(item)}]`;
  }
  if (FIELD_ROLES.has(role)) {
    // A field the browser filled from its password manager reads as empty:
    // the value is kept from page script until the person interacts with the
    // page. Saying so is the difference between a reader signing in with one
    // keystroke and a reader typing a password they did not need to type.
    const filled = item.autofilled ? 'filled by the browser' : '';
    const inside = value || filled ? `${name}: ${value || filled}` : name;
    return `[${inside}${expansion(item)}${stateText(item)}]`;
  }
  if (role === 'img') return `(image) ${name}`;
  // A player says where it has got to, which is the one thing about it that
  // is not on the page in words.
  if (role === 'video' || role === 'audio') return `(${role}) ${name}`;
  // A frame marks where embedded content begins; the frame's own lines are
  // spliced in after it, so it needs to survive even when unnamed.
  if (role === 'iframe') return name ? `<frame: ${name}>` : '<frame>';
  return name; // prose
}

module.exports = {
  renderLine, stateText,
  LINK_ROLES, BUTTON_ROLES, FIELD_ROLES, FOCUSABLE_ROLES,
};
