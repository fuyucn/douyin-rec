# Room mode icons

Issue #531 / T-159 finalizes the approved eight-mark SVG family without changing recording or processing behavior.

The standalone files in packages/web/src/assets/modes are the geometry source:

| Asset | Meaning |
| --- | --- |
| archive.svg | Local archive |
| bilibili.svg | Upload enabled, not upload success |
| zero-disk.svg | Live-direct upload; its explanation distinguishes local fallback from no local video |
| segment.svg | Batch upload |
| merge.svg | Merge processing |
| node.svg | Node-side upload |
| split.svg | Keep separate segments |
| danmu.svg | Danmaku capture |

ModeLogo references the assets with external SVG use elements. Keep the no-inline import query: data URLs cannot reliably resolve external SVG fragments. The SVG outer element must retain currentColor and the existing sizing classes.

Room rows show icon-only buttons. Hover, keyboard focus, and touch activation expose the same explanation; Escape, outside activation, or another tap dismisses it. Each button has an accessible name. Editor choices retain visible labels. Indicators describe configuration, not live activity or successful publication; the status and last-delivery columns remain authoritative for those facts.

The pure roomModeIndicators projection uses recording.danmu rather than burn-output settings. Paused processing rules do not advertise upload enablement; pausing only the recorder does not hide an enabled upload rule, it adds the paused explanation. Legacy rolling follows the authoritative `recording.rollingEffective` flag even when the rule's upload mode is missing, set to upload, or the rule is absent; an explicit stage or unknown mode in the rule always wins over a stale effective field, and unknown future modes receive no guessed mark.

The delivery mark is independent of the Bilibili mark. A rule with after-close upload shows merge (whole video) or split (per segment, `mergeSegments: false`), or node when node-side upload is configured with burning off (canonical `pipelineBurns`, never a local burn-flag copy). The Bilibili mark still means upload is enabled.

## Validation

Run the full repository tests and type checks, web build, and bundle as required by AGENTS.md. The targeted tests are test/web/mode-assets.test.ts, test/web/room-method.test.ts, and test/web/room-mode-indicators.test.ts.

The browser regression uses the installed Playwright package and a local Vite development server:

    pnpm --dir packages/web exec vite --host localhost --port 18766 --strictPort
    MODE_ICONS_BASE_URL=http://localhost:18766 node test/web/mode-indicators.browser.mjs

Install Playwright's Chromium beforehand, or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to an existing Chromium-family executable. The test opens isolated headless pages; it does not attach to a user's browser. It covers accessible names, hover, Tab, Escape, touch toggling, outside dismissal, and a 320-pixel viewport.

Chromium desktop and touch emulation are covered. Real iPhone Safari and WebKit remain manual verification targets.

The browser regression also mounts all eight marks and waits (no sleeps) until every `use` element resolves its referenced `mode-<kind>` group with nonempty width and height, so a broken fragment reference (for example a renamed group id) fails instead of silently passing.

## Review outcomes

- Touch focus can arrive after pointer release but before the click. Preserve pointer modality through that sequence so the click does not immediately close a focus-opened popup.
- Disable popup focus restoration for these non-modal explanations; restoring trigger focus can reopen a popup dismissed by an outside tap.
- Clear the active indicator when configuration removes it, and allow visible keyboard focus to recover after a pointer is released outside the trigger.
- Three 32-pixel controls need room beyond the table cell's horizontal padding; the method column is 136 pixels wide.
- Dynamic translation keys are checked in both dictionaries, and paused live-direct rules must not advertise upload enablement.

The earlier component-only audit passed after these corrections; a fresh full re-review of this branch is still pending. A paused rule intentionally has no Bilibili mark: that mark means upload is enabled, not merely configured. Its status and editor still explain the paused configuration; pausing only the recorder adds the paused explanation without hiding an enabled upload rule.
