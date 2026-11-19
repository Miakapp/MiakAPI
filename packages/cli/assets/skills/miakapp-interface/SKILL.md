---
name: miakapp-interface
description: Build or change a Miakapp home app (the whole-house interface in app/) — starter, design system and themes, navigation, the window.miakapp bridge, state, calls, stale and staging states, bar buttons, share/copy. Use for any screen, layout, style or control change.
---

# The app

One classic-script IIFE (≤ 2 MiB, no `import()`, no source map) that owns its
whole document, in an isolated frame with no network, storage or popups,
below the Miakapp bar. Start from the starter, in the home repository:

```bash
miakapp init --starter app    # miakapp.yaml, app/main.ts, app/miakapp.ts, app/theme.ts…
bun run build && bun run check
```

`app/miakapp.ts` is the bridge, copied from the CLI: never edit it
(`miakapp update` refreshes it).

```ts
import { connect } from './miakapp.js';
const home = connect();
home.subscribe((state) => render(state));
await home.call('lighting.set', { on: true });
```

## Make it beautiful the first time

Read `miakapp docs design` before drawing anything and follow it: tokens, four
themes, recipes, line icons, example screens. Group by room or use, never by
device. States use its four colours, always with a word. Navigate with the
starter's `createNav()` (history + swipe back).

## Rules that bite

- **Never invent data.** No source → shown as absent. Every value is current,
  stale (with its age) or unavailable, in residents' words.
- **No plumbing on screen**: no protocol words, IDs, "connected" banners, no
  read-only banner, no home name on every card.
- **`home.state.stale`**: dim values (`.is-stale` on `.mk-app`) and disable
  controls. No banner of your own: the Miakapp bar already says it.
- **`home.staging`**: disable controls and say why.
- **An unknown outcome is never retried**: show it, let the next snapshot
  settle it.
- **The bundle is public** to any signed-in user: no names, rooms or accounts
  in it; everything comes from state.
- Declare every path and function in `app.requires`; events and media are
  refused.

## Platform helpers

- `home.bar.setButtons([{ id, label, icon, badge? }])` + `onSelect`: up to two
  of your screens in the Miakapp bar. Never draw your own bottom bar.
- `home.share({ title, text, url })` / `home.copy(text)` from the tap handler;
  handle `'shared' | 'copied' | 'cancelled' | 'unavailable'`.
- `home.link.params` / `home.link.hash`: what the home's link carried
  (e.g. `?invite=`).

Then check it on the real home: skill `miakapp-test-real`.
