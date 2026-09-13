# @miakapp/component

The guest SDK for a Miakapp home component.

Your component runs inside a sandboxed Worker on a separate origin. Before your
first statement executes, the trusted prelude has already removed `fetch`,
WebSocket, `importScripts`, nested Workers, IndexedDB, Cache Storage, Beacon,
WebRTC and the rest. There is no DOM and no network. Everything the component
can see or do arrives through one message bridge, and everything it shows is a
semantic tree the host renders with its own trusted components.

This package is that bridge, typed.

```ts
import { defineComponent, ui } from '@miakapp/component';

defineComponent((home) => ({
  render: () => ui.screen({ title: 'Salon' }, [
    ui.toggle({
      id: 'lamp',
      label: 'Lampe du salon',
      value: home.state.get('zone.salon.light.on') === true,
      onChange: (on) => void home.call('lighting.set', { on }),
    }),
  ]),
}));
```

## Building the artifact

The runtime loads **one self-contained classic Worker program**: no module
syntax, no dynamic `import`, no source map. Bundle to an IIFE and let the CLI
check it before you publish.

```bash
bun build src/component.ts --format=iife --minify --outfile dist/component.js
bunx @miakapp/cli check
```

`miakapp check` verifies those artifact rules offline, so a mistake costs a
second rather than an upload capability.

## The `Home` object

`setup` runs once, after `guest.boot` and the first authoritative state
snapshot. It receives the home and returns a component.

| Member | Purpose |
| --- | --- |
| `home.state` | The granted state projection. `get`, `has`, `paths`, `entries`. |
| `home.state.stale` | True after a patch gap. **Read it.** See below. |
| `home.events.subscribe(name, fn)` | Subscribe to a granted topic; returns an unsubscribe. |
| `home.events.publish(name, data)` | Publish one at-most-once event. |
| `home.call(name, args, opts?)` | One granted RFC 0001 call. Resolves with the result. |
| `home.stream(name, args, opts?)` | The same, as an `AsyncIterable` with automatic credit. |
| `home.log(level, message)` | Bounded local development diagnostic. Not telemetry. |
| `home.invalidate()` | Request one coalesced re-render. |
| `home.grant` | The effective capability grant, for feature detection. |
| `home.staging` | True while the release is staged: renders work, actions do not. |

State, events and interactions all re-render automatically. `invalidate()` is
for the rest — a timer, a resolved call, your own component state.

## Three things that will bite you otherwise

**Stale state is not current state.** A patch gap sets `home.state.stale` and
the values keep their last known contents. RFC 0002 requires the SDK to expose
that rather than pretend, so show it — a `status` node with state `stale` is one
line:

```ts
ui.status({ id: 'sync', label: 'Synchronisation', state: home.state.stale ? 'stale' : 'applied' })
```

**An unknown outcome is not a failure.** `home.call` can reject with
`CallOutcomeUnknownError`, which means the home may already have applied the
call. Retrying could act twice. Wait for the next snapshot instead.

```ts
try {
  await home.call('lighting.set', { on: true });
} catch (error) {
  if (error instanceof CallOutcomeUnknownError) {
    // Do not retry. The next state snapshot is the authority.
  }
}
```

**A staged release may render but not act.** During staging the broker answers
`event.publish` and `call.start` by terminating the instance, not by returning
an error. This SDK refuses those calls locally with a message that names the
state, so check `home.staging` and render a disabled control rather than trying.

## The semantic tree

`ui` builds the twelve ABI 1 node types: `screen`, `stack`, `grid`, `section`,
`text`, `status`, `button`, `toggle`, `input`, `select`, `progress` and `media`.
Tokens are closed enums in the type system, so an invalid `tone` or `gap` is a
compile error rather than a terminated instance.

Every render commits a complete tree. That is intentional in ABI 1: it makes
validation and atomic rendering auditable. Commits are coalesced and spaced to
the thirty-per-second ABI rate for you, so `invalidate()` in a loop is safe.

There is no URL property anywhere. Images and camera surfaces are named by exact
granted handles:

```ts
ui.media({ id: 'door', label: 'Caméra d’entrée', handle: 'media.front_door' })
```

Handlers may be callbacks or handler IDs. A callback is registered for the
render that created it, so an interaction against an older tree is ignored
rather than misrouted.

## Limits worth knowing

1,024 UI nodes, depth 32, 8,192 UTF-8 bytes per text, 262,144 aggregate, 100
select options, 32 outstanding calls, 30 renders per second, 120 guest messages
per second. `LIMITS` exports the full set. The four whose violation is fatal —
node count, depth, text size and duplicate IDs — are checked locally before the
tree is sent, so you get a thrown error instead of a dead component.

## Status

Alpha, tracking Miakapp 4. The shapes here mirror
`component-runtime/src/runtime-broker.ts` exactly; that broker is the authority,
and any disagreement between the two is a bug in this package.
