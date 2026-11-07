# Crystal/JavaScript parity and JavaScript-retirement plan

## Purpose

The native executable cannot replace the Node runtime on confidence derived
from file counts, matching function names, or a collection of happy-path unit
tests. It can replace it only when the two programs have been shown to produce
the same externally observable behavior across the browser, protocol, terminal,
operating-system, and failure boundaries that users actually encounter.

This document defines that proof. It is intentionally stricter than the current
porting notes. A green test named after a module is evidence about the cases in
that test, not evidence that the module is complete.

"Remove JavaScript" has one important qualification: JavaScript evaluated
inside a web page remains necessary. Browser extraction, DOM activation,
mutation observation, and field access are page programs and must stay as
embedded assets. The retirement target is the Node implementation and Node
runtime, not `crystal/assets/*.js` or their source functions.

## The incident that exposed the current assurance gap

A direct `audio/ogg` response in Firefox creates a top-level media document.
The media host was present in native Crystal output, but Play, Position, Mute,
and Volume were absent. Three individually true statements failed to protect
that behavior:

1. The Crystal binary embedded the same AX extractor bytes as JavaScript.
2. Native-control activation already existed in the Crystal core.
3. View, action, Firefox, and dump differentials all existed and passed.

The missing behavior lived between those statements. JavaScript conditionally
called the extractor a second time with `pierce: true`; Crystal called the same
extractor with only `layout` and `visual`. Asset equality did not compare call
arguments or retry policy. The view fixture had no user-agent control. The
default native-browser runner also had a hand-maintained list that omitted
newer parity suites.

This class of bug is the main target of the plan: both implementations contain
the same pieces, but connect them differently at a seam no test observes.

## What parity means

For a given initial environment and input sequence, JavaScript and Crystal must
agree on all user- or browser-observable results:

- block text, order, identity, roles, names, values, states, metadata, and frame
  ownership;
- terminal bytes, cursor position, screen mode, repaint scope, and timing of
  status-row changes;
- browser side effects: navigation, focus, field values, selected options,
  media state, downloads, bookmarks, history, tabs, dialogs, and files;
- protocol behavior: commands, parameters, target/frame selection, retries,
  deadlines, event subscriptions, and cleanup;
- process behavior: launch, attach, keep/rejoin, shutdown, crash cleanup,
  broker ownership, and profile ownership;
- persistence: settings, keymaps, session records, history place, and update
  replacement;
- failures: error classification, user-facing wording, retained state,
  temporary-file cleanup, and exit status;
- performance characteristics that change usability, especially snapshot cost,
  per-keystroke work, frame fan-out, and privileged scans.

Exact internal implementation is not required. Exact observable behavior is.
A deliberate difference must be registered, justified, tested, and assigned an
expiry or permanent rationale. An unregistered difference is a failing parity
test, not a documentation task for later.

## Why the existing evidence is insufficient

### Static coverage is not behavioral coverage

`test/crystal_coverage.test.js` proves that a dispatched conformance operation
is named by a test and that each JavaScript module is imported or classified.
It does not prove that:

- every branch of the operation is exercised;
- all arguments are represented;
- browser callbacks occur in the same order;
- the real implementation, rather than a scripted stand-in, is reached;
- failures, races, and cleanup are covered;
- metadata omitted by a serializer is equal.

The static checks remain useful, but must be described as inventory checks,
not completeness checks.

### Asset equality does not prove invocation equality

`test/crystal_assets.test.js` proves that embedded page functions match their
JavaScript sources byte for byte. It does not compare:

- which function is selected;
- which frame or execution context receives it;
- the options object (`layout`, `visual`, `pierce`, `pairs`, and future fields);
- whether a privileged second pass happens;
- when first-pass output is retained;
- whether page-side node arrays survive a failed pass;
- whether the call uses by-value or owned handles;
- timeouts, retries, and navigation races.

Each asset therefore needs both a byte-equality test and an invocation-contract
test.

### Narrow serializers can hide mismatches

Several browser differentials intentionally compare a reduced block shape such
as text, role, name, index, and frame presence. That is useful for stable tests,
but it can hide a mismatch in `href`, state, `nativeControl`, `shadow`, markup,
flow/table metadata, geometry, file metadata, popup ownership, or activation
identity. Every omitted field must be covered by another differential or added
to the canonical shape.

### Scripted readers can agree while real readers disagree

Reader policy tests use scripted pages and cores so thousands of terminal-state
cases remain fast and deterministic. They prove the policy given the scripted
answers. They do not prove that JavaScript and Crystal browser cores produce
those answers. Every scripted seam needs a smaller set of real-browser contract
tests that show both implementations satisfy the script's assumptions.

### Separate browser runs can hide lifecycle differences

A comparison against two fresh browser profiles is necessary but not always
sufficient. Startup preferences, autoplay, cached service workers, browser
version, focus, foreground state, and broker reuse can differ. The suite needs
both independent-profile tests and controlled same-browser/kept-browser tests
where the protocols permit them.

## A machine-readable parity inventory

Create `test/parity-manifest.json` as the source of truth for retirement
coverage. Documentation may render it, but tests must read the manifest itself.
Each entry should contain:

```json
{
  "id": "views.ax.native-media-controls",
  "javascript": ["src/frames.js", "src/driver_firefox.js", "src/ax_own.js"],
  "crystal": ["crystal/src/tawb/firefox_driver.cr", "crystal/src/tawb/core.cr"],
  "surfaces": ["interactive", "dump", "edb"],
  "engines": ["chromium", "firefox"],
  "views": ["ax", "inspect", "source"],
  "fixtures": ["direct-ogg", "embedded-audio", "embedded-video"],
  "levels": ["asset-contract", "real-browser", "operation"],
  "tests": ["test/browser/crystal_media.test.js"],
  "status": "covered",
  "differences": []
}
```

Allowed status values:

- `uncovered`: no parity claim may be made;
- `scripted-only`: policy is compared, browser/environment contract is not;
- `single-engine`: one browser is missing;
- `single-surface`: interactive, dump, or edbrowse coverage is missing;
- `covered`: required dimensions and failure cases pass;
- `intentional-difference`: linked to a difference record with rationale;
- `retired`: behavior was removed from both implementations.

A test must fail when:

- a JavaScript module, Crystal module, exported operation, action id, CLI option,
  page asset, driver method, or view field is absent from the manifest;
- a manifest test path does not exist;
- a `covered` entry names a test skipped by the selected release gate;
- a required dimension is empty;
- an intentional difference has no owner/rationale/expiry;
- a test names a parity id not present in the manifest.

The manifest is not a checklist to mark optimistically. Status is derived where
possible from tests and gate results.

## Surfaces that require parity entries

### Command line, startup, and persistence

- argument parsing, aliases, environment variables, settings precedence, and
  malformed settings;
- `--help`, `--version`, `--update`, `--dump`, `--keyboard`, diagnostics, and
  every front end;
- working-directory restoration and local-file resolution;
- profile discovery, default profiles, explicit profiles, and incompatible
  Firefox profile handling;
- startup status timing and redirected/non-terminal output;
- keymap import, save, reimport, reset, conflicts, unsupported Lynx functions,
  and terminal capability lookup;
- version/revision resolution, update discovery, digest verification,
  writability, atomic replacement, symlinks, and read-only installs;
- log enablement, permissions, fields, counters, flush, disable, and crash logs.

### Browser launch and ownership

- new Chromium/Firefox launch, attach, and kept-browser rejoin;
- Firefox broker creation, reuse, stranded sessions, and session retention;
- automation-flag clearing in parent and child processes;
- browser executable discovery and version/profile compatibility;
- private accessibility/session buses and portal selection;
- profile locks, simultaneous readers, claimed tabs, dead-owner cleanup, and
  registry races;
- owned versus adopted initial tabs and shutdown behavior;
- normal exit, EOF, interrupt, signal, crash, and bounded forced shutdown.

### Protocol clients

For CDP and BiDi, inventory every command/event pair used by the program:

- connection handshake, request ids, synchronous replies, errors, close, and
  malformed messages;
- page/frame/context enumeration and out-of-process frames;
- execution-context creation/destruction and navigation replacement;
- by-value evaluation, handles, shared ids, disposal, and stale handles;
- target/session attachment and detachment;
- keyboard, pointer, hover, slider geometry, downloads, and file assignment;
- navigation/load-state events, BFCache, fragments, failures, and timeouts;
- auth interception and cancellation;
- dialogs, downloads, history traversal, foreground state, and browser close;
- child-frame ordering, detached frames, frame budgets, and frame limits;
- privileged root discovery, root-to-host pairing, retry/fallback, and races.

Every protocol wrapper must have a fake-wire transcript test and at least one
real-browser behavior test. Fake tests prove message shape and error handling;
real tests prove the browser accepts the shape and produces the expected event.

### Extraction and the four views

For AX, PAGE, INSPECT, and SOURCE, compare:

- headings, prose, inline links, buttons, all field types, values, and states;
- images, CSS background/generated images, canvas, SVG, media, frames, tables,
  lists, details, dialogs, and landmarks;
- accessible names from labels, labelledby, hidden references, pseudo-content,
  native mechanisms, and invalid nested controls;
- hidden, inert, modal, opacity, visibility, display:contents,
  content-visibility, and closed details;
- open, closed, and user-agent shadow roots, nested roots, slots, fallback
  slots, and roots that disappear during extraction;
- same-origin, cross-origin, out-of-process, hidden, detached, and deeply nested
  frames;
- generated accessibility nodes with no DOM element;
- native media controls, browser-owned markup, direct media documents, and
  dynamic control visibility;
- inline flow, tables, rectangle geometry, container paths, writing modes,
  direction, columns, unplaced blocks, and nested containers;
- node indices, frame identity, activation identity, and failed-pass rollback;
- source folding rules and INSPECT semantic/markup pairing.

Required fixture contexts include ordinary HTML, authored media, direct media
responses, closed-root-only applications, non-empty pages containing closed
roots, modal overlays, cross-origin frames, and documents navigating during a
walk.

### Core buffer and live updates

- initial scan, generation, rendered URL, frame arming, popup relocation, and
  attached-file restoration;
- block identity, diff regions, text lookup, remapping, anchors, exact/nearest
  restore, and ambiguous text;
- live observer install, pulse, drain, classification, pure-text patching,
  refresh scheduling, duty cycle, input grace, and ticker suppression;
- announcements, politeness, hold times, queues, status interaction, and
  keystroke completion;
- navigation during refresh, refresh during action, mutation during snapshot,
  and stale-generation rejection;
- load-more probing, scroll restoration, exhaustion invalidation, and feeds;
- snapshot extraction/order timings and performance counters.

### Actions and controls

For every control role and action route, compare both returned status and page
side effect:

- DOM default activation;
- trusted real click and inner-target selection;
- closed/user-agent-shadow activation;
- links, fragment links, target tabs, downloads, and popup controls;
- fields, textareas, contenteditable, inherited editability, caret, selection,
  submit, blur, and browser-refused edits;
- native select opening, filtering, disabled choices, choosing, and cancelling;
- file inputs, multiple files, accept filters, remembered attachments, portals,
  document-portal exports, and stale controls;
- ARIA/native sliders, spinbuttons, orientation, Home/End/Page keys, pointer
  fallback, overlapping mute buttons, and read-back verification;
- media Play/Pause, Mute, Position, Volume, overflow menus, playback rate,
  controls disappearing, and direct audio/video documents;
- autofill detection, remembered-password trusted presses, and auth prompts;
- focus tracking, focus moved by activation, detached focus targets, and
  controls omitted by the active view;
- hover-opened menus and pointer approach geometry;
- page-keyboard mode, unsupported terminal sequences, repeated exit chords,
  and deferred rescans.

### Reader and terminal

- every mode and screen-stack transition;
- every action id in every interface and imported Lynx function;
- browse movement, caret movement, quick navigation, paragraphs, screens,
  half-screens, table spans, composite rows, and wrapping;
- title/address/hint/status rows, message history, link targets, prompts,
  Unicode presentation, and truncation;
- repaint minimization, terminal scrolling, resize, stale-tail clearing,
  alternate-screen entry/exit, scroll-region reset, and cursor placement;
- forms, control, page-keyboard, address, find, number, auth, command, chooser,
  library, options, keyboard, dialog, and file-prompt modes;
- default and Lynx profiles, including SHOW_CURSOR and exact ANSI output;
- EOF, Ctrl+C, signals, slow actions, and status announcements during actions.

Scripted state tests cover the combinatorial policy. Tmux tests must cover at
least one real path through every mode and every screen ownership boundary.

### Tabs, history, libraries, dialogs, and integration

- tab open/follow/background announcement/switch/close/last-tab behavior;
- page history, session history, visited links, bookmarks, downloads, link
  lists, messages, document info, and filtering;
- Chromium internal library pages and Firefox privileged library agent;
- save/delete bookmark identity and duplicate URLs;
- native dialogs through AT-SPI, buttons, toggles, fields, default actions,
  refusal, dialog replacement, and reopen behavior;
- D-Bus codec/client errors, accessibility-bus selection, portal protocol,
  Flatpak proxying, and no-desktop environments;
- edbrowse extraction, descriptors, stale buffers, forms, routes, auth,
  restart, and every view.

## Required comparison dimensions

Not every pure function needs a full Cartesian browser matrix, but every
browser-facing behavior must declare which dimensions apply:

| Dimension | Required values |
| --- | --- |
| Runtime | Node reference, native Crystal |
| Engine | Chromium, Firefox |
| Browser lifecycle | fresh launch, attach/rejoin where supported, kept browser |
| Surface | interactive default, interactive Lynx, dump default, dump Lynx, edbrowse where applicable |
| View | AX, PAGE, INSPECT, SOURCE |
| Document | top level, same-origin frame, cross-origin/OOP frame |
| Root | light DOM, open shadow, closed shadow, user-agent shadow |
| Navigation state | settled, loading, navigating, detached, BFCache/fragment where applicable |
| Input route | DOM action, trusted pointer, trusted keyboard, native descriptor |
| Outcome | success, refusal, timeout, stale target, browser closed |
| Terminal | ordinary TTY, redirected stdout, resize, EOF/signal |
| Browser version | distribution/current stable; Firefox stable, beta, nightly release gate |

Critical paths receive the full applicable matrix: extraction, activation,
navigation, tabs, live updates, file selection, auth, and shutdown. Less
critical pure presentation code may use pairwise cases, but the manifest must
record why.

## Test layers

### Layer 0: inventory and generated assets

Keep and expand static checks:

- every source module and Crystal module classified;
- every public action, CLI option, environment variable, setting, driver
  method, page asset, conformance operation, and manifest id inventoried;
- embedded asset bytes match their source;
- default test runners discover suites by convention, never by a drifting
  hand-maintained list;
- a freshly built binary reports the commit under test.

These checks prevent forgotten files. They make no behavioral completeness
claim.

### Layer 1: pure differential and property tests

Run identical generated inputs through both implementations for:

- parsers, address resolution, keymaps, layout, remapping, diffing, list models,
  Unicode, terminal rendering, state transitions, and update parsing;
- malformed, empty, boundary, duplicate, non-ASCII, and oversized values;
- randomized block lists, nested layout paths, frame trees, mutation batches,
  and key sequences using deterministic seeds.

On failure, print the seed and minimized case. Add invariant checks, not only
reference equality: object identity retained after ordering, no duplicate
blocks, cursor in bounds, no control bytes in rows, no stale attachment, and
no unbounded queue.

### Layer 2: seam-contract and protocol-transcript tests

Instrument interfaces rather than only results. Compare ordered traces for:

- page-function source, target context, arguments/options, ownership mode,
  timeout, and retry count;
- privileged first/second-pass decisions and retained fallback;
- protocol commands and event subscriptions;
- handle creation/disposal;
- browser calls made by reader actions;
- filesystem operations for settings, update, profile, registry, and logs.

The media bug must be representable as a failing trace:

```text
first AX call:  {layout:false, visual:false, pierce:false}
media probe:    true
second AX call: {layout:false, visual:false, pierce:true}
```

A matching final media host line is not enough if that trace differs.

### Layer 3: real-browser core differentials

Use deterministic local servers and fresh profiles. Compare canonical core
observations, not screenshots alone:

- complete block records with a documented normalizer;
- browser side effects before/after actions;
- page/frame/handle lifetime behavior;
- event sequence and bounded timings;
- both engines and all views.

Run some cases in independent browsers and some sequentially against the same
kept browser. Never use arbitrary sleeps when a DOM event, protocol event, or
state predicate can provide a barrier.

### Layer 4: black-box terminal differentials

Drive both executables in tmux without reading internal state. Compare:

- terminal bytes after normalization of program name only where deliberate;
- cursor row/column;
- status timing and repaint count;
- page/browser side effects through the fixture server;
- process and browser lifetime after exit.

Build scenario coverage for all modes and screen-stack layers, not just a
single long happy path. Include repeated keys and actions that complete while
live announcements arrive.

### Layer 5: environment and release tests

Run the built static artifact in environments that cannot be simulated by the
conformance protocol:

- current distribution Chromium and Firefox;
- Mozilla stable, beta, and nightly archives;
- no DISPLAY, Xvfb, real desktop bus, private bus, and redirected output;
- Flatpak Firefox with portal/document-portal paths;
- read-only installation, symlink installation, and no-network update errors;
- constrained memory, `/dev/shm`, process count, and CPU;
- clean machine with no Node installed.

The exact release artifact, not a development binary built earlier in the job,
must pass this layer.

## Canonical observation formats

Define versioned serializers under `test/parity/` rather than ad hoc `kept()`
functions. Separate serializers by contract:

- `block-v1`: text, kind, paragraph/block flags, spans, and every item field
  consumed downstream;
- `screen-v1`: terminal rows, cursor, mode, scroll, status, drawn cache, and
  messages;
- `page-effects-v1`: URL, focus, media state, form values, selected options,
  downloads, tabs, and fixture counters;
- `protocol-trace-v1`: operation, target, normalized arguments, result/error,
  and handle lifecycle;
- `process-v1`: pids/roles, ownership, endpoint records, exit status, and
  surviving processes;
- `timing-v1`: phase durations and operation counts with explicit tolerances.

Do not drop dynamic fields merely to make equality easy. Classify each field:

- exact;
- normalized (for ids, ports, paths, timestamps);
- invariant-tested;
- engine-specific and compared within engine;
- intentionally different with a registered rationale.

A serializer change is a contract change and must update its manifest entries.

## Fixture catalog

Create deterministic fixtures for at least the following:

1. Complete semantic content coverage.
2. Every native HTML control and every supported ARIA role/state.
3. Accessible-name edge cases and hidden references.
4. Open, nested closed, and user-agent shadow roots.
5. A non-empty light DOM plus essential content only in a closed root.
6. Same-origin, cross-origin, OOP, hidden, detached, and navigating frames.
7. Direct Ogg audio, direct video, embedded audio/video, and custom media.
8. Media overflow/playback-rate controls and controls that auto-hide.
9. Modal/inert overlays, stale inert, dialogs, details, and display:contents.
10. CSS flex/grid/table/columns, RTL, vertical writing, overlap, sticky/fixed,
    and geometry-less generated nodes.
11. Dynamic text-only updates, structural updates, live regions, tickers,
    mutation storms, and updates during input.
12. Forms, autofill, authentication, file upload, native select, and sliders.
13. Trusted-click-only controls, hover menus, nested controls, and popups.
14. Slow responses, redirects, failed navigation, partial bodies, downloads,
    and auth on subresources.
15. Tab/background/target-blank/history/BFCache/fragment behavior.
16. Browser libraries with duplicate bookmarks, downloads in progress, and
    large histories.
17. Native dialogs and file portals.
18. Large/adversarial pages: thousands of nodes, hundreds of frames, deep
    shadow nesting, long lines, Unicode, and repeated names.

Fixtures that need media or binary content belong in `test/fixtures` and are
served locally with explicit content types. Do not depend on system sound
files, public sites, or network timing.

## Failure and race injection matrix

For each asynchronous seam, test failure before, during, and after the action:

- browser closes before command, while awaiting, and after side effect;
- frame detaches before extraction, between first and privileged pass, and
  while resolving a returned item;
- document navigates between snapshot and activation;
- handle is stale, disposed twice, or belongs to the previous document;
- privileged root disappears or helper is unavailable;
- protocol replies with error, malformed result, unknown event, or no reply;
- navigation starts but never reaches DOMContentLoaded;
- live mutation arrives during refresh, action, prompt, and tab switch;
- file/dialog/portal request closes while being answered;
- settings/log/temp/update files become unwritable mid-operation;
- broker or parent reader dies while ownership is being transferred;
- terminal resizes or reaches EOF during a slow operation;
- keyboard input repeats across a mode transition;
- DNS, TLS, redirect, digest, fsync, chmod, and rename fail during update.

Every failure case must assert retained state and cleanup, not only an error
message. No temporary file, browser, broker, claim, held request, handle, or
terminal mode may leak.

## Mutation tests for the parity suite

A parity suite is credible only if representative regressions make it fail.
`tools/test_mutations.sh` copies HEAD to a scratch directory, applies one
mutation from `tools/mutations.py`, rebuilds when the gate needs a binary, and
requires the named gate to fail. Applying a mutation asserts that its target
text appears exactly once, so a refactor cannot turn it into a silent no-op.
`TAWB_MUTATION_ROTATE=1` selects one mutation by day for ordinary CI;
`TAWB_MUTATION_KEEP=1` keeps the scratch tree and logs.

Implemented and verified caught:

- `privileged-media`: stop taking Firefox's privileged AX pass, which removes
  native media controls from a direct media document;
- `native-control-field`: drop `nativeControl` from canonical block
  serialization;
- `live-refresh-guard`: allow a live refresh while another is already running;
- `browser-discovery`: omit the live-update browser differential from the
  discovered suite;
- `handle-dispose`: omit the disown that releases the element handle an action
  held;
- `scroll-region-reset`: repaint the list without resetting the terminal scroll
  region;
- `frame-target-top`: press a control hidden in a child frame against the tab's
  top document instead;
- `navigation-subscription`: stop subscribing to and following the load
  navigation event;
- `early-status-fallback`: paint the link fallback at the start of a browse
  action instead of after it finishes;
- `keymap-action`: remove the `next-line` action from the browse keymap
  dispatch;
- `typed-row-generation`: keep using the old caret column after a concurrent
  write invalidated the typed-row patch;
- `update-rename-failure`: report a failed replacement as a completed install.
  The local release-server seam `TAWB_UPDATE_FAIL_REPLACE` reaches the rename
  failure after every earlier check has passed; a read-only binary alone stops
  at the writability check and never exercises it.

The navigation, typed-row, and replacement cases needed contract tests before
they could catch their mutations: the default subscription list is asserted on
the wire, a scripted concurrent terminal write forces the typed-row patch to
choose its absolute start, and the update test injects a refused replacement.

Run a rotating subset on ordinary CI and the full mutation set before a
retirement milestone. A mutation that survives identifies a real coverage gap.

## Performance and resource parity

Behavioral equality that makes the native reader unusably slower is not parity.
For representative small, medium, large, frame-heavy, shadow-heavy, and live
pages, record:

- startup phases;
- extraction and ordering separately;
- number of page evaluations and protocol commands;
- privileged scan count;
- frame queries/resolutions;
- snapshot, reanchor, draw, and total refresh time;
- key-to-final-status latency;
- memory, file descriptors, handles, processes, and threads;
- idle live-pulse cost and mutation-storm duty cycle.

Set budgets as ratios plus absolute ceilings. Initial retirement targets:

- no extra privileged pass when JavaScript would not make one;
- no additional per-block/per-container full scan;
- no unbounded growth over a one-hour live-page soak;
- median native latency no worse than JavaScript by 20% for browser-bound
  operations, with any exception documented by phase;
- p95 terminal key latency below the user-visible threshold for local actions;
- identical frame and retry limits.

Performance failures produce phase logs and call counts, not only a total.

## Automation and gates

Create one top-level `tools/test_parity.sh` that builds a fresh native binary
and runs, in order:

1. `npm test`;
2. `tools/test_crystal.sh`;
3. JavaScript browser suites on Chromium;
4. JavaScript browser suites on Firefox;
5. `tools/test_crystal_browser.sh` with every discovered differential;
6. native/JavaScript content-coverage matrix on both engines and all views;
7. native/JavaScript ARIA-AT and focused WAI-ARIA gates;
8. protocol fault-injection suites;
9. black-box tmux suites for both interfaces;
10. process-leak and cleanup checks;
11. performance smoke budgets.

Rules for the script:

- fail on any unexpected skip, todo, cancellation, timeout, or unhandled test
  process;
- print the exact selected test files before running;
- verify the tested binary revision equals `HEAD` and embedded assets match;
- isolate profiles, buses, ports, HOME, XDG directories, and process namespace;
- retain mismatch artifacts and logs under one reported directory;
- support sharding without changing the union of selected tests;
- emit a machine-readable summary keyed by parity-manifest id.

Nightly/release gates additionally run the browser-version matrix, Flatpak,
full mutation tests, long live-page soak, and static-artifact/no-Node test.

No documentation may say "all browser differentials" unless test discovery is
programmatic and the run summary proves none were skipped.

## Diagnostics on mismatch

Every real-browser differential should retain enough information to reproduce
without rerunning blindly:

- random seed and fixture URL/path;
- runtime and binary revision;
- browser executable/version/profile mode;
- normalized block/screen/effect snapshots from both sides;
- first differing field with surrounding entries;
- page-function call trace, including options and target context;
- protocol command/event trace around the mismatch;
- TAWB structured logs;
- fixture server request log;
- process inventory and endpoint records;
- terminal transcript for interactive cases.

Secrets, field values marked as passwords, cookies, and private URLs must be
redacted before artifacts are retained.

## Work phases

### Phase 0: correct the confidence claims

Deliverables:

- adopt this document;
- describe static coverage as inventory only;
- make browser differential discovery automatic;
- list every current skipped, single-engine, scripted-only, and untested area;
- stop using test-file count as a completeness statement.

Exit criterion: every existing parity claim links to the exact gate that
supports it.

### Phase 1: build the manifest and canonical serializers

Deliverables:

- `test/parity-manifest.json` with every current module/operation/surface;
- static manifest validation;
- versioned full block, screen, effect, protocol, process, and timing shapes;
- migrate reduced `kept()` serializers or document field-specific tests;
- difference registry with owner, reason, impact, and expiry.

Exit criterion: no unclassified JavaScript or Crystal behavior surface and no
unexplained omitted observation field.

### Phase 2: audit every page-asset invocation

For each asset, record and compare caller, target, arguments, retry/fallback,
handle ownership, and cleanup. Prioritize extractors, live observer/drain,
place/focus, click/slider, fields, and edbrowse.

Exit criterion: an invocation-contract mutation for every asset is caught.

### Phase 3: complete extraction/view parity

- run the full content fixture through runtime × engine × view;
- add direct media, closed/user-agent shadow, frames, modal/inert, generated
  content, and geometry fixtures;
- compare complete block contracts;
- cover initial, refresh, live rebuild, and view switch;
- add SOURCE and INSPECT privileged-root assertions.

Exit criterion: all extraction manifest entries are `covered` on both engines,
with zero unexplained block-field differences.

### Phase 4: complete action parity

- operate every control from every applicable view;
- verify page effects and returned statuses;
- cover trusted pointer/keyboard/native descriptor routes;
- cover stale/refused/disappearing controls;
- cover media, files, auth, focus, popups, and sliders in real browsers.

Exit criterion: every actionable block emitted by either runtime has a tested
successful route or a tested explicit refusal in both runtimes.

### Phase 5: navigation, frames, live updates, and tabs

- event-order and race matrix;
- same/cross-origin and OOP frames;
- redirects, failures, BFCache, fragments, history;
- mutation/action/navigation overlap;
- fresh, background, adopted, closed, and externally closed tabs.

Exit criterion: deterministic parity under injected event reorderings and real
browser lifecycle tests.

### Phase 6: reader/terminal black-box completion

- map every mode/action/screen to at least one tmux scenario;
- compare bytes, cursor, side effects, and repaint counts;
- resize, EOF, signals, slow actions, key repeat, and announcements;
- both interfaces and representative imported Lynx settings.

Exit criterion: no interactive behavior relies solely on scripted reader state.

### Phase 7: browser services and OS integration

- libraries, auth, native dialogs, D-Bus, AT-SPI, portal, Flatpak, file export,
  broker/rejoin, and process cleanup;
- success, cancellation, refusal, unavailable service, and crash paths.

Exit criterion: every external service has a fake protocol differential and a
real-environment test where feasible.

### Phase 8: fault, mutation, and performance qualification

- full failure matrix;
- mutation suite;
- performance corpus and budgets;
- one-hour live/idle/action soak with leak checks.

Exit criterion: required mutations fail the intended gate, no leak is observed,
and performance budgets pass.

### Phase 9: release-artifact qualification

- stable/beta/nightly Firefox;
- current Chromium;
- Flatpak and no-desktop environments;
- static binary on a machine/container with no Node;
- update from previous release and rollback rehearsal.

Exit criterion: the exact candidate artifact passes every release gate with a
machine-readable zero-gap summary.

### Phase 10: freeze and retire the Node runtime

1. Freeze Node behavior except fixes accompanied by Crystal parity tests.
2. Run both implementations for at least two release cycles with no new
   unexplained parity incident.
3. Require every manifest entry to be `covered`, `retired`, or an approved
   permanent difference irrelevant to Node removal.
4. Require zero skipped required parity tests on the release matrix.
5. Archive the final Node reference and differential fixtures in a tag.
6. Remove Node entry points and runtime dependencies, but retain page-side
   source functions and generated-asset verification.
7. Keep canonical behavior tests running against the archived reference or
   fixed golden protocol/screen/effect traces until a replacement independent
   oracle exists.
8. Publish a rollback procedure and retain the previous dual-runtime release.

## Immediate prioritized backlog

This backlog is ordered by expected finding rather than by area. The plan-era
record is the basis for the order: its behavioural additions found product
defects at seams no earlier test observed, while the breadth additions mostly
confirmed behaviour that was already covered. The first group therefore proves
that the suite can catch a regression at all; the next groups move from the
failure, lifecycle, and protocol seams where historical defects clustered,
through reader and terminal modes, to performance and release qualification,
which find little but block shipping a regression. Static inventory work is
kept in the completed list because it prevents silent omission without finding
behavioural bugs by itself.

### P0: prove the suite catches regressions

- [x] Mutation testing. Add the scratch-tree mutation harness and the first
  six mutations from "Mutation tests for the parity suite". Each named gate
  fails when its mutation is applied; survivors are reported by name and the
  script exits non-zero. Run a rotating subset in ordinary CI and the full set
  before a retirement milestone.
- [x] Extend the mutation set to the remaining named regressions in "Mutation
  tests for the parity suite".

### P1: failure, race, and cleanup

- [x] Add failure/cleanup matrix and process-leak assertions. Cover browser
  close before, during, and after an action; frame detach between extraction
  passes and during activation; navigation that never settles; stale or
  double-disposed handles; broker death during ownership transfer; EOF,
  signals, and resize during slow operations; and unwritable settings, log,
  temporary, and update files. Assert retained state and cleanup, not only the
  error text, and assert that no browser, broker, claim, handle, or temporary
  file survives. Each seam below has both runtimes' retained state and cleanup
  asserted, and the slow-navigation cases use a response that never settles
  before the signal, resize, or end of input.
  - [x] Refused log writes disable diagnostics in both runtimes without
    crashing or leaving a partial diagnostics file.
  - [x] Refused settings replacement retains the previous target and accepted
    in-session state, reports the failure, and removes the temporary file in
    both runtimes.
  - [x] Double disposal releases a held Chromium object exactly once in both
    runtimes; the second disposal emits no protocol cleanup command, and later
    use of that stale handle is refused without browser traffic.
  - [x] Refused update replacement and digest failure preserve the installed
    artifact and remove every downloaded temporary file.
  - [x] Broker death during a command or ownership handoff replaces the broker,
    serves the waiting reader, and clears the departed broker's record.
  - [x] Browser closure during a BiDi action fails the outstanding action;
    closure after its reply retains the completed side effect and answer, and
    closure before the next action refuses it without replaying the first.
  - [x] Frame removal during activation, live mutation, and navigation converges
    on the new document without retaining the detached frame or its text.
  - [x] A signal during a slow navigation leaves within the shutdown grace,
    closes the browser, and leaves no process naming the profile in both
    runtimes.
  - [x] A resize during a slow navigation applies the new size to the arriving
    document and leaves both runtimes drawing the same screen and cursor.
  - [x] The keyboard ending during a slow navigation cancels it in both
    runtimes and records the interruption as input, so a live refresh cannot
    mistake the cancelled action for an idle reader.
- [x] Add kept-browser and same-browser sequential differentials per feature.
  Rejoin a browser a reader kept, run several documents through one tab, and
  run two readers against one browser while one leaves. Compare the same
  canonical observations as the independent-profile differentials, so state
  that only survives a fresh profile cannot hide.
- [x] Trace and compare protocol calls/options/events. Extend the
  protocol-trace contract from page-function invocations to the ordered
  command, subscription, event, target/frame selection, retry, deadline, and
  cleanup traffic of a scenario. Compare within an engine across runtimes, not
  across protocols.

### P2: reader and terminal

- [ ] Expand tmux coverage to every mode and screen transition. Give every
  mode, screen-stack ownership boundary, odd terminal escape family, resize,
  EOF, signal, slow action, held key, and live announcement at least one real
  terminal path through both interfaces. Compare bytes, cursor, side effects,
  and repaint count.
  - [x] Drive the find, command, page-keyboard, forms, control, file, number,
    and field-command modes through a real tmux pane in both runtimes. The
    default and Lynx interfaces each cover the modes they actually implement:
    Lynx keeps forms in its browse map and has no separate forms mode.
  - [x] Open and leave the address bar, the browser's bookmark list, the
    keyboard wizard, and the Lynx options screen through both real terminals.
    Each screen takes the rows it owns and gives the page back on Escape; the
    wizard's save question is answered and the options screen is cancelled.
  - [x] Open a native select from the page, move through its choices, write
    one back, and cancel a second visit, in both terminals. The ordinary
    interface reaches the select as a form field; Lynx enters its line editor
    first and Escape gives Enter the control itself.
  - [x] Put a polite and an assertive live-region announcement on the status
    row of both interfaces through a real browser and tty, spaced past the
    polite hold, and compare the rows both runtimes drew.

### P3: performance and endurance

- [ ] Performance corpus and budgets. Record startup, extraction, ordering,
  privileged scans, protocol commands, frame queries, refresh phases, key
  latency, memory, handles, and idle pulse cost over small, large, frame-heavy,
  shadow-heavy, and live pages. Enforce ratio and absolute budgets with phase
  logs on failure.
  - [x] Add a five-page Firefox corpus that records startup, key-to-status
    latency, a complete refresh, first and settled idle CPU, resident memory,
    descriptors, and live-pulse/refresh/snapshot counts for both runtimes. The
    gate enforces native/reference ratios and absolute ceilings and prints
    every phase plus the diagnostic event counts on failure.
    `TAWB_PERF_ONLY` narrows the corpus while calibrating and
    `TAWB_PERF_REVERSE` flips the runtime order so an order bias is visible.
    Native snapshot extraction currently measures around 1.5-1.7 times the
    JavaScript phase on the frame, shadow, and live pages; that ratio is
    recorded but not yet budgeted, so this item stays open. Chromium,
    privileged-scan, protocol-command, frame-query, and handle counts remain
    with the wire-level gates.
  - [x] Log the native snapshot's extraction and ordering phases under the same
    `snapshot` event and field names as JavaScript, so a slow refresh can be
    attributed rather than guessed at.
  - [x] Stop applying a payload-free live cycle when the buffer is clean. The
    unconditional idle repaint cost about 500ms of native reader CPU per four
    idle seconds on a 1500-paragraph page; gating the cycle on dirty state
    brought it to about 40ms and the whole reader-plus-browser idle cost to the
    JavaScript level.
- [ ] Long soak and leak tests. Run the live, idle, and action paths for an
  hour with growth, descriptor, handle, and process assertions. A bounded
  short soak may run in CI, but it does not replace the long run.
  - [x] Add a soak that keeps a real page mutating on two scales, drives the
    reader through movement, refresh and activation, samples the reader and
    browser process group from outside, and asserts bounded descriptors,
    resident memory, process count, continued responsiveness and complete
    cleanup. The browser gate runs 30 seconds per runtime as a smoke case;
    `tools/test_soak.sh` runs the same assertions for an hour per runtime.
    Browser-side handle lifetime remains on the wire assertions in the
    double-disposal and protocol-trace tests.

### P4: release qualification

- [ ] Browser release matrix for the native artifact. Run the exact candidate
  artifact against distribution Chromium and Firefox stable, beta, and nightly,
  including Flatpak and no-desktop environments.
- [ ] Two release cycles with zero unexplained parity incidents. Freeze Node
  behaviour except fixes that arrive with a Crystal parity test, and keep both
  runtimes shipping until the manifest is complete on two consecutive releases.

### Completed

Kept for the record; these are no longer priority work.

- [x] Restore native Firefox privileged media extraction and SOURCE roots.
- [x] Add direct Ogg extraction/operation parity coverage.
- [x] Discover all conventionally named native browser differentials.
- [x] Add the parity manifest and fail on unclassified surfaces.
- [x] Make the browser gate fail on unexpected skips.
- [x] Verify binary revision/assets before browser tests.
- [x] Inventory every asset invocation contract (caller, target, arguments,
  retry, ownership, and cleanup).
- [x] Add option/target protocol traces for every asset invocation.
- [x] Replace narrow block serializers with the canonical block contract.
- [x] Run content coverage as a native differential on both engines/all views.
- [x] Port the complete `test/browser/views.test.js` scenario set into a
  runtime differential rather than one representative page.
- [x] Add user-agent, open, and closed-root operation tests to both engines.
- [x] Add frame/navigation/live/action race fixtures.
- [x] Run native extraction through the adapted ARIA-AT gate.
- [x] Run native extraction through the adapted WAI-ARIA role gate.
- [x] Add direct video and long/streaming media alongside Ogg audio.
- [x] Add native dialog, portal, and Flatpak parity to the unified manifest.
- [x] No-Node deployment test.

## Reporting progress

Every parity change should report:

- manifest ids moved and old/new status;
- exact tests added, including engines/surfaces/views;
- whether tests use scripted or real browser state;
- failure and cleanup cases covered;
- mutations known to be caught;
- remaining dimensions and why they remain;
- performance effect where browser calls changed.

A release summary should state counts by status and list every non-`covered`
entry. "Everything else is correct" is not an acceptable conclusion unless the
manifest is complete and the full retirement gate is green. The correct answer
before then is the measured scope: what was compared, on which engines and
surfaces, and what remains unproved.
