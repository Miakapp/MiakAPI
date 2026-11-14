# Designing a Miakapp home

Miakapp gives you a starting point, not a framework: design tokens, four
themes, a handful of CSS recipes, line icons and example screens. Take what helps, change
anything, or make the home's own look with its residents. Nothing here is
required by `miakapp check` or by the frame.

## What ships with this CLI

The files sit next to this guide, in the design directory printed at the end:

| File | What it is |
|---|---|
| `tokens.css` | `--mk-*` variables (color, glass, radius, type, space, motion, a hue per place) for four themes |
| `components.css` | Recipes on top of the tokens: screen, headline, entry tiles, orb, state header, held and primary actions, device tile, scene, switch, level slider, stale banner |
| `icons.svg` | Line icons (gate, door, garage, sofa, bed, light, shutter, lock, unlock…), 24 × 24, as an SVG sprite |
| `fonts.css` | Manrope as a `data:` URL, ready for the frame, which has no network (OFL, see `OFL-Manrope.txt`) |
| `gallery.html` | Example screens built only with the files above: home, a device page, a room, energy, wall tablet. Open it in a browser, switch themes, read its source |

`miakapp init --starter app` writes all three stylesheets into `app/theme.ts`
(`THEME_CSS`), with the icons (`ICONS`, `icon('gate')` as `<svg>` markup) and
`holdToConfirm()`, and already uses them, so the first build looks like
Miakapp.

## Themes

Set `data-theme` on `<html>` (or on any element, to theme one part):

| Theme | Use |
|---|---|
| `minuit` | A living night: blue and violet aurora, a golden glow, gold accents from the Miakapp logo. The house favourite and the starter's default. |
| `lumiere` | Day. White glass over peach, mint and lilac. For residents who prefer light. |
| `miel` | Warm honey. Cosy, evening homes. |
| `craie` | Flat, no blur, high contrast. Old or slow tablets, low vision. |

Follow the resident: `home.theme()` is `light`, `dark` or `system`, and
`home.onThemeChange()` tells you when it changes. The starter uses Minuit and
switches to Lumière only for a light preference; a wall tablet may stay on
Minuit.

A home's own theme is one more `[data-theme="…"]` block redefining the same
variables. Keep text contrast at 4.5:1 or more, including secondary text on
glass; check dark themes twice (dark blue on darker blue is easy to miss).

## Make it beautiful

A home app must look as good as www.miakapp.com. What makes the difference is
not more decoration but these six things; the gallery's first three phones
show all of them.

1. **A living background.** Put `.mk-app` on `<body>`: it paints the theme's
   halos (`--mk-bg-art`). Never replace them with a flat colour: glass only
   shines with light behind it.
2. **A headline, not a title.** An eyebrow (`.mk-eyebrow`: the date) and a
   two-line `.mk-headline` that says how the home is, with one word in the
   accent gradient: "Good evening. All `<em>closed</em>`." When something needs
   attention it says so: "Gate `<em class="is-alert">open</em>`."
3. **One featured tile, then varied sizes.** The tile people reach for most
   (the gate, the front door) is `.mk-entry.is-featured`: first, wide, gold,
   with its state in big type. The others vary: `.is-tall` for a tile about
   one big number (`.big`: 71°), regular tiles, `.is-wide` to close the grid.
   Six identical squares look like a spreadsheet.
4. **The screen is full.** `.mk-screen` fills the phone down to the Miakapp
   bar and `.mk-entries` stretches its rows to fill it. Never leave the bottom
   two thirds empty; with few tiles, make them bigger.
5. **A hue per place, gold for the star.** Give each tile a discreet hue
   (`.mk-tint-lilac`, `-sky`, `-peach`, `-rose`, `-mint`, `-honey`): it tints
   the icon and a glow in the corner, so tiles are told apart at a glance.
   One hue per tile; keep gold for the featured tile and for what is on.
6. **Line icons, never emoji.** Emoji bring their own colours and styles and
   clash with every palette. Use the shipped icons: `icon('gate')` in the
   starter, or the `icons.svg` sprite. Labels are bold (`.name`, 800), left
   aligned, with at most a discreet `.hint` under them.

```html
<body class="mk-app">
  <main class="mk-screen">
    <div><div class="mk-eyebrow">Friday, November 14</div>
      <h1 class="mk-headline">Good evening.<br>All <em>closed</em>.</h1></div>
    <div class="mk-entries">
      <button class="mk-entry is-featured">
        <span class="mk-icon"><!-- icon('gate') --></span>
        <span class="grow"><span class="hint">Gate</span><span class="now">Closed</span></span>
      </button>
      <button class="mk-entry is-tall mk-tint-peach">
        <span class="mk-icon"><!-- icon('sofa') --></span>
        <span><span class="big">21°</span><span class="name">Living room</span></span>
      </button>
      <button class="mk-entry mk-tint-lilac">
        <span class="mk-icon"><!-- icon('door') --></span>
        <span><span class="name">Front door</span><span class="hint">Locked</span></span>
      </button>
      <!-- … -->
    </div>
  </main>
</body>
```

A tile with a shortcut cannot be a `<button>` holding another button: make it
`<div class="mk-entry is-featured has-attention" role="group">` with a
stretched `<button class="mk-open">` and a `<button class="mk-shortcut">`.

A device page is the same idea, vertical: `.mk-topbar` (round `.mk-back` and
the name), the device big in `.mk-orb` (its halo turns warm with `.is-open`),
the state in huge type (`.mk-state .now`, a live dot with `.since.is-live`),
then the actions at the bottom, under the thumb (`.mk-actions` pushes them
down), then the rare ones (`.mk-rare`).

## How a home app works

A home app is a remote control, not a dashboard: people open it, do one thing
and close it. Lay it out that way.

1. **The home screen opens, it does not show.** Four to eight large entry tiles
   (`.mk-entry`): the places and devices people actually reach for, the most
   used first (in most houses, the gate or the front door). It fits on one
   phone screen: no scrolling. At most one line above the tiles, and only when
   something needs attention ("The gate is open", "Alarm on").
2. **One page per tile, about one thing.** Never put unrelated information on
   the same page: the living-room temperature has nothing to do with the
   garage door.
3. **Group by room or by type of device, never both.** "Bedrooms" or
   "Shutters" are both fine entries; a "Rooms" section next to a "Temperatures"
   section that repeats the same rooms is not.
4. **Open, see, do: never mixed.** A tile opens a page. On that page, the
   state comes first and big (`.mk-state`: "Closed"), then the actions as
   large buttons (`.mk-action`: Open, Pedestrian, Close), then, separately and
   lower, the rare ones (adjust the recorded state, calibration). A value is
   not a button and a button is not a value.
5. **Opening must never happen by accident; closing must never be
   forgotten.** For anything that opens, unlocks or starts (gate, garage door,
   lock, alarm off), the risky actions sit together on the first row and are
   held to confirm (`.mk-action.is-hold` with `holdToConfirm()`: a gauge fills
   for 0.6 s, letting go cancels). The safe action (Close, Lock) sits alone on
   the row below and takes one tap. While the thing is open, Close becomes
   `.is-primary` (gold, full width), the home tile turns warm
   (`.has-attention`) and may carry a one-tap `.mk-shortcut` to close it.
   Never offer the risky direction from the home screen.
6. **Buttons never move.** Open or closed, every button keeps its place; only
   its emphasis changes (disabled, primary). Actions that make no sense are
   disabled: "Close" is greyed while the gate is closed. While a command runs,
   its button shows `is-pending` until the next state confirms it.
7. **Upkeep stays off the main path.** A dead battery, a sensor silent for
   months, a device that never answered: send a notification or put it in an
   "Upkeep" page. Never next to the living-room temperature, and never as a
   value of the room it belongs to.
8. **Hierarchy, not repetition.** On each page one thing stands out (the
   state, a big number); everything else is smaller and calmer. Colour carries
   meaning (on, open, alert) or identity (one discreet hue per place), never
   decoration. If every block has the same size
   and colour, the page has no hierarchy.
9. **Phone first.** Design at 360 px wide with the thumb at the bottom; then
   check a wall tablet and a desktop. Do not line up six cards because the
   desktop is wide.
10. **Each resident gets their own home screen.** A guest allowed only the
   gate sees one tile, or lands straight on the gate page.

An entry tile may tell, discreetly, the state of the one thing it opens
(`.mk-entry .hint`: "Closed" under "Gate"), so residents know without
opening it. Keep it to a word or two in small, calm text, only for tiles about
a single device, and add the attention dot (`.mk-entry.has-attention`) when
that state needs looking at (the gate is open). Never a full value, a number
list or a reading of several sensors.

## Principles

1. **The home first, not the devices.** Organize by room or by type of
   device (never both), plus scenes for moments of the day (evening, leaving,
   bedtime). Use the words residents use; never show a state path or a device
   identifier.
2. **What is on glows.** One strong signal per screen: the golden `--mk-on`
   glow of a light, plug or scene that is on. Everything else stays calm.
3. **One gradient per screen.** `--mk-accent-gradient` is a signature for one
   title or one key number, not for every heading.
4. **Say when the home goes quiet.** A stale value is dimmed (`is-stale`), a
   banner says since when, controls are disabled. A command in flight shows
   `is-pending` until the next state confirms it; an `outcome_unknown` call is
   never retried.
5. **Big fingers, little text.** 44 px targets at least, tabular digits, three
   text sizes per screen. Phones, tablets on a wall and desktops all open the
   same app: test at 360 px wide and at 1280 px.
6. **Glass, but only two levels.** A glass panel may hold tiles; tiles do not
   hold more glass. `craie` drops the blur entirely for weak devices.

## The Miakapp bar is not yours

Miakapp draws its own bar at the bottom, outside your frame: the home, the
resident's other homes, their account and sign-in methods. Do not draw a
global navigation that duplicates it (bottom tab bar, home switcher, profile,
sign out). The bar floats over the bottom of your frame: keep **96 px of
padding at the bottom** of your page and put no fixed control there (the
starter does).

A home may add **one or two buttons of its own** to that bar (rooms, energy…).
Miakapp draws them; you name them and react to taps:

```ts
home.bar.setButtons([
  { id: 'rooms', label: 'Pièces', icon: 'grid', active: true },
  { id: 'energy', label: 'Énergie', icon: 'bolt' },
]);
home.bar.onSelect((id) => show(id ?? 'home')); // null: the home tab
```

At most two, labels of 16 characters at most, icons from `BAR_ICONS`
(`grid`, `bolt`, `light`, `thermometer`, `camera`, `lock`, `list`, `chart`,
`leaf`, `star`). Set them on every start, from the resident or the home's
state if you like; Miakapp shows the last list straight away on the next visit.
When you change screen yourself, call `setButtons` again with `active` on the
screen shown.

## In the frame

- No network: no web fonts, CDN stylesheets or remote images. Inline them as
  `data:`/`blob:` URLs, like `fonts.css` does. The bundle limit is 2 MiB;
  Manrope costs about 33 KB.
- Respect `prefers-reduced-motion`; the tokens zero their durations for it.
- `corner-shape: squircle` gives continuous corners where the browser supports
  it; elsewhere the plain radius applies.
- The bundle is public to signed-in users who know its digest: the gallery's
  names are examples, real names come from state.
