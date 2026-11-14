# Designing a Miakapp home

Miakapp gives you a starting point, not a framework: design tokens, four
themes, a handful of CSS recipes and example screens. Take what helps, change
anything, or make the home's own look with its residents. Nothing here is
required by `miakapp check` or by the frame.

## What ships with this CLI

The files sit next to this guide, in the design directory printed at the end:

| File | What it is |
|---|---|
| `tokens.css` | `--mk-*` variables (color, glass, radius, type, space, motion) for four themes |
| `components.css` | Recipes on top of the tokens: glass, entry tile, state header, action button, device tile, scene, switch, level slider, stale banner |
| `fonts.css` | Manrope as a `data:` URL, ready for the frame, which has no network (OFL, see `OFL-Manrope.txt`) |
| `gallery.html` | Example screens built only with the files above: home, a device page, a room, energy, wall tablet. Open it in a browser, switch themes, read its source |

`miakapp init --starter app` writes all three stylesheets into `app/theme.ts`
(`THEME_CSS`) and already uses them, so the first build looks like Miakapp.

## Themes

Set `data-theme` on `<html>` (or on any element, to theme one part):

| Theme | Use |
|---|---|
| `minuit` | Night blue and gold from the Miakapp logo. Dark mode, wall tablets after dark. The house favourite. |
| `lumiere` | Day. White glass over peach, mint and lilac. Light mode and the default. |
| `miel` | Warm honey. Cosy, evening homes. |
| `craie` | Flat, no blur, high contrast. Old or slow tablets, low vision. |

Follow the resident: `home.theme()` is `light`, `dark` or `system`, and
`home.onThemeChange()` tells you when it changes. The starter maps dark to
Minuit and light to Lumière; a wall tablet may stay on Minuit.

A home's own theme is one more `[data-theme="…"]` block redefining the same
variables. Keep text contrast at 4.5:1 or more, including secondary text on
glass; check dark themes twice (dark blue on darker blue is easy to miss).

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
   state comes first and big (`.mk-state`: "Gate closed"), then the actions as
   large buttons (`.mk-action`: Open, Pedestrian, Close), then, separately and
   lower, the rare ones (adjust the recorded state, calibration). A value is
   not a button and a button is not a value.
5. **Actions that make no sense are disabled.** "Close" is greyed while the
   gate is closed. While a command runs, its button shows `is-pending` until
   the next state confirms it.
6. **Upkeep stays off the main path.** A dead battery, a sensor silent for
   months, a device that never answered: send a notification or put it in an
   "Upkeep" page. Never next to the living-room temperature, and never as a
   value of the room it belongs to.
7. **Hierarchy, not repetition.** On each page one thing stands out (the
   state, a big number); everything else is smaller and calmer. Use colour for
   meaning (on, open, alert), not to decorate. If every block has the same size
   and colour, the page has no hierarchy.
8. **Phone first.** Design at 360 px wide with the thumb at the bottom; then
   check a wall tablet and a desktop. Do not line up six cards because the
   desktop is wide.
9. **Each resident gets their own home screen.** A guest allowed only the
   gate sees one tile, or lands straight on the gate page.

An entry tile may carry one small signal when something needs attention
(`.mk-entry.has-attention`, e.g. the gate is open): never a full value.

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
