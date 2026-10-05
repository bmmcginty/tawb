# Lynx parity

This document is the map between the Lynx that TAWB imitates and the Lynx
interface TAWB implements. It exists because the two are compared by tests that
press the same keys at each and read back the result, and where those results
still differ the difference is written down here rather than discovered later.

The measurements come from `test/lynx_options_real.test.js`, which drives a real
Lynx inside a tmux pane. The comparisons come from
`test/lynx_options_compare.test.js`, which drives both. `test/lynx_tty.js` is the
terminal harness they share.

## What "match" means

A reader who knows Lynx should be able to press the same keys and get the same
result. That is checked on three axes, in this order of importance:

1. **Which option the cursor is on**, counted in reading order — first to last,
   top to bottom, left to right. This is the position a reader actually walks,
   and it is invariant under a different screen layout.
2. **What is said**, where the words are Lynx's own: the chosen-value prompt,
   the acceptance, the cancellation, the choice-list hint, and the select line.
3. **What is saved**, by meaning rather than by bytes. Lynx writes `.lynxrc`;
   TAWB writes `settings.lynx.json`. The two files say the same thing.

Layout is deliberately *not* compared byte for byte, and may not be. TAWB draws
a header of its own and gives every option a row of its own; Lynx draws no
header, packs up to three options onto a row, and ends with a Command prompt.
Those are recorded below as the remaining differences.

## Lynx has two options screens

Which one appears is a configuration choice, `FORMS_OPTIONS`, not a terminal
accident. TAWB currently implements the second.

| `FORMS_OPTIONS` | Lynx presents | TAWB presents |
| --- | --- | --- |
| `TRUE` (the default) | a five-page HTML form rendered by the ordinary browser, with links, text fields, checkboxes and Accept/Reset links | the single-screen menu (a known gap) |
| `FALSE` | the single-screen menu with a `Command:` prompt | the single-screen menu |

The single-screen menu is what the parity tests compare, because it is the one
with a keyboard of its own.

## The layered keymap

Lynx resolves a key through a stack of layers, and so does TAWB. The layers are
not the same shape, and this is where most of the remaining work is.

### Lynx

```
keypress
  |
  +-- options screen open?  (FORMS_OPTIONS, press 'o')
  |     |
  |     +-- FORMS_OPTIONS:TRUE   -> ordinary BROWSE layer over a rendered form
  |     |      arrows move, Return follows the link under the cursor,
  |     |      letters type into the field being edited,
  |     |      '>' is DOWN_LINK and does nothing special,
  |     |      saving means the Save-options checkbox and Accept Changes
  |     |
  |     +-- FORMS_OPTIONS:FALSE  -> the menu's own layer  (LYoptions, LYOptions.c)
  |            one capital letter per option; '>' saves, 'r' returns,
  |            Left leaves; the Command prompt on the row above the status
  |            line takes the letter
  |            |
  |            +-- option chosen?  -> the CHOOSER layer (boolean_choice)
  |                   boolean / short list: any key advances, RETURN accepts,
  |                                        q or Ctrl-C cancels
  |                   enum with popups:    Up/Down walk, RETURN selects,
  |                                        q or Ctrl-C cancels
  |
  +-- otherwise -> ordinary BROWSE layer (LYKeymap), then the FIELD layer
                   while a text field is being edited (LYEditmap)
```

### TAWB

```
keypress
  |
  +-- state.mode
        |
        +-- 'address'   address bar
        +-- 'find'      find prompt
        +-- 'number'    link-number prompt
        +-- 'type'      field editing        (edit- action ids)
        +-- 'field-command'  one browse command from inside a field
        +-- 'choose'    a dropdown
        +-- 'library'   an internal list
        |     |
        |     +-- kind 'options' -> the options layer, then the chooser layer
        |     +-- other kinds    -> list movement, filter typing
        |
        +-- 'browse'    the Lynx/ordinary browse keymap
```

The options screen is `state.mode === 'library'` with `kind: 'options'`.
Choosing an option stores `state.library.choosing`, which is the chooser layer:
while it is set, `handleOptionsKey` delegates to `handleOptionChoosing`, exactly
as Lynx's `boolean_choice` takes the keyboard for itself.

```
handleOptionsKey(chunk)
  |
  +-- choosing?  -> handleOptionChoosing
  |     Return/CR        -> VALUE_ACCEPTED, keep the value
  |     q / Ctrl-C / ^G / Esc -> CANCELLED, restore the value
  |     boolean          -> any key advances; Up/Down keep their direction
  |     list             -> Up/Down/Space walk, Home/End jump
  |
  +-- Left / Esc -> leave, restore everything
  +-- 'r'        -> leave, keep for the session
  +-- '>'        -> save settings.lynx.json, leave
  +-- a letter   -> choose that option
        fixed option   -> cursor to its row, say it is not changeable
        list option    -> enter the chooser layer on its row
```

## Movement functions are not collapsed

Lynx has six link movements and TAWB keeps all six, because a reader's
`lynx.cfg` may bind any of them and each has to behave as it does in Lynx:

| Lynx function | Default key | What it does |
| --- | --- | --- |
| `NEXT_LINK` | Down | next link or field, walking the current row first |
| `PREV_LINK` | Up | the same backwards |
| `FASTFORW_LINK` | Tab | next link or button, skipping form fields |
| `FASTBACKW_LINK` | Shift+Tab | the same backwards |
| `DOWN_LINK` | `>` | the next row that holds a link, at the reader's column |
| `UP_LINK` | `<` | the same upwards |

The rows matter because TAWB's Lynx presentation reflows a paragraph or a table
row onto one display row, which is exactly the case where "the next link" and
"the link below" come apart.

## Cursor placement

| Situation | Lynx | TAWB |
| --- | --- | --- |
| Browse, `SHOW_CURSOR` off | hidden at the bottom-right corner | hidden at the bottom-right corner |
| Browse, `SHOW_CURSOR` on | left of the current link or option | on the current item's line |
| Options open | on the `Command:` prompt, one row above the status line | on the first option (no prompt exists) |
| Option chosen, `SHOW_CURSOR` on | one column left of the value (Lynx's `LYmove(line, col-1)`) | on the option's line |
| Option chosen, `SHOW_CURSOR` off | wherever the last move left it | on the option's line |
| After accepting | back on the `Command:` prompt | stays on the option's line |

The reading-order position agrees; the physical row and column do not, because
the screens are laid out differently.

## Document placement

Rows are 1-based here. `rows` is the terminal height.

### Lynx

| Rows | Contents |
| --- | --- |
| 1..`rows-3` | page, or the options menu |
| `rows-2` | the `Select capital letter…` line (letter screen) |
| `rows-1` | `Command:` prompt (letter screen) |
| `rows` | status line: help hints, messages, the browse key bar |

There is no header. A 24-row terminal gives 21 rows of content and 3 rows of
chrome.

### TAWB

| Rows | Contents |
| --- | --- |
| 1 | title |
| 2 | address |
| 3 | hint |
| 4 | blank |
| 5..`rows-2` | page, or an internal list such as the options menu |
| `rows-1` | blank |
| `rows` | status line |

A 24-row terminal gives 18 rows of content and 6 rows of chrome. The options
rows therefore begin four rows lower than Lynx's and end three rows higher, and
the `Command:` prompt has no row of its own to sit on.

## The remaining differences

| Difference | Why it exists | What matching would take |
| --- | --- | --- |
| Default (`FORMS_OPTIONS:TRUE`) options screen | not implemented; TAWB shows the single-screen menu instead | rendering a generated five-page form, or serving one to the browser (see below) |
| No `Command:` prompt line | TAWB reads one key at a time with no prompt row | a dedicated prompt row, which the current chrome has no place for |
| One option per row | TAWB's list draws one item per row | composite rows with Lynx's column constants (`COL_OPTION_VALUES 36`, `B_COLOR 44`, `C_COLOR 62`, `B_VIKEYS 5`, `B_EMACSKEYS 22`, `B_SHOW_DOTFILES 44`, `B_VERBOSE_IMAGES 50`, `C_VERBOSE_IMAGES 71`) |
| `(X)` local execution shown | TAWB cannot ask a build which options were compiled in | importing the option roster, which `-show_cfg` does not publish |
| Cursor column in the chooser | TAWB's list cursor is row-based | a per-row column, or a dedicated options renderer |
| Values for browser-owned options | TAWB has no editor, DISPLAY, mail address, user agent or charset | deliberately out of scope; the screen says so when chosen |

### A note on the forms options screen

Lynx's default screen is not a screen. `gen_options()` (LYOptions.c) writes an
HTML form to a temporary file, `postoptions()` reads the submission back, and
the ordinary renderer draws it. That is why it pages, why its values are links
and fields, and why `>` is an ordinary DOWN_LINK there rather than a save.

Two ways to match it:

1. **Generate and render the same form.** TAWB already has a browser. Serving a
   generated options form to it, and reading the submission back, would give
   paging, fields, checkboxes and selects for free — but it would also put
   browser chrome, a real URL and a real form submission into the path of
   changing a preference, and it would need the whole option set to exist as
   form values.
2. **Render the form as an internal page.** Borrow Lynx's page split and form
   presentation, keep the save path TAWB already has. Less faithful, no new
   browser surface, and much less new code.

The current tests pin the gap so that either choice is a deliberate one: the
Lynx tests assert that the real default screen is a five-page form, and the
comparison test records that TAWB shows the single-screen menu instead.
