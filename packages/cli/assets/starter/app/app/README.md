# This home's interface

Written by `miakapp init --starter app`. It is a Miakapp **whole-house
application** (`miakapp.app/1`): your own document, styles and navigation,
bundled into one classic-script file that Miakapp runs in an isolated frame for
the home's residents.

```
miakapp.yaml       home, control plane, artifact, and what the app may read and call
package.json       build, typecheck and check scripts
tsconfig.json      strict TypeScript for app/
app/main.ts        the interface — edit this
app/miakapp.ts     the bridge to the home (window.miakapp), copied from this CLI release
app/README.md      this file
```

Nothing here depends on an unpublished package or on the MiakAPI source
repository.

## Prerequisites

- **Node.js ≥ 22.9** to run the `miakapp` CLI.
- **Bun ≥ 1.2.23** to bundle `app/main.ts` (`bun build … --format=iife`). Any
  bundler that emits one classic-script IIFE with no `import()` works too.
- TypeScript only for `bun run typecheck` (`bun install` fetches it).

## The loop

```bash
bun install            # the pinned @miakapp/cli and TypeScript, for the scripts below
bun run build          # app/main.ts → the artifact named in miakapp.yaml
bun run check          # build, then `miakapp check` validates it offline
npx miakapp publish    # only once the interface is real (see below)
npx miakapp status     # verify the digest you built is the one live
```

`npx miakapp` runs the CLI that `bun install` pinned in this project; a global
`miakapp` works the same way.

`publish` prints `home_url`: the address residents open. Open it as a member
would and check it before handing it to anyone. The printed `artifact_url` is
the raw bundle, never a link to give.

## Before the first publication

As generated, the app shows every value the home shares with it — grouped by
the first segment of its path — and an honest empty state while nothing is
shared. `app.requires` in `miakapp.yaml` starts empty, so the first build
shows only that empty state. It invents no value and offers no control. That
is a starting point, not a deliverable:

1. **Inventory the house first** (`miakapp docs start`, §3): every source, what
   each value means, how fresh it is, who may see it, which actions exist.
2. **Declare what the app needs** under `app.requires.state_read` (exact paths
   or `prefix.*`) and `app.requires.call`. The coordinator still decides per
   resident; a path it does not share never reaches the app.
3. **Make it a home, not a path list.** Fill `LABELS` with resident-facing
   names, then replace the generic layout with one organized by room or use.
   No technical vocabulary on screen.
4. **Add controls only for actions the owner authorized.** Disable them while
   `state.stale` is true. A call that fails with `outcome_unknown` may have
   acted: never retry it, wait for the next state.

## Rules the frame enforces

- No network, no cookies or storage, no popups. Bundle images and fonts as
  `data:`/`blob:` URLs. At most 2 MiB, no `import()`, no source map.
- The bundle is public to signed-in users who know its digest: put no household
  data in it. Read everything from state.
- Never present stale values as current; never show a reading the home did not
  send.
- Do not edit `app/miakapp.ts`. It is the canonical bridge source shipped with
  the CLI that generated it, so a newer CLI starter carries any change.
