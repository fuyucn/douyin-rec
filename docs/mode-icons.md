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

The pure roomModeIndicators projection uses recording.danmu rather than burn-output settings. Paused processing rules do not advertise upload enablement. Missing legacy upload settings mean archive; unknown future modes receive no guessed mark.

## Validation

Run the full repository tests and type checks, web build, and bundle as required by AGENTS.md. The targeted tests are test/web/mode-assets.test.ts, test/web/room-method.test.ts, and test/web/room-mode-indicators.test.ts.

The browser regression uses the installed Playwright package and a local Vite development server:

    pnpm --dir packages/web exec vite --host 127.0.0.1 --port 18766 --strictPort
    MODE_ICONS_BASE_URL=http://127.0.0.1:18766 node test/web/mode-indicators.browser.mjs

Install Playwright's Chromium beforehand, or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to an existing Chromium-family executable. The test opens isolated headless pages; it does not attach to a user's browser. It covers accessible names, hover, Tab, Escape, touch toggling, outside dismissal, and a 320-pixel viewport.

Chromium desktop and touch emulation are covered. Real iPhone Safari and WebKit remain manual verification targets.

## Review outcomes

- Touch focus can arrive after pointer release but before the click. Preserve pointer modality through that sequence so the click does not immediately close a focus-opened popup.
- Disable popup focus restoration for these non-modal explanations; restoring trigger focus can reopen a popup dismissed by an outside tap.
- Clear the active indicator when configuration removes it, and allow visible keyboard focus to recover after a pointer is released outside the trigger.
- Three 32-pixel controls need room beyond the table cell's horizontal padding; the method column is 136 pixels wide.
- Dynamic translation keys are checked in both dictionaries, and paused live-direct rules must not advertise upload enablement.

The independent final code review passed after these corrections. A paused upload-only rule intentionally has no Bilibili mark: that mark means upload is enabled, not merely configured. Its status and editor still explain the paused configuration.
