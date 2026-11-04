# Poppable screens and the shared list model

This is the design record for two changes that meet: one list model for every
screen that filters rows, and a stack for screens that are raised above the
page. The order matters. A stack that each list migrates into on its own would
encode the same mode-specific assumptions several times; the list state is the
first thing that has to be common.

The code this describes is `src/list_model.js`, `src/list_screen.js`, and their
Crystal counterparts. `docs/lynx-parity.md` is the interface contract; this is
the internal screen contract.

## What is a screen

The page is the base screen and is never popped. A poppable screen is anything
that temporarily owns part of the terminal above it:

| Screen | Poppable | Owns terminal | Underlay while open |
| --- | --- | --- | --- |
| Page | no, base | yes, its list area | — |
| Library (bookmarks, history, downloads) | yes | page buffer | frozen page snapshot |
| Internal list (references, addresses, messages, session lists) | yes | page buffer | frozen page snapshot |
| Information, help, trace log | yes | page buffer | frozen page snapshot |
| Select chooser | yes | page buffer, spliced rows | frozen page, live rebuild held |
| Browser dialog | input layer, not a screen | page buffer | page frozen until answered |
| Prompt and confirmation | input layer, not a screen | status row | caller's screen |
| Keyboard wizard | yes | whole terminal | restored place when it closes |
| Lynx options | yes | whole terminal | restored place when it closes |

A prompt is not a screen. It has no rows, no selection and no place of its own;
it borrows the status row and returns the keystroke after it. A confirmation
over a library is therefore an input layer over that library, not a second
library. Dialogs the browser draws are also an input layer: they have controls
rather than filtered rows, their letters and fields mean something else, and
folding them into the list model would lose that.

The wizard and Lynx options are special screen implementations because they own
the whole terminal, not because they are outside the stack. They save and
restore the page place exactly as a library does; they simply draw more than the
list area.

## The screen contract

Every poppable screen answers the same questions. A screen implementation that
cannot answer one of these is not ready to be moved onto the stack.

- **enter** — take the screen's copy of the page place, claim the input it
  needs, and say what the first draw is.
- **leave** — release live-refresh suppression and input, restore its underlay
  strategy, and put the reader back on the place it saved.
- **handle-key** — consume one terminal chunk. Return `quit` only when the
  reader is leaving the program, not the screen.
- **render** — draw from the screen's own state. A full render is allowed on
  enter and resize; ordinary keys should repaint only what changed.
- **resize** — relayout at the new width and repaint, without losing selection
  or the underlay place.

Each screen also declares four policies:

- **filter policy** — `typeahead` or `explicit`, from `list_screen.js`.
  Typeahead is for lookup lists: references, addresses, messages, bookmarks,
  history, downloads and the select chooser. Explicit is for reading surfaces
  and screens that edit the keyboard: information, help, trace log and the
  keyboard wizard. Lynx options is neither: its letters are Lynx commands.
- **input ownership** — which mode the terminal loop dispatches to. Prompts and
  confirmations sit above this and hand the keyboard back when answered.
- **live-refresh policy** — whether a live rebuild is held, suppressed only for
  the list area, or allowed to replace the underlay.
- **underlay restoration** — one of:
  - frozen page snapshot: keep the page blocks, cursor, column and scroll and
    restore them unchanged (library and every internal list);
  - anchor-based restoration: re-read the page and return to the element the
    reader was on (actions and page changes);
  - re-read the page: the content is expected to have changed (refresh,
    reload, navigation).
  A screen with a frozen snapshot must also stop `syncCursor` from telling the
  core about a block index that now names a list row.

## The list state contract

A list screen keeps one state shape, created by `createListState()`:

```
sections, pinned, filter, policy, selectedKey, fallbackIndex, filtering
```

`rows` is shorthand for one untitled section. `visibleEntries()` decides what
is drawn; sections with no matching row disappear with their heading, and
pinned rows stay. The screen owns its rows, but not the rules for filtering
them.

Selection is by stable row key. A browser library row uses the browser's own
identity where there is one — a bookmark id — and otherwise the entry's address
or file plus its time. A chooser row uses its option index. The wizard already
uses its action id. When the selected key is gone, the nearest selectable row
to the old position is chosen; headings are skipped. This is what keeps the
cursor on the entry that replaces a removed bookmark and keeps it on the same
row while a filter narrows the list. An index is not an identity and must not
be treated as one across a rebuild.

Filter input is one function for every screen. `filterKey()` applies the
policy: typeahead consumes printable characters immediately; explicit consumes
them only after `beginFilter()`, and Enter or Escape ends that input while
keeping the narrowed rows. Backspace edits by reader-visible code point;
`Ctrl+U` clears. `filterSummary()` and `filterHint()` say the same things about
counts and policy everywhere, so the status row and the handler cannot
disagree about whether typing is filtering or moving.

## The stack

A minimal stack has `push(screen)`, `pop()`, `top()` and a dispatch to the top
screen's `handle-key`. The page is the bottom entry and is never popped. The
stack does not own any screen's state; it owns the order and the guarantee that
only the top screen receives keys.

The hard cases are not push and pop:

- **nested input** — a confirmation over a library, or a chooser raised while a
  browser action is still waiting. The input layer goes above the screen; the
  underlay is not re-entered and does not lose its place.
- **asynchronous browser dialogs** — a dialog can arrive while another screen
  is open. It is pushed as an input layer, not as a page screen, and the
  screen below stays frozen. Alt+Q is the way back to a dialog the reader
  stepped away from.
- **browser-owned widgets** — Lynx options and the browser dialog keep their
  own key semantics. They are special screen implementations or input layers,
  not list screens.
- **state and conformance** — the JavaScript and Crystal snapshots must be
  able to say which screens are open and in what order. Until they can, the
  stack is internal and the visible state stays the existing `mode` plus the
  screen's own object.

## Migration order

1. Share the list state and filter policy. Migrate the library, chooser and
   internal lists onto it. Keep typeahead for the lookup lists, explicit
   filtering for information, help and trace log, and the wizard's existing
   explicit input.
2. Add the stack and move the library onto it first, because its frozen
   snapshot and live-refresh hold are the simplest complete case.
3. Move the chooser and then the internal lists. Each keeps its own enter and
   leave, and the stack only decides who owns the keyboard.
4. Move the options screen and then the wizard. Both already save and restore
   the page place; the change is where that place lives, not what it means.
5. Delete the old mode branches only after both runtimes exercise the new
   enter, leave, filter, movement and asynchronous-dialog paths. The
   conformance snapshot gains the stack at the same time, not afterwards.

Steps that are not in this migration: folding browser dialogs or form controls
into the list model, changing Lynx options' letter commands, or making the
wizard filter on every printable key. Those are different interactions with
different keys, and sharing the list machinery does not mean sharing the
interaction.

## Where the migration stands

The shared list state and filter policy are in place for the library, the
internal lists and the select chooser in both runtimes. The library, every
internal list and the chooser are on the screen stack: the page is the base,
opening a list pushes a screen, closing it pops that same screen, and the
terminal loop dispatches to the top screen when its mode matches. Prompts and
browser dialogs still use their own modes above the stack, so a dialog can
arrive while a list is open without losing the list underneath.

The keyboard wizard uses the same explicit filter policy and filter edits, but
still draws its own full terminal and has not been moved onto the stack. Lynx
options remains a whole-terminal screen with its own letter commands. The next
steps are the wizard, then the options screen, then deleting the old mode
branches once both runtimes cover the stack paths.
