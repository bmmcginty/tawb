'use strict';

// Lynx's single-screen Options menu, drawn and driven.
//
// `src/lynx_options.js` owns the screen's model: which options exist, what
// they say, and where each value sits. This module owns the interaction: the
// reverse-video highlight, the Command prompt, where the terminal cursor is
// left, the second keyboard layer while a value is being chosen, and saving.
// It reaches the terminal only through the small host passed in, so the
// terminal loop keeps its byte-level writes and this file keeps Lynx's rules.

const {
  optionForLetter, choiceIndex, applyChoice, screenLines, optionPosition,
  persistableOptions, ANY_KEY_CHANGE, VALUE_ACCEPTED, CANCELLED,
  CHOICE_LIST, COMMAND_PROMPT, NOT_CHANGEABLE,
} = require('./lynx_options');
const { ANSI_REVERSE, ANSI_RESET } = require('./lynx_display');

function drawOptionsScreen(host, state) {
  const choosing = state.options.choosing;
  const lines = screenLines(state.keys.preferences);
  host.resetScrollRegion();
  for (let row = 0; row < lines.length; row += 1) {
    host.writeLine(row + 1, renderOptionsRow(lines[row], choosing));
  }
  host.writeLine(lines.length + 1, COMMAND_PROMPT);
  placeOptionsCursor(host, state, lines);
}

function renderOptionsRow(line, choosing) {
  const field = choosing && line.fields.find((candidate) => candidate.letter === choosing.letter);
  if (!field) return line.text;
  return line.text.slice(0, field.start)
    + ANSI_REVERSE + line.text.slice(field.start, field.end) + ANSI_RESET
    + line.text.slice(field.end);
}

// Where Lynx leaves the terminal cursor. With nothing being chosen it is on the
// Command prompt. With a value being chosen it is one column left of that value
// when SHOW_CURSOR is on, as Lynx does for speech and braille — and after the
// value when it is off, because Lynx writes the value and leaves the cursor
// where the write finished.
function placeOptionsCursor(host, state, lines = screenLines(state.keys.preferences)) {
  const choosing = state.options.choosing;
  if (!choosing) {
    host.moveCursor(lines.length + 1, COMMAND_PROMPT.length + 1);
    return;
  }
  const at = optionPosition(lines, choosing.letter);
  if (!at) return;
  const show = state.keys && state.keys.preferences && state.keys.preferences.showCursor;
  host.moveCursor(at.row + 1, show ? Math.max(1, at.column) : at.field.end + 1);
}

function openOptions(host, state, page) {
  state.core.live.refreshing = true;
  state.mode = 'options';
  state.options = {
    choosing: null,
    originalPreferences: { ...state.keys.preferences },
    // Where the reader was standing, so leaving the screen is not a second
    // navigation. See closeOptions().
    place: { cursor: state.cursor, col: state.col, scroll: state.scroll, title: state.title },
  };
  host.clearScreen();
  drawOptionsScreen(host, state);
  host.setStatus(state, '');
  placeOptionsCursor(host, state);
}

function closeOptions(host, state, page, note) {
  const { place } = state.options;
  state.options = null;
  state.mode = 'browse';
  state.core.live.refreshing = false;
  state.title = place.title;
  host.relayout(state);
  state.cursor = Math.min(place.cursor, Math.max(state.lines.length - 1, 0));
  state.col = place.col;
  state.scroll = place.scroll;
  host.clampCol(state);
  host.clampScroll(state);
  host.clearScreen();
  host.render(state, page, { force: true });
  if (note) host.setStatus(state, note);
}

function restoreOptionPreferences(state) {
  state.keys.preferences = { ...state.options.originalPreferences };
}

// An option has been chosen and not yet decided: the value is provisional until
// RETURN keeps it. This is the second keyboard layer of the Options screen, and
// it belongs to the option rather than to the screen, which is why it takes the
// keys that would otherwise be commands.
//
// A key the choice has no use for changes nothing: a reader who presses a
// reading key here has not answered the question, and answering it for them is
// how a preference changes by accident.
function handleOptionChoosing(host, chunk, state, page) {
  const options = state.options;
  const choosing = options.choosing;
  const { option } = choosing;

  if (chunk === '\r' || chunk === '\n') {
    options.choosing = null;
    drawOptionsScreen(host, state);
    host.setStatus(state, VALUE_ACCEPTED);
    placeOptionsCursor(host, state);
    return;
  }
  if (chunk === 'q' || chunk === 'Q' || chunk === '\x03' || chunk === '\x07'
      || host.keyIs(chunk, 'Escape', state)) {
    state.keys.preferences = { ...choosing.originalPreferences };
    options.choosing = null;
    drawOptionsScreen(host, state);
    host.setStatus(state, CANCELLED);
    placeOptionsCursor(host, state);
    return;
  }

  const count = option.choices.length;
  if (option.boolean) {
    // Any key moves a boolean on to its other value. The arrow keys keep their
    // direction rather than only going forward, which is what Lynx does.
    if (host.keyIs(chunk, 'ArrowUp', state)) choosing.index = (choosing.index + count - 1) % count;
    else if (host.keyIs(chunk, 'ArrowDown', state)) choosing.index = (choosing.index + 1) % count;
    else choosing.index = (choosing.index + 1) % count;
  } else if (host.keyIs(chunk, 'ArrowDown', state) || chunk === ' ') {
    choosing.index = (choosing.index + 1) % count;
  } else if (host.keyIs(chunk, 'ArrowUp', state)) {
    choosing.index = (choosing.index + count - 1) % count;
  } else if (host.keyIs(chunk, 'Home', state)) {
    choosing.index = 0;
  } else if (host.keyIs(chunk, 'End', state)) {
    choosing.index = count - 1;
  } else {
    return;
  }

  applyChoice(option, state.keys.preferences, choosing.index);
  drawOptionsScreen(host, state);
  host.setStatus(state, option.boolean ? ANY_KEY_CHANGE : CHOICE_LIST);
  placeOptionsCursor(host, state);
}

function handleOptionsKey(host, chunk, state, page) {
  const options = state.options;
  if (options.choosing) return handleOptionChoosing(host, chunk, state, page);

  if (host.keyIs(chunk, 'ArrowLeft', state) || host.keyIs(chunk, 'Escape', state)) {
    restoreOptionPreferences(state);
    closeOptions(host, state, page, 'Options unchanged.');
    return;
  }
  if (chunk === 'r' || chunk === 'R') {
    closeOptions(host, state, page, 'Options accepted for this session.');
    return;
  }
  if (chunk === '>') {
    try {
      host.saveSettings(state, persistableOptions(state.keys.preferences));
    } catch (err) {
      host.setStatus(state, `Could not save options: ${String(err.message || err).split('\n')[0]}`);
      placeOptionsCursor(host, state);
      return;
    }
    closeOptions(host, state, page, 'Options saved.');
    return;
  }

  const option = optionForLetter(chunk);
  if (!option) return;
  if (!option.choices) {
    // An option TAWB cannot honor still names itself, so the screen behaves the
    // same way and only the outcome differs.
    host.setStatus(state, NOT_CHANGEABLE);
    placeOptionsCursor(host, state);
    return;
  }
  // Choosing an option is not changing it: the value shown becomes provisional
  // and the reader decides, which is the whole of what the second layer is for.
  options.choosing = {
    letter: option.letter,
    option,
    index: choiceIndex(option, state.keys.preferences),
    originalPreferences: { ...state.keys.preferences },
  };
  drawOptionsScreen(host, state);
  host.setStatus(state, option.boolean ? ANY_KEY_CHANGE : CHOICE_LIST);
  placeOptionsCursor(host, state);
}

module.exports = {
  drawOptionsScreen, renderOptionsRow, placeOptionsCursor,
  openOptions, closeOptions, restoreOptionPreferences,
  handleOptionChoosing, handleOptionsKey,
};
