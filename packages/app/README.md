# @miakapp/app

Typed SDK for a Miakapp **whole-house application** (`miakapp.app/1`).

A house application is your home's own interface: any DOM, CSS, router or UI
library, bundled as **one classic-script IIFE** and published with
`miakapp publish`. Residents open it at the `home_url` the CLI prints. Miakapp
runs it in an isolated frame — no network, no storage, no access to the
resident's account or other homes — behind a consent screen and a permanent
Miakapp bar. Its only window on the home is `window.miakapp`; this package
types it.

```ts
import { callErrorCode, connect } from '@miakapp/app';

const home = connect();

home.subscribe((state) => {
  document.body.dataset.stale = String(state.stale);
  for (const path of home.paths('room')) {
    // render home.get(path) however you like
  }
});

async function setLight(on: boolean): Promise<void> {
  try {
    await home.call('lighting.set', { on });
  } catch (error) {
    // 'outcome_unknown' means the home may have acted: never retry, wait for state.
    console.warn(callErrorCode(error));
  }
}
```

## Rules the shell enforces

- Declare every state path (exact or `prefix.*`) and every call in
  `miakapp.yaml` under `app.requires.state_read` and `app.requires.call`.
  Events, media and `miakapp.*` functions are refused.
- The coordinator still decides per resident: a path a resident may not see
  never reaches the frame, and a call they may not make is refused.
- Bundle everything (≤ 2 MiB): images and fonts as `data:`/`blob:`. No
  `import()`, no source maps, no external URLs.
- The artifact is public to signed-in users who know its digest. Put no
  household data in it; read it from state.
- Show `state.stale`; never present old values as current.

Build with Bun: `bun build app/main.ts --format=iife --minify --outfile dist/app.js`.
