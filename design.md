# Design — Douyin Rec Console

Locked design system for the web app (`packages/web`). Every page reads this
file before emitting code. Do not regenerate per page; amend this file when the
system needs to grow.

## Genre
modern-minimal, executed as a broadcast workbench: a bounded instrument panel,
not a marketing surface.

## Macrostructure family

- App pages: Workbench (Task List) / Console (Task Detail) / Diagram Control
  Room (Hub). All three share the rail nav, telemetry band, tabular spec sheet,
  mono data voice, and hairline separators. Page identity comes from layout
  rhythm, never from theme changes.

## Theme

Light (default): near-white neutral canvas, ink-charcoal text, blue signal accent.
Dark (`.dark`): charcoal canvas, pale ink, brighter blue accent.
Same semantic tokens in both; only the values change.

Tokens are declared in `packages/web/src/index.css` (`@theme` + `:root`/`.dark`)
as CSS custom properties. Components must reference tokens by name
(`var(--accent)`, `var(--ink)`) or Tailwind theme utilities (`text-ink`,
`border-hairline`), never inline raw hex values.

- Light canvas `#fcfcfc` · raised `#f5f5f5` · ink `#0a0e11`
- Light hairline `rgba(10,14,17,.08)` · body `#3f444a` · muted `#5f6469`
- Light accent `#007ac3` (blue, AA on white) · focus ring `#007ac3`
- Dark canvas `#151515` · raised `#1c1c1c` · ink `#eff2f5`
- Dark hairline `rgba(255,255,255,.06)` · body `#aeb4ba` · muted `#888d92`
- Dark accent `#46a6ef` (blue) · focus ring `#46a6ef`
- Success `#00bd6c` / dark `#00d294` · warning `#f5a500` / dark `#ffb65e`
  · danger `#ee343b` / dark `#ff5d63` · status/info `#007ac3` / dark `#46a6ef`

## Typography

- Display + body: Geist, weight 500-700 for display, 400-450 body.
- Data: Geist Mono, weight 450-650, tabular numerals.
- Display tracking: 0 (letter-spacing is never negative).
- Italic headers: none. Headings are roman only.
- Type scale anchor: page titles 26-32px; panel headings 15-18px; labels 11px
  mono uppercase; body 13-14px; table 13px.
- CJK text falls back to PingFang SC / Microsoft YaHei with the same weights.

## Spacing

4pt scale. Page gutter 16-24px; section gaps 20-24px; cell padding 12-14px;
control height 36-40px; compact control 32px. No floating-card stacks: bounded
shells separated by hairline rules and 1px borders.

## Motion

- Easings: `--ease-out: cubic-bezier(0.16, 1, 0.3, 1)` for enter states;
  `--ease-in: cubic-bezier(0.4, 0, 1, 1)` for exits; 120-200ms.
- Reveal pattern: none for page sections; skeleton shimmer for loading only.
- Reduced motion: all animation collapses to opacity-only <= 1ms duration.

## Microinteractions stance

- Silent success: no celebratory toasts. Toasts are compact, 8px, bordered.
- Hover delays: tooltips 80ms on hover, 0ms on focus.
- All interactive components ship 8 states: default, hover, focus-visible,
  active, disabled, loading, error, success.
- Focus ring: 2px solid `var(--accent)` at 2px offset, instant, never animated.

## CTA voice

- Primary: 36-40px filled blue rectangle, 6px radius, white label, one line.
- Secondary: same rectangle with paper fill, ink label, hairline border.
- Danger: same rectangle with danger fill only for destructive confirmations.
- Table actions: 32px icon buttons with bordered paper face.

## What pages MUST share

- The rail nav + single-line footer.
- Blue accent and its placement: active nav indicator, primary actions,
  focus rings, row-hover edge, telemetry highlights. Under 5% of any viewport.
- Geist + Geist Mono.
- Mono uppercase section labels (11px), square 6px chips, square status dots.
- Bounded shells: telemetry band, table, terminal, run list, modals.

## What pages MAY differ on

- Layout rhythm: Task List is a full-width spec sheet; Task Detail is a
  console with a 1/3 info column + dark terminal; Hub is a rail + pane diagram
  with React Flow pipeline.
- Empty, loading, and error states may use different composition per page.

## Per-page allowances

- App pages: no marketing enrichment, no decorative orbs, no gradients,
  no fake chrome. The terminal keeps its dark surface in both themes.

## Exports

### tokens.css

The canonical token block lives in `packages/web/src/index.css` under
`@theme` / `:root` / `.dark`. Colors are declared as named CSS variables:

```css
:root {
  --canvas: #fcfcfc;
  --raised: #f5f5f5;
  --surface: #f5f5f5;
  --surface-soft: #ededed;
  --hairline: rgba(10, 14, 17, 0.08);
  --ink: #0a0e11;
  --body: #3f444a;
  --muted: #5f6469;
  --muted-soft: #7a7f85;
  --accent: #007ac3;
  --accent-hover: #0064a3;
  --accent-fg: #fcfcfc;
  --accent-soft: rgba(0, 122, 195, 0.12);
  --success: #00bd6c;
  --warning: #f5a500;
  --error: #ee343b;
  --success-fg: #007a48;
  --warning-fg: #9a5c00;
  --error-fg: #c2253c;
  --status-fg: #007ac3;
  --success-bg: #00bd6c;
  --error-bg: #ee343b;
  --footer-text: #5f6469;
}
```

Dark values live in `.dark` (see `packages/web/src/index.css`).

### Tailwind v4 `@theme`

```css
@theme {
  --color-canvas: #fcfcfc;
  --color-ink: #0a0e11;
  --color-body: #3f444a;
  --color-muted: #5f6469;
  --color-muted-soft: #7a7f85;
  --color-hairline: rgba(10, 14, 17, 0.08);
  --color-surface: #f5f5f5;
  --color-surface-soft: #ededed;
  --color-accent: #007ac3;
  --color-accent-fg: #fcfcfc;
  --color-success: #00bd6c;
  --color-warning: #f5a500;
  --color-danger: #ee343b;
  --color-success-fg: #007a48;
  --color-warning-fg: #9a5c00;
  --color-danger-fg: #c2253c;
  --font-sans: "Geist", ...;
  --font-mono: "Geist Mono", ...;
}
```

### DTCG `tokens.json`

```json
{
  "color": {
    "canvas": { "$value": "#fcfcfc", "$type": "color" },
    "raised": { "$value": "#f5f5f5", "$type": "color" },
    "ink": { "$value": "#0a0e11", "$type": "color" },
    "accent": { "$value": "#007ac3", "$type": "color" },
    "accent-fg": { "$value": "#fcfcfc", "$type": "color" },
    "hairline": { "$value": "rgba(10,14,17,0.08)", "$type": "color" },
    "success": { "$value": "#00bd6c", "$type": "color" },
    "warning": { "$value": "#f5a500", "$type": "color" },
    "danger": { "$value": "#ee343b", "$type": "color" }
  },
  "font": {
    "sans": { "$value": ["Geist", "system-ui", "sans-serif"], "$type": "fontFamily" },
    "mono": { "$value": ["Geist Mono", "ui-monospace", "monospace"], "$type": "fontFamily" }
  }
}
```

### shadcn/ui CSS variables

OKLCH space-separated triples (no `oklch()` wrapper, no commas), mapped from
the tokens above. `--primary` and `--accent` both carry the blue signal.

```css
:root {
  --background: 98.8% 0.000 0; /* canvas */
  --foreground: 3.7% 0.004 232.0; /* ink */
  --card: 96.5% 0.000 0; /* raised */
  --card-foreground: 3.7% 0.004 232.0;
  --popover: 96.5% 0.000 0;
  --popover-foreground: 3.7% 0.004 232.0;
  --primary: 48.4% 0.142 234.0; /* accent */
  --primary-foreground: 98.8% 0.000 0;
  --secondary: 96.5% 0.000 0; /* surface */
  --secondary-foreground: 3.7% 0.004 232.0;
  --muted: 96.5% 0.000 0;
  --muted-foreground: 42.0% 0.008 225.0;
  --accent: 48.4% 0.142 234.0;
  --accent-foreground: 98.8% 0.000 0;
  --destructive: 53.7% 0.244 32.0; /* danger */
  --destructive-foreground: 98.8% 0.000 0;
  --border: 3.7% 0.004 232.0 / 0.08;
  --input: 3.7% 0.004 232.0 / 0.08;
  --ring: 48.4% 0.142 234.0;
  --radius: 0.375rem;
}

.dark {
  --background: 8.5% 0.000 0;
  --foreground: 95.4% 0.003 230.0;
  --card: 11.0% 0.000 0;
  --card-foreground: 95.4% 0.003 230.0;
  --popover: 11.0% 0.000 0;
  --popover-foreground: 95.4% 0.003 230.0;
  --primary: 64.8% 0.111 225.0; /* accent */
  --primary-foreground: 3.0% 0.000 230.0;
  --secondary: 11.0% 0.000 0; /* surface */
  --secondary-foreground: 95.4% 0.003 230.0;
  --muted: 11.0% 0.000 0;
  --muted-foreground: 58.2% 0.008 225.0;
  --accent: 64.8% 0.111 225.0;
  --accent-foreground: 3.0% 0.000 230.0;
  --destructive: 64.0% 0.220 18.0; /* danger */
  --destructive-foreground: 95.4% 0.003 230.0;
  --border: 100.0% 0.000 0 / 0.06;
  --input: 100.0% 0.000 0 / 0.06;
  --ring: 64.8% 0.111 225.0;
  --radius: 0.375rem;
}
```
