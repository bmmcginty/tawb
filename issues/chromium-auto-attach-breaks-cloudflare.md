# Chromium target auto-attachment breaks a Cloudflare check

## Request

A reader reported that Chromium could not pass the human-verification check at:

```text
https://www.axs.com/events/1599919/isaiah-rashad-tickets?skin=thesignal
```

The same browser should represent the reader as a human rather than make a site reject them because TAWB is attached. The requested investigation was to test the Cloudflare page, inspect the matching Chromium sources, identify the cause, and find a fix that does not replace TAWB's frame and page handling.

## Observed behavior

With TAWB's normal Chromium connection, the page ended at:

```text
Just a moment...
Ensuring a fair fan experience
```

The HTTP response had `cf-mitigated: challenge`, and the page eventually displayed an AXS support request ID instead of the event. There was no checkbox or other control for the reader to press.

The same Chromium 151.0.7922.169 executable, network connection, Xvfb display, and fresh profile passed the check when run without TAWB's complete target setup. `navigator.webdriver` was `false` in the failing browser.

## Controlled results

| Configuration | Result |
| --- | --- |
| Chromium without CDP | Passed |
| Remote-debugging port without a client | Passed |
| CDP WebSocket connected without commands | Passed |
| `Page.enable` | Passed |
| `Runtime.enable` | Passed |
| `Page.enable` and `Runtime.enable` | Passed |
| TAWB's complete target setup | Failed |
| TAWB setup with per-page auto-attachment disabled | Passed |
| Per-page auto-attachment without waiting for the debugger | Failed |
| Per-page auto-attachment filtered to iframe targets | Failed |
| Browser target discovery and explicit iframe attachment | Passed |

A failing run auto-attached both a Cloudflare-related blob worker and an iframe:

```json
[
  {
    "type": "worker",
    "url": "blob:https://www.axs.com/...",
    "waiting": true
  },
  {
    "type": "iframe",
    "url": "",
    "waiting": true
  }
]
```

Even a `Target.setAutoAttach` filter that matched no targets disturbed the challenge. This showed that actual attachment was not required to cause the failure.

## Cause in Chromium

The matching Chromium source was inspected at tag `151.0.7922.169`. A page-level `Target.setAutoAttach` follows this path:

```text
TargetHandler::SetAutoAttach
  -> TargetAutoAttacher::AddClient
  -> FrameAutoAttacher::UpdateAutoAttach
  -> RendererAutoAttacherBase::UpdateAutoAttach
  -> DevToolsRendererChannel::SetReportChildTargets
  -> blink::DevToolsAgent::ReportChildTargetsImpl
```

Blink then changes renderer state:

```cpp
report_child_workers_ = report;
pause_child_workers_on_start_ = wait_for_debugger;
```

Chromium applies the protocol target filter later, in `TargetHandler::AutoAttach`, after the renderer has enabled child-worker reporting and created the worker's DevTools plumbing. Consequently, an iframe-only or match-nothing target filter does not prevent the observable worker-side change. Setting `waitForDebuggerOnStart` to false avoids the pause but still enables child-worker reporting.

TAWB does not use worker or worklet sessions; it immediately detaches targets other than iframes. The worker instrumentation is therefore both unnecessary and harmful.

## Response and selected fix

The supported-protocol fix is to change only how out-of-process iframe sessions are acquired:

1. Retain browser-level automatic attachment for top-level page targets.
2. Stop enabling recursive `Target.setAutoAttach` on page and iframe sessions.
3. Discover iframe targets with browser-level `Target.setDiscoverTargets`.
4. Attach each discovered iframe explicitly with `Target.attachToTarget`.
5. Match it to its existing page through `targetId` (the frame ID) and `parentFrameId`.
6. Pass the resulting session through the existing `wireSession` path.

Live testing showed that explicit attachment could observe AXS iframe targets without causing the Cloudflare check to fail. Chromium's target information supplies deterministic frame ownership, so no URL matching is required.

This preserves TAWB's existing page objects, frame tree, execution-context tracking, extraction, coordinate translation, navigation handling, and activation. Only target discovery and session acquisition change.

Explicit attachment cannot pause an iframe before its first script. The implementation must therefore install scripts for future documents and initialize the iframe's current document where necessary. Initial page extraction remains authoritative even if an early mutation was not observed.

A native Chromium hook could suppress `DevToolsRendererChannel::SetReportChildTargets`, but it would be Build-ID-specific and fragile. Explicit iframe discovery uses supported CDP operations and is the preferred fix.

## Verification requirements

The implementation should verify:

- page sessions no longer request recursive automatic attachment;
- existing and newly created iframe targets attach explicitly;
- target and parent frame IDs assign an iframe to the correct tab;
- nested OOPIFs retain their page ownership;
- iframe session detachment removes stale frames;
- workers are neither paused nor attached;
- cross-origin frame reading and activation continue to work;
- the live AXS Cloudflare check passes.

The external AXS URL is a manual compatibility probe rather than a permanent CI dependency because its event data and Cloudflare policy are outside the project's control.
