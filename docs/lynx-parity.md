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
result. The single-screen options comparison checks four things:

1. **What is drawn**, row for row and column for column. The two rows that name
   the program and its user agent differ deliberately; every other row must
   match.
2. **Where the cursor is**, both on the `Command:` prompt and while a value is
   being chosen.
3. **What is said**, where the words are Lynx's own: the chosen-value prompt,
   the acceptance, the cancellation, the choice-list hint, and the select line.
4. **What is saved**, by meaning rather than by bytes. Lynx writes `.lynxrc`;
   TAWB writes `settings.lynx.json`. The two files say the same thing.

TAWB draws this screen directly rather than through its ordinary page or list
layout. That is what lets several options share a row and puts each value and
the `Command:` prompt at Lynx's columns.

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

Lynx resolves a key through a stack of layers, and so does TAWB. The layers
have the same roles even though TAWB names them as explicit reader modes.

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
        +-- 'library'   an internal list: movement, with typeahead or / filtering
        +-- 'options'   the Lynx options screen
        |     |
        |     +-- state.options.choosing -> the option's chooser layer
        |
        +-- 'browse'    the Lynx/ordinary browse keymap
```

The library, chooser, options and keyboard wizard screens are also on the
screen stack; the page is the base and the top screen receives keys. The
options screen is
`state.mode === 'options'` and owns the terminal rather than borrowing the
internal-list renderer. Choosing an option stores
`state.options.choosing`; while it is set, `handleOptionsKey` delegates to
`handleOptionChoosing`, exactly as Lynx's `boolean_choice` takes the keyboard
for itself.

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

## The Lynx keyboard's own extensions

Five things TAWB can do and Lynx cannot get a control key that Lynx never
binds, so a reader's own `KEYMAP` can never be shadowed by one:

| Operation | Key |
| --- | --- |
| cycle the page views (TAWB has four, Lynx two) | `^O` |
| send keys to the webpage | `^\` |
| click the line under the cursor | `^Y` |
| hover the line under the cursor | `^]` |
| return to a question the browser asked | `^_` |

Tabs are a browser idea Lynx has none of, and no Lynx-free key is worth
spending on them, so new-tab, next-tab, previous-tab and close-tab are offered
by the Lynx keyboard screen but unbound. `<` and `>` are `UP_LINK` and
`DOWN_LINK` and are never used for anything else. Alt is not used at all: Lynx
is built for terminals and DOS environments where Alt is spoken for.

An open popup closes on `q`, on Left, and on Escape, whatever Escape is bound
to, and the terminal's own interrupt gets out of every mode.

## The key file and the keyboard screen

`keys-lynx.json` is keyed by Lynx function name, not by TAWB action id:

```json
{ "version": 2, "functions": {
    "LIST": ["l"], "NEXT_LINK": ["ArrowDown"],
    "TAWB_CYCLE_VIEW": ["Ctrl+O"] } }
```

The `TAWB_` prefix is how an extension TAWB adds is named in the same
namespace, so there is one lookup table and one file. `src/lynx_keymap.js`
reads version 1 as well and converts it in memory, so a reader who upgrades and
opens the keyboard screen keeps their bindings and saves them in the new shape.
The default interface's `keys.json` is untouched and still version 1.

The keyboard screen in Lynx mode leads each row with the Lynx function it acts
on:

```
LIST — List page links, l
NEXT_LINK — Next link, button or form field, ArrowDown
TAWB_CYCLE_VIEW — Cycle view, Ctrl+O
```

Other Lynx functions that were once folded together are separate too: `QUIT`
(`q`) asks before quitting where `ABORT` (`Q`, `^D`) does not, `ELGOTO` (`E`)
edits the address of the link under the cursor where `ECGOTO` (`G`) edits the
document's, and `DWIMHELP` (`F1`) describes the control under the cursor where
`HELP` opens the help page.

## Cursor placement

| Situation | Lynx | TAWB |
| --- | --- | --- |
| Browse, `SHOW_CURSOR` off | hidden at the bottom-right corner | hidden at the bottom-right corner |
| Browse, `SHOW_CURSOR` on | left of the current link or option | on the current item's line |
| Options open | on the `Command:` prompt, one row above the status line | same row and column |
| Option chosen, `SHOW_CURSOR` on | one column left of the value (Lynx's `LYmove(line, col-1)`) | same row and column |
| Option chosen, `SHOW_CURSOR` off | after the value Lynx just wrote | after the same value |
| After accepting | back on the `Command:` prompt | back on the `Command:` prompt |

Browse mode still reflects the two programs' different page renderers. The
single-screen options menu has exact cursor placement because TAWB draws that
screen with its own dedicated renderer.

## Options-screen placement

Rows are 1-based. On the 24-row screen used by the parity tests, both programs
place the menu on rows 1 through 22, the `Command:` prompt on row 23, and status
messages on row 24. There is no TAWB title, address, hint, or blank page chrome
around this mode.

The letter-driven menu uses Lynx's rows, columns, and values. Several options
share a row (`L`/`B`, `O`/`&`, `V`/`M`/`W`, `T`/`@`, `U`/`!`), and the cursor is
placed within the row rather than merely on it. `test/lynx_options_compare.test.js`
compares this output row for row with a real Lynx and permits differences only
on the title and user-agent rows.

## The remaining differences

| Difference | Why it exists | What matching would take |
| --- | --- | --- |
| Default (`FORMS_OPTIONS:TRUE`) options screen | not implemented; TAWB shows the single-screen menu instead | rendering a generated five-page form, or serving one to the browser (see below) |
| The title and user-agent rows | TAWB names itself, and its agent is one word where Lynx's wraps | nothing; the difference is the point |
| `(X)` local execution shown | TAWB cannot ask a build which options were compiled in | importing the option roster, which `-show_cfg` does not publish |
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
