---
name: Aether
description: A card dashboard proxy client — whether you are proxied, where the traffic is going, and how much is moving, all readable at 1280×800 without a click.
colors:
  bg: "#0A0B0D"
  sidebar: "#0C0D10"
  card: "#141619"
  card-2: "#181B1F"
  border: "#23262B"
  border-2: "#2C3037"
  text: "#E8E9EB"
  dim: "#9AA0A6"
  faint: "#7E858C"
  accent: "#4A8CFF"
  accent-strong: "#2F6FE0"
  accent-bg: "rgba(74,140,255,.12)"
  success: "#34D399"
  danger: "#F87171"
typography:
  display:
    fontFamily: '"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "Microsoft YaHei UI", "PingFang SC", sans-serif'
    fontSize: "30px"
    fontWeight: 650
    lineHeight: 1.15
    letterSpacing: "-0.02em"
  headline:
    fontFamily: '"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "Microsoft YaHei UI", "PingFang SC", sans-serif'
    fontSize: "26px"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  figure:
    fontFamily: '"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "Microsoft YaHei UI", "PingFang SC", sans-serif'
    fontSize: "28px"
    fontWeight: 650
    lineHeight: 1.1
    letterSpacing: "-0.02em"
    fontFeature: "tnum"
  title:
    fontFamily: '"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "Microsoft YaHei UI", "PingFang SC", sans-serif'
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  body:
    fontFamily: '"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "Microsoft YaHei UI", "PingFang SC", sans-serif'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: '"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "Microsoft YaHei UI", "PingFang SC", sans-serif'
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.4
  micro:
    fontFamily: '"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "Microsoft YaHei UI", "PingFang SC", sans-serif'
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.4
  mono:
    fontFamily: '"Cascadia Mono", "Consolas", ui-monospace, monospace'
    fontSize: "12px"
    fontWeight: 400
    fontFeature: "tnum"
rounded:
  card: "14px"
  control: "10px"
  nav: "8px"
  chip-inner: "7px"
  chip: "6px"
  mark: "5px"
  dot: "50%"
spacing:
  tight: "2px"
  snug: "8px"
  stack: "10px"
  gap: "14px"
  card: "16px 18px"
  page: "20px 24px"
  rail: "18px 12px 12px"
components:
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.text}"
    rounded: "{rounded.card}"
    padding: "{spacing.card}"
  nav-item:
    textColor: "{colors.dim}"
    typography: "{typography.body}"
    rounded: "{rounded.nav}"
    padding: "0 11px"
    height: "38px"
  nav-item-hover:
    backgroundColor: "{colors.card}"
    textColor: "{colors.text}"
    rounded: "{rounded.nav}"
  nav-item-active:
    backgroundColor: "{colors.accent-bg}"
    textColor: "{colors.accent}"
    rounded: "{rounded.nav}"
  segmented:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.control}"
    padding: "3px"
    height: "34px"
  segmented-option:
    textColor: "{colors.dim}"
    typography: "{typography.label}"
    rounded: "{rounded.chip-inner}"
    padding: "0 13px"
    height: "26px"
  segmented-option-active:
    backgroundColor: "{colors.card-2}"
    textColor: "{colors.text}"
    rounded: "{rounded.chip-inner}"
  proxy-pill:
    backgroundColor: "rgba(52,211,153,.10)"
    textColor: "{colors.success}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "34px"
  proxy-pill-off:
    textColor: "{colors.dim}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "34px"
  cta:
    backgroundColor: "{colors.accent-strong}"
    textColor: "#FFFFFF"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "34px"
  action-primary:
    backgroundColor: "{colors.accent-strong}"
    textColor: "#FFFFFF"
    typography: "{typography.label}"
    rounded: "{rounded.nav}"
    padding: "0 14px"
    height: "32px"
  action-secondary:
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.nav}"
    padding: "0 14px"
    height: "32px"
  chip-solid-muted:
    backgroundColor: "{colors.card-2}"
    textColor: "{colors.faint}"
    typography: "{typography.micro}"
    rounded: "{rounded.chip}"
    padding: "0 8px"
    height: "22px"
  chip:
    textColor: "{colors.dim}"
    typography: "{typography.micro}"
    rounded: "{rounded.chip}"
    padding: "0 8px"
    height: "22px"
  chip-solid:
    backgroundColor: "{colors.card-2}"
    textColor: "{colors.dim}"
    typography: "{typography.micro}"
    rounded: "{rounded.chip}"
    padding: "0 8px"
    height: "22px"
  icon-button:
    textColor: "{colors.faint}"
    rounded: "{rounded.chip-inner}"
    size: "24px"
---

# Design System: Aether

## Overview

**Creative North Star: "The Instrument Cluster"**

Aether's first screen is a dashboard in the automotive sense: four instruments you can read from across the room, and a workshop door marked 「连接」 for when something is wrong. The window opens on a 40px title bar over a 232px rail over a three-column field of 14px-radius cards — current node, kernel status, three rate readings, and a 60-minute flow chart. The largest object on the screen is a node name at 30px. The second-largest things are numbers. Everything that explains why lives one level down, on the page the artifact only links to.

The material is near-black layered paper: four surfaces within five percentage points of lightness, separated by 1px hairlines rather than shadows, with a single blue that behaves like a signal lamp, a green that means "healthy", and a red that appears only when something has broken. Density is no longer the argument — whitespace is. A card's label sits at 11–12px, its figure at 26–30px, and the space between them does the work a border used to do. Hover is a single tonal step; there is no elevation, no glass, no glow except the three-pixel ring around the status dot.

Confirmed rejections carried by the pivot: the dense htop-style grid is gone as a first surface (it survives as the 「连接」 page and is not documented from this artifact), and with it the brass-on-bone instrument palette, the 28px row lattice, and the zero-radius square. What was kept is the discipline: exactly one accent, tabular figures, and no decoration that does not report a fact.

**Scope of this document.** Recorded from the reference artifacts: `docs/design/mockups/variants/a-cards.html` with its capture `a-cards.png` for the connected default, and `docs/design/mockups/variants/a-states.html` with `a-state-1-offline.png`, `a-state-2-idle.png` and `a-state-3-error.png` for not started with the proxy off, connected but idle, and kernel error. There is no React implementation in the repository yet. Every figure, the chart and the 60-tick strip are demonstration data, not live values. Any state beyond these four has no recorded treatment and must not be improvised from them.

**Key Characteristics:**

- Four blocks, one screen, no scroll at 1280×800.
- Card surfaces at 14px radius on four near-black tones; separation by 1px hairline, never by shadow.
- One blue for action, one green for health, one red for failure — and the red shows only when something has broken.
- Figures 26–30px, labels 11–12px, and nothing in between.
- Every number is tabular; only the health percentage is set in mono.
- The mode switch (规则 / 全局 / 直连) is permanently in the top-right, beside the proxy pill.
- Hover is one tonal step and it is instant; the artifact declares no transitions at all.
- Status is a 7px dot and its 3px ring: green running, faint off, red failed.
- Solid blue is one button per screen; one red card is the whole failure treatment.

## Colors

Four near-black surfaces, two hairlines, three greys of type, and exactly three semantic hues — signal blue in two steps, health green, failure red. Blue marks action and red marks failure, each in exactly one place; green is the loudest of the three, which is the point: health outranks navigation.

### Primary

- **Signal Blue** (`accent`, #4A8CFF): the interaction colour. The active nav item's label and icon, the download badge glyph, the download series in the chart, the legend dot, the focus ring, text selection. It measures 5.60:1 on the card surface, so it can carry a 13px label. It never fills a surface — the solid fill belongs to `accent-strong` — and every area of this blue is a wash at 10–28%; see the One Solid Blue Rule.
- **Signal Blue Deep** (`accent-strong`, #2F6FE0): the fill blue. The background of the header primary action and of the error card's primary action, always under a white label, where it measures 4.70:1. It is not a text colour: on the card surface it reads 3.86:1, so it may appear only as a fill or a 1px border.
- **Blue Wash** (`accent-bg`, rgba(74,140,255,.12)): the fill behind the active nav item. The only place a full nav row is tinted; a row is 38px tall, so the wash is always a strip, never a panel.

### Secondary

- **Health Green** (`success`, #34D399): the state colour. The connected dot and its 3px halo, the word 已连接, the proxy-on pill (10% fill under a 35%-alpha border), the 60-tick health strip, the upload series in the chart, and the version dot at the foot of the rail. At 9.43:1 on card it is the loudest type colour in the product and is reserved for "this is alive".
- **Failure Red** (`danger`, #F87171): the failure signal, used only when the kernel has failed — the 7px status dot and its 3px red ring, the word 内核异常, and the error card's label and 1px border at 28% alpha (#542F32 composited on card). At 6.55:1 on card it can carry text, which is why the single sentence that matters during a failure can be red.

### Neutral

- **Near-Black Ground** (`bg`, #0A0B0D): the main scroll area behind the cards, and the page floor.
- **Rail Shade** (`sidebar`, #0C0D10): the title bar and the sidebar — one tonal step *below* the card surface, so chrome recedes and content comes forward.
- **Card Surface** (`card`, #141619): every card, and the segmented control's track.
- **Lifted Surface** (`card-2`, #181B1F): the active segment in the mode switch, solid chips, and the window buttons' hover fill. The top of the tonal ladder; nothing in the artifact is lighter.
- **Card Hairline** (`border`, #23262B): 1px card border, the sidebar and title-bar rules, and the divider above a hero card's stat row.
- **Control Hairline** (`border-2`, #2C3037): 1px on every chip, the logo mark, the scrollbar thumb, and the outline an icon button gains on hover. Interactive strokes use this, not `border`.
- **Cool White** (`text`, #E8E9EB): primary type and every headline figure. 14.92:1 on card.
- **Quiet Grey** (`dim`, #9AA0A6): card labels, secondary copy, inactive nav, chip text, stat-card unit suffixes. 6.86:1 on card.
- **Whisper Grey** (`faint`, #7E858C): hero sub-line, stat footers, kernel row keys, version line, chart legend, resting icon-button glyphs. 4.85:1 on card and 4.62:1 on the lightest surface (`card-2`), so it clears AA wherever it lands; it is a hierarchy step, not a legibility compromise.

### Local values (not tokens)

The three rate cards each give their badge a tinted chip: blue at 14% for download, green at 14% for upload, and a raw amber (#FBBF24) at 14% for the connection count. Amber exists only there, only as an inline value and only at that size. The chart's gridlines (#1E2126) and the download area's 10% fill are likewise local to the chart. The 18px title-bar mark carries a near-invisible dark gradient (#2B2F36 → #111316); it is the one gradient in the artifact and it is confined to that mark. When a metric is unavailable its badge drops the hue entirely for `card-2` and `faint`. The empty chart draws its own three rules in #1A1D21 at 35% opacity. The `⟳` refresh control and the `— ▢ ✕` window buttons in the fixtures are text stand-ins for SVG icons and native chrome, not an icon system. The states sheet's own page backdrop (#06070A) and its per-frame stamps are presentation scaffolding, not product surfaces.

### Named Rules

**The One Solid Blue Rule.** There is one solid blue action per screen, and it uses the fill blue, not the line blue. `accent-strong` (#2F6FE0) backs the single primary action — 启动内核 when nothing is running, 重启内核 after a crash — and always carries a white label (4.70:1). `accent` (#4A8CFF) is the line, icon, tint and active-text blue and never fills a surface. Every other blue area is the line blue at 10–28% alpha; a second solid button is a second primary.

**The Wash Ladder Rule.** Blue areas have four steps and they are not interchangeable: 10% for the chart area under the download line, 12% for the active nav row, 14% for a badge chip, 28% for text selection. The solid primary action is not a step on this ladder, and it is filled with `accent-strong` rather than this blue. A blue tint at any other alpha is off-system.

**The Green Is Health Rule.** Green marks one fact — the product is working: connected, proxy on, kernel running, this minute was healthy, this is upload. It is never a decorative accent, never a hover, never a category colour.

**The One Red Card Rule.** Failure red tints exactly one card: its 1px border at 28%, its label, the status dot and ring, and the status word. It never becomes a fill, a page tint, or a border on a card that is merely quiet.

**The Unknown Is An Em Dash Rule.** A value the product does not have is `—` in `faint`, never a fabricated 0. A value that is genuinely zero stays a number — 0.00 MB/s, 0 — and is merely coloured `faint`.

**The Three-Step Text Rule.** Type descends in three tiers, and the tier is a role rather than a contrast allowance: `text` carries figures and headlines, `dim` carries labels and secondary values, `faint` carries annotation — the hero sub-line, stat footers, kernel keys, the version line, the legend, resting icons. All three clear AA on every surface they land on (14.92 / 6.86 / 4.85 on card), so no word is being sacrificed for legibility; what the tiers protect is the reading order.

## Typography

**Display Font:** none — the system has no separate display face.
**Body Font:** Segoe UI Variable Text (with Segoe UI, system-ui, and Microsoft YaHei UI / PingFang SC for Chinese)
**Label/Mono Font:** Cascadia Mono (with Consolas, ui-monospace)

**Character:** One UI voice for every human word, from an 11px chip to a 30px node name; the scale is a continuum rather than a ladder, and contrast comes from the distance between a figure and its label, not from a heading tier. The mono face appears exactly once — the health percentage — which is the whole of its licence.

### Hierarchy

- **Display** (650, 30px, -0.02em): the current node name, alone at the top of the hero card. Nothing else in the product is this large.
- **Headline** (650, 26px, -0.02em): the page title 仪表盘. The same 26px at 650 and -0.01em carries the kernel line (mihomo · v1.19.32).
- **Figure** (650, 28px, -0.02em, tabular): the three rate readings — 0.00 with a 14px 500 `dim` unit suffix set 4px after it. Hero sub-figures step down to 600/16px (01:10:54, 2.7 MB, 规则).
- **Title** (600, 17px, -0.01em): the sidebar wordmark beside the 34px logo. A 13px/500 variant is the chart card's title.
- **Error headline** (650, 22px, -0.01em): the error card's cause line — the only headline inside a card, and the only 22px type in the system.
- **Body** (400, 13px): nav items, 已连接, and the proxy pill; a 500-weight 13px variant is the chart card's title.
- **Label** (400, 12px): card labels (当前节点, 内核状态, 下载速度), hero sub-line, health line, kernel row keys, segmented-control options, and the error card's cause paragraph at 1.6 leading on a 62ch measure.
- **Micro** (400, 11px): chips, stat footers, the three hero stat keys, badge glyphs, chart legend, version line, window-button glyphs.
- **Mono** (400, 12px, Cascadia Mono, tabular): the health percentage — `—` in `faint` while no health source exists, `success` once one does. That is the entire use.
- **Faces** are tokens, not values: `--font` (Segoe UI Variable Text → Segoe UI → system-ui → 微软雅黑 UI → PingFang SC → sans-serif) and `--num` (Cascadia Mono → Consolas → ui-monospace → monospace) in `src/renderer/styles/tokens.css`. Nothing else declares a family.

### Named Rules

**The Big Number, Small Label Rule.** A card pairs a figure at 26–30px with its label at 11–12px. No 14–24px heading sits between them; if a card needs a middle size, it needs to be two cards. The one exception is the error card's 22px cause headline, which is prose rather than a figure.

**The Tabular, Not Mono Rule.** Every figure that can change while you watch is `font-variant-numeric: tabular-nums` in the UI face. Mono is not the house numeral face — it appears only for the health percentage. Figures stay in the same voice as the labels around them; only their size and weight change.

**The Four Weights Rule.** 400, 500, 600, 650. There is no 700 and no 300. Emphasis above 600 is earned by size and by -0.02em tracking, not by more weight.

**The Title Bar Is The Only Caps Rule.** The sole uppercase, letter-spaced string in the product is the 40px title bar's wordmark (12px, .16em), because it stands in for OS chrome. Chinese labels are never uppercased, never tracked out, and never turned into eyebrow labels.

## Layout

Two rows and two columns: a 40px title bar over a `232px 1fr` shell. The sidebar holds its own vertical rhythm; the main column scrolls and is padded `20px 24px`. A header row sits above the cards — 26px title, then the connected status, then the right cluster (mode switch, proxy pill) pushed out by `margin-left:auto` with 10px between its two elements.

The card field is a three-column grid with a single 14px gap. Every card occupies one, two or three of those tracks: the current-node card spans 2, the kernel card 1, the three rate cards 1 each on the second row, and the traffic chart spans all 3. At 1280×800 the four blocks and the full 150px chart are visible without scrolling. In the failure state the first row becomes the error card (span 2) beside the kernel card, with the three rate cards and the chart unchanged beneath — the error replaces the hero rather than stacking above it. Two control heights exist: 34px for header actions (mode switch, proxy pill, primary action) and 32px for actions inside a card.

Inside a card the order is fixed: label row (12px label, optional 24px icon button on the right, 12px below), the figure block, then the footer. The hero adds a 12px sub-line, a health line, the 60-tick strip (22px tall, 2px gaps, 18px below), and a three-column stat row opened by a 1px `border` rule with 14px above it. The rate cards pin their footer to the bottom with `margin-top:auto`, which is what keeps the three footers on one baseline regardless of figure height. The kernel card runs figure → chips → three key/value rows with 16px above them and 8px between rows.

The sidebar is `18px 12px 12px`, with a 34px logo + 17px wordmark block closed by 22px of space, then nav items 38px tall with 2px between them and 11px between icon and label. It splits into two groups with space between: 仪表盘 / 节点 / 连接 on top, 设置 / 日志 pinned to the bottom above a 1px `border` rule and the 11px version line.

### Named Rules

**The Four Blocks Rule.** At the target window (1280×800) all four blocks and the whole chart are visible with no scroll. If a fifth block is added, something else leaves the first viewport — the dashboard is a glance, not a feed.

**The Fixed Rail Rule.** The sidebar is 232px and is never content-sized, never collapsible in this artifact, and never narrowed to make room for cards.

**The Thirds Rule.** A card is one, two or three of the three tracks. There is no half-column, no four-column variant, and no card that sizes to its content.

**The One Gap Rule.** 14px is the only gap in the card field — horizontally and vertically. Card padding (16/18) changes; the gap does not.

## Elevation & Depth

Flat and tonal. Cards cast nothing; they are separated from the ground by a 1px `border` and by being one tone lighter than the rail behind them. The ladder runs chrome (`sidebar`) → field (`bg`) → card (`card`) → lifted element (`card-2`), four steps inside five percentage points of lightness. Depth is legibility of nesting, not distance from the viewer.

The only glow in the system is the 3px status ring around the 7px header dot: `rgba(52,211,153,.12)` while running, `rgba(248,113,113,.12)` after a failure, and no ring at all when no kernel is running. It is a status ring, not a depth cue, and it belongs to that dot alone.

The artifact declares no `transition`, `animation` or easing anywhere; hover and active states change instantly. Motion is therefore *unspecified* rather than prohibited — the system has not yet chosen one, and this document does not invent it.

### Shadow Vocabulary

- **Status halo** (`box-shadow: 0 0 0 3px rgba(52,211,153,.12)`): the running dot in the header, and nowhere else.
- **Failure halo** (`box-shadow: 0 0 0 3px rgba(248,113,113,.12)`): the same ring in red, on the same dot, when the kernel has failed.
- **Focus ring** (`outline: 2px solid #4A8CFF; outline-offset: 2px`): global `:focus-visible`. A stroke, not a shadow, and the only focus treatment in the artifact.

### Named Rules

**The Border, Not Shadow Rule.** A card separates by one tone plus 1px of `border`. If a surface needs to lift, it steps one tone; it never gains a drop shadow.

**The Halo Is Status Rule.** The ring means the state is live, and it takes only two colours: green while running, red after a failure. The off state has no ring. One size, 3px, one dot, never decoration.

**The Quarantine Rule.** When a subsystem is down its cards drop to 50% opacity rather than disappearing, so the layout does not jump. The card that carries the cause and the recovery action never dims, and nothing a user must act on may live inside a dimmed card: at 50% the `dim` tier measures 2.66:1 and `faint` 2.15:1 on the page.

## Shapes

Rounded, quietly. Cards are 14px. Controls are 10px (segmented track, proxy pill, logo). A control's inner element is 7px — the active segment, the 24px card icon button — which is the outer 10px minus the 3px of padding that separates them. Nav items are 8px at 38px tall, and the 32px actions inside the error card reuse that 8px while the 34px header action uses the 10px control radius. Chips are 6px at 22px tall. The 18px title-bar mark is 5px. Circles exist only for dots: 7px for the status dot, 8px for the chart legend, 6px for the version dot. The 1px-radius tick bars are the squarest thing in the file besides the rules themselves.

Strokes are 1px everywhere — card borders, chips, dividers, the sidebar rule — with 2px reserved for the chart lines and the focus ring. Nothing is clipped, bevelled, or given an inner light.

### Named Rules

**The Concentric Radius Rule.** A rounded element inside a rounded element is inset by exactly the difference in radius: 10px track − 3px padding = 7px segment. If you change the outer radius, the padding and the inner radius move together or neither moves.

**The Dots Are Circles Rule.** Roundness rises with smallness: the only perfect circles are 6–8px status and legend dots. Buttons, chips and icons are rounded rectangles — the 34px proxy control and mode switch are the tallest controls in the product and both still use the 10px control radius, so no capsule-shaped button exists.

## Components

### Title bar

40px tall on `sidebar`, closed by a 1px `border` bottom rule, 18px left inset. An 18px 5px-radius mark (1px `border-2`, gradient fill), 9px, then the wordmark at 12px uppercase .16em in `dim`. Three 46px-wide system buttons fill the height at the right; their hover fill is `card-2` with `text`, and close reverts to the OS red. This band is chrome: nothing in it is a product control except the window buttons.

### Sidebar nav item

38px tall, 8px radius, `0 11px` padding, 11px between a 17px outline icon (1.6px stroke, `currentColor`) and the 13px label. Rest: `dim` on the rail, no fill. Hover: `card` fill, label to `text`. Active: `accent-bg` fill, label and icon to `accent` — and only one item is active at a time. The icon inherits the label's colour in every state, so the active row reads as one object rather than a blue word beside a grey glyph.

### Mode switch (segmented control)

34px tall: a `card` track with 1px `border`, 10px radius, 3px padding, 2px gap, holding three 26px options at 7px radius. The active option fills `card-2` with `text`; the others are transparent with `dim`. 规则 / 全局 / 直连 sit permanently in the header's right cluster next to the proxy pill — the mode is never behind a menu. With no kernel running the whole control drops to 45% opacity and shows no active segment: disabled, not hidden, so the layout never moves.

### Proxy pill

34px, 10px radius, `0 14px` padding, 8px between a 7px dot and 13px text. On: `success` text over a 10% green fill with a 35%-alpha green 1px border. It reports the system-proxy state and is the only green-filled surface in the artifact. Off: no fill, a 1px `border-2` stroke, a `faint` dot and a `dim` label — 系统代理 已关闭.

### Primary action

34px tall, 10px radius, `0 16px` padding, solid `accent-strong` (#2F6FE0) fill with a `#fff` label at 13px/500. It appears in the header where the proxy pill would be — 启动内核 when nothing is running, beside the disabled mode switch — and it is the only solid blue in the product.

White on `accent-strong` measures **4.70:1** and clears AA at 13px. The deeper step exists for exactly this job: white on the line blue would measure 3.24:1. Use the fill blue behind text and the line blue for everything else.

### Status indicator

The header's state is one 7px dot set 7px from its words at 13px. Running: green dot, a 3px `rgba(52,211,153,.12)` ring, 已连接 in `success`. Off: `faint` dot, no ring, 未连接 in `dim`. Failed: `danger` dot, a 3px `rgba(248,113,113,.12)` ring, 内核异常 in `danger`. The sidebar's version dot repeats the same three colours at 6px with no ring; it reports the same fact one level quieter.

### Cards

14px radius, `card` fill, 1px `border`, `16px 18px` padding, no shadow. The label row is 12px `dim` with an optional 24px icon button at the far right; the icon button rests with a transparent border in `faint` and on hover gains a 1px `border-2` outline and `text` colour — no fill change.

- **Current node (hero, spans 2):** 30px node name with a 22px chip at its baseline; a 12px `faint` sub-line (mode · transport · port) with the transport in `dim`; a health line (12px `dim`, percentage right-aligned in 12px mono — `—` in `faint` while no health source exists); the 60-tick strip; then the three-column stat row.
- **Kernel (1):** 26px version line, a wrapping row of three solid chips (运行中 / 端口 / 策略组), then three key/value rows at 12px — key in `faint`, value in `dim` at 500 with tabular figures, right-aligned.
- **Rate cards (1 each):** a 22px tinted badge with a direction arrow, the 12px label, the 28px figure with a 14px `dim` unit, and a footer pinned to the bottom. Each card carries one primary figure.
- **Traffic chart (spans 3):** 13px title, two solid chips for peak and average, a right-aligned legend of 8px dots and 11px `faint` labels; then a 150px chart. Download is a 2px `accent` line over a 10% wash; upload is a 2px `success` line with no fill; four 1px gridlines in #1E2126, no axes, no labels, no y-scale.

### Chips

22px tall, 6px radius, `0 8px`, 11px `dim`. Outlined: 1px `border-2`, transparent fill, 22px in the hero. Solid: `card-2` fill with no border, used for facts (运行中, 端口 5566, 最高 0.54 MB/s). A chip is a fact, never a filter. A muted solid chip (`faint` on `card-2`) reports a fact about something that is not running — 未分配端口, 退出码 1.

### Muted values

When there is no data the figure is replaced rather than hidden: the hero node name becomes a 30px `—` in `faint`, the three stat values show `—`, the kernel line reads 未启动 or 已停止 in `faint`, row values show `—` or 待启动, and each rate badge drops its tint for `card-2` and `faint`. A true zero stays a number and is merely muted — 0.00 MB/s with 累计 — means "no traffic yet", while a bare `—` means "unknown". The two are not interchangeable.

### 60-tick health strip

Sixty 1px-radius bars, `flex:1` each, 2px apart, 22px tall, aligned to the bottom. Live: green at 85% for a healthy minute, with a missed minute drawn as a 55%-height `border-2` stub at full opacity. With no kernel the whole strip becomes 40%-height `border-2` bars — same geometry, no green — so "no history" cannot be mistaken for "healthy". Height carries the miss, colour carries the health; the strip is `aria-hidden` because the sentence above it already says the count.

**Unknown, not healthy, by default.** v1 has no per-minute health source: mihomo reports a per-node delay but no failure history. Until one exists the strip renders in its dim form (40%-height `border-2`) and the health line states the absence — `最近 60 分钟 —`, plus `· 最近 480ms` when a delay is known — while the metric itself stays `—` in `faint`. A green strip is a claim, and the product may not make it without the data.

### Empty chart and idle state

The chart card keeps its title and legend. With no plot the grid is drawn at 35% opacity with a single centred line of 12px `faint`: 启动内核后显示流量 when nothing is running, 暂无流量 · 访问任意网站试试 when connected but idle. Idle adds a flat 1.2px `accent` baseline at 50% opacity along the zero line, so an idle chart reads as a measured zero rather than a missing one. The failure state inherits the dimmed empty chart and says 内核不可用 · 重启后恢复.

### Error card

The failure state's only red element, spanning two tracks where the hero sits. Same 14px card, same 16/18 padding, with a 1px border at 28% `danger` (#542F32 on card); the label reads 内核异常退出 in `danger`; then a 22px/650 cause headline, a 12px `dim` paragraph at 1.6 leading limited to 62ch that names the failure time, exit code, what was restored and the likely causes, and two 32px actions 10px apart — 重启内核 filled with `accent-strong` under a white label, 查看日志 as a 1px `border-2` outline in `text` with no fill. The kernel card sits beside it at 50% opacity.

### State coverage

Four states are drawn and only four: connected (`a-cards.html`), not started with the proxy off, connected but idle, and kernel error (`a-states.html`). Degraded, reconnecting and TUN states have no recorded treatment — they must be designed, not inferred from these four.

**Shipped in v1** (`src/renderer/components/StatePanel.tsx`) so far: `no-config`, `config-error`, `core-error` and `in-use`. One deliberate departure from the states sheet — the panel is a single neutral card, not the red error card described above. Red is reserved for a *cause that has already been named*; these four are all "nothing is running yet, here is the way forward", so they share one calm card, a 26px title, a 13px `dim` detail line, and at most one primary `accent` button. The red cause card stays specified for a kernel that dies *while the user is watching* — a later milestone, once exit codes and the failure log are wired. Copy for all four lives in `src/renderer/copy.ts` under `state`.

## Do's and Don'ts

### Do:

- **Do** pair every figure with an 11–12px label; the only mid-size type allowed on a card is the error card's 22px cause headline.
- **Do** set figures in the UI face with `tabular-nums`; reach for mono only for the health percentage.
- **Do** keep the mode switch in the header's right cluster at all times, paired with the proxy pill while a kernel runs and with the primary action when none does.
- **Do** separate surfaces with one tonal step plus 1px `border` (or `border-2` for anything interactive).
- **Do** keep #4A8CFF for lines, tints, focus, dots and active nav text, and #2F6FE0 for the one solid fill that carries white text.
- **Do** let a card span exactly 1, 2 or 3 tracks of the three-column field with a 14px gap.
- **Do** keep the first viewport at four blocks with the chart fully visible at 1280×800.
- **Do** change hover by one tone and change it instantly, as the artifact does.
- **Do** pin rate-card footers with `margin-top:auto` so the three footers sit on one baseline.
- **Do** show `—` in `faint` for a value you do not have, and a real number for a value that is zero.
- **Do** give a failure exactly one red card and drop the rest of the field to 50% opacity.
- **Do** keep the status dot at 7px and change only its colour and ring: green running, faint off, red failed.

### Don't:

- **Don't** use the fill blue as text, an icon or a border — at 3.86:1 on card it is a fill only — and never put white on the line blue (3.24:1).
- **Don't** use solid blue for anything but the single primary action; a second blue button is a second primary.
- **Don't** use `danger` as a fill, a page tint, or a border on a card that is merely quiet.
- **Don't** dim the card that carries the cause and the recovery action; dimming is for the subsystem that is unavailable.
- **Don't** invent a number to avoid a dash — an unknown value is `—`, and a muted 0.00 is still a real zero.
- **Don't** use green for anything but health, on-state and the upload series.
- **Don't** set a live figure in `faint` — the third tier is annotation; a `faint` figure is always a placeholder for data that is not there.
- **Don't** add a drop shadow, blur or backdrop to a card; the only halo is the status dot's ring — green running, red failed.
- **Don't** give a chip a selected or filter state — chips are facts.
- **Don't** centre or right-align a card's primary figure; every card in the artifact is left-aligned, with only the kernel's values and the health percentage set right.
- **Don't** uppercase or track out Chinese labels; the title-bar wordmark is the only caps in the product.
- **Don't** add a fourth card width or a responsive column squeeze — the field is three tracks, 14px apart.
