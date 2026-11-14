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
| `components.css` | Recipes on top of the tokens: glass, device tile, scene, switch, level slider, stale banner, tab bar |
| `fonts.css` | Manrope as a `data:` URL, ready for the frame, which has no network (OFL, see `OFL-Manrope.txt`) |
| `gallery.html` | Example screens built only with the files above: home, room, energy, wall tablet. Open it in a browser, switch themes, read its source |

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

## Principles

1. **The home first, not the devices.** Organize by room and by moment of the
   day (evening, leaving, bedtime). Use the words residents use; never show a
   state path or a device identifier.
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

Miakapp draws its own bar outside your frame: the home, the resident's other
homes, their account and sign-in methods. Do not draw a global navigation that
duplicates it (home switcher, profile, sign out). In-app navigation between
your own screens (rooms, energy…) is yours; `gallery.html` shows where a
home's own one or two entries would sit next to Miakapp's.

## In the frame

- No network: no web fonts, CDN stylesheets or remote images. Inline them as
  `data:`/`blob:` URLs, like `fonts.css` does. The bundle limit is 2 MiB;
  Manrope costs about 33 KB.
- Respect `prefers-reduced-motion`; the tokens zero their durations for it.
- `corner-shape: squircle` gives continuous corners where the browser supports
  it; elsewhere the plain radius applies.
- The bundle is public to signed-in users who know its digest: the gallery's
  names are examples, real names come from state.
