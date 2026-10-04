# Lynx interface implementation plan

This checklist tracks the first-party Lynx compatibility interface. The interface keeps
Chrome or Firefox as TAWB's web engine; it changes terminal navigation, presentation,
and key handling rather than embedding or replacing the browser with Lynx.

Compatibility requirements:

- The existing TAWB interface remains the default unless a user explicitly selects Lynx.
- Existing `~/.config/tawb/keys.json` files continue to load without user action.
- Lynx-specific overrides are stored separately so switching interfaces cannot rewrite or
  reinterpret the user's normal TAWB bindings.
- If the key-file schema ever changes, loading the old schema and converting it in memory
  must land before code writes the new schema.

## 1. Interface and keymap foundation

- [x] Add `--interface=default|lynx` and `TAWB_INTERFACE`, including settings-file support.
- [x] Add an interface/profile abstraction without changing default TAWB behavior.
- [x] Give each interface separate browse and editing defaults.
- [x] Store Lynx overrides in `keys-lynx.json`; retain version-1 `keys.json` compatibility.
- [x] Make keyboard help identify the active interface and edit the corresponding keymap.
- [x] Move form, chooser, prompt, and library commands that Lynx must customize out of
      hard-coded byte checks and into context-aware actions.
- [x] Add regression tests proving the default profile and existing `keys.json` files are
      unchanged.

## 2. Lynx configuration import

- [x] Add a Lynx adapter that queries the effective maps with `LYNXKEYMAP:` and
      `LYNXEDITMAP:` using `LC_ALL=C` and no shell.
- [x] Support `LYNX_CFG`, normal Lynx discovery, and an explicit `--lynx-config` path.
- [x] Support an explicit `--lynx-executable` and a built-in fallback when Lynx is absent.
- [x] Translate supported Lynx function names to semantic TAWB actions.
- [x] Preserve multiple bindings and deterministic last-mapping-wins behavior.
- [x] Report imported functions that have no safe TAWB equivalent instead of silently
      assigning them to misleading actions.
- [x] Read relevant `.lynxrc` interaction preferences, including keypad mode, vi/Emacs
      keys, line-editor mode, text-field activation, and `SHOW_CURSOR`.
- [x] Do not import browser-owned or executable settings such as cookies, proxies,
      credentials, viewers, printers, or shell commands.
- [x] Add fixture tests for custom mappings, control/function keys, includes/effective
      output, malformed output, missing Lynx, and unsupported functions.

## 3. Lynx-compatible display

- [x] Keep an ignored `./lynx` upstream source checkout for implementation reference
      (verified against snapshot commit `29d5a703b02a2c137c8c03949ccfec74d6c17b8a`).
- [x] Add a profile-specific renderer while leaving extracted block text and offsets intact.
- [x] Render headings, links, images, frames, and tables using Lynx-like text conventions.
      (A table row is laid out on one line with its columns lined up and the caption named; inline
      prose and links form one cell, while a cell with several block-level runs such as a list is
      stacked in reading order, as Lynx stacks a multi-line cell, and colspan widens its columns.)
- [x] Render native and ARIA buttons, checkboxes, radios, selects, text fields, passwords,
      textareas, and file controls using their closest Lynx forms.
- [x] Reflow prose and inline links together where element boundaries permit it, while
      retaining exact block and activation identities.
      (Both extractors retain their nearest HTML block-container identity; the Lynx display joins
      only matching consecutive text/link runs and maps every displayed span back to its core block.)
- [x] Highlight the current link or control like Lynx, including every wrapped part, without
      putting ANSI bytes into searchable text or caret offsets.
- [x] Keep link and field number markers outside the active highlight when shown on the left.
- [x] Add display fixtures rendered by upstream Lynx and compare TAWB's structural output,
      control markers, numbering, wrapping, and active region against them.
      (`test/fixtures/lynx-display.html` and its checked-in Lynx 2.9.3 dump; known differences:
      an associated label is printed once by Lynx but as its own line as well by TAWB, and Lynx
      numbers a frame's URL as a followable link where TAWB shows `IFRAME:` without a number.)
- [x] Verify monochrome, color, screen-reader, and braille behavior; highlighting must not be
      the only indication of the current item. (Video attributes only — reverse for the current
      control, bold for headings, no color. As in Lynx, `SHOW_CURSOR` decides whether the terminal
      cursor parks on the current item or hides at the bottom-right; the reverse-video highlight
      marks the current control either way.)

## 4. Lynx browse behavior

- [x] Make Up/Down and imported `PREV_LINK`/`NEXT_LINK` move between interactive topics.
- [x] Make Left/`PREV_DOC` go back and Right/Enter/`ACTIVATE` activate.
- [x] Implement Lynx screen movement, top/bottom, address, edited-address, find, repeat
      find, refresh, reload, download, bookmarks, history, and quit semantics.
- [x] Add direct SOURCE selection rather than requiring view cycling.
- [x] Add current-page information for `INFO`.
- [x] Add accessible link-list and address-list views for `LIST` and `ADDRLIST`.
- [x] Keep an always-available recovery route from transient modes and webpage keyboard
      passthrough even when imported mappings are incomplete.
- [x] Clearly expose unsupported commands in Lynx keyboard help.
- [x] Add unit and interaction tests for the standard, vi, and Emacs Lynx maps.

## 5. Numbered links and fields

- [x] Add display-only numbering metadata without modifying block text or search offsets.
- [x] Honor links-only, fields-only, links-and-fields, and numbers-as-arrows keypad modes.
- [x] Honor left/right placement for link and field numbers where practical in TAWB's
      one-control-per-line layout.
- [x] Add a status-line number prompt with editing, cancellation, and invalid-number
      feedback.
- [x] Snapshot the number-to-block map when the prompt opens so live updates cannot retarget
      partially entered numbers.
- [x] Make a link number activate and a field number move without submitting.
- [x] Add the Lynx `g` suffix for move-without-activation.
- [x] Add `p`, `+`, and `-` suffix navigation after the basic prompt is stable.
- [x] Test wrapping, live updates, all views, multi-digit numbers, invalid input, and fields.

## 6. Lynx form and editing behavior

- [x] Enter text fields automatically when Lynx's normal field behavior is selected.
- [x] Honor `TEXTFIELDS_NEED_ACTIVATION` by requiring activation before editing.
- [x] Apply imported Lynx line-editor bindings in text fields and TAWB text prompts.
- [x] Implement Lynx's one-command line-editor escape behavior.
- [x] Move through fields with Tab, Shift-Tab, Up, and Down without accidentally activating
      buttons.
- [x] Keep checkboxes, radios, selects, sliders, file inputs, and submit buttons on TAWB's
      existing browser-backed activation paths.
- [x] Test native fields, textareas, contenteditable controls, select popups, custom ARIA
      controls, uploads, and forms that navigate or update in place. (Lynx interface:
      `test/browser/forms.test.js` and `test/browser/lynx_forms.test.js`; uploads:
      `test/browser/files.test.js`.)

## 7. Documentation and release verification

- [x] Document startup flags, environment variables, config precedence, imported settings,
      unsupported Lynx commands, and fallback behavior in `README.md`.
- [x] Document the adapter, key translation, context maps, and maintenance constraints in
      `README-dev.md`.
- [x] Add a migration note confirming that existing default-interface users need take no
      action.
- [x] Run the complete unit suite.
- [x] Run focused browser tests for navigation, forms, live updates, and dialogs on Chromium
      and Firefox where available.
- [x] Verify stock Lynx defaults and customized vi, Emacs, numbered-link, and
      text-field-activation configurations against the installed Lynx binary
      (`test/lynx_real.test.js`, skipped when Lynx is absent).
