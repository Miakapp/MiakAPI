# MiakAPI

MiakAPI is the typed Node.js SDK for running a trusted Miakapp coordinator. A
coordinator owns complete state, access, event, and function declarations for one
integration and exchanges canonical MessagePack frames with the Miakapp relay.

Version 4 is a complete replacement for the legacy callback-based MiakAPI 3
client. It is currently an alpha while the Miakapp 3.5 relay is being deployed.

## Requirements

- Node.js 22.9 or newer
- A Miakapp Home Key or another approved short-lived access-token provider
- A Miakapp relay implementing wire protocol 1.0

MiakAPI is server-side software. Do not ship coordinator credentials, Home Keys,
or access-token providers to a browser or an untrusted plugin runtime.

## Installation

```sh
npm install miakapi@next
```

Alpha releases use the `next` npm tag. The package is ESM-only.

## Quick start

```ts
import {
  ApplicationCallError,
  EventDirection,
  createCoordinator,
  createHomeKeyAccessTokenProvider,
} from 'miakapi';

const homeKey = process.env.MIAKAPP_HOME_KEY;
if (homeKey === undefined) throw new Error('MIAKAPP_HOME_KEY is required');

const coordinator = createCoordinator({
  name: 'home-assistant',
  accessTokenProvider: createHomeKeyAccessTokenProvider({
    exchangeEndpoint: 'https://control.miakapp.com/v1/access-tokens:exchange',
    homeKey,
  }),
});

coordinator.configure({
  state: {
    'climate.living_room.temperature': 20,
  },
  stateAccess: [{
    userId: 'user-id',
    patterns: ['climate.living_room.*'],
  }],
  events: [{
    topic: 'climate.living_room.changed',
    directions:
      EventDirection.acceptFromUsers |
      EventDirection.publishToUsers,
  }],
  eventAccess: [{
    userId: 'user-id',
    publish: ['climate.living_room.changed'],
    subscribe: ['climate.living_room.changed'],
  }],
  functions: {
    async 'climate.living_room.set_target'(call) {
      if (typeof call.arguments !== 'number') {
        throw new ApplicationCallError(2001, 'Target must be a number');
      }
      await call.emit({ phase: 'applying' });
      return { accepted: true, target: call.arguments };
    },
  },
});

coordinator.subscribe(({ current, reason }) => {
  console.log('Miakapp coordinator status:', current, reason?.kind);
});

const session = await coordinator.start();
console.log('Ready in generation', session.generation);
```

The Home Key provider makes exactly one exchange request for each initial,
reauthentication, or reconnect demand from the SDK. It sends the Home Key only
to the configured HTTPS control-plane endpoint, rejects redirects and open or
overlong responses, and returns only the relay URL, compact access token, and
expiry to the coordinator core. It performs no independent retry; the
coordinator's single bounded reconnect schedule remains authoritative.

Keep the Home Key in the trusted coordinator backend. Do not place it in a web
bundle, browser storage, logs, URLs, or relay configuration. Applications with a
different approved credential store may continue to implement
`AccessTokenProvider` directly.

`configure` supplies all five declaration slices as one desired snapshot. The
coordinator becomes `ready` only after the relay acknowledges them in order. A
later declaration call replaces its complete slice and temporarily returns the
coordinator to `synchronizing` until atomic activation.

## State, events, and calls

State mutations are atomic and use acknowledged string paths:

```ts
await coordinator.state.set([
  { path: 'climate.living_room.temperature', value: 21.5 },
]);
```

Event publication returns a synchronous opaque ID and a transport-handoff
promise. `sent` is not a delivery receipt; a later correlated relay rejection is
reported through `coordinator.errors`.

```ts
const event = coordinator.events.publish(
  'climate.living_room.changed',
  { temperature: 21.5 },
);
await event.sent;

coordinator.errors.subscribe((failure) => {
  if (failure.correlation?.localId === event.localId) {
    console.error('The relay rejected the event:', failure.kind);
  }
});
```

Outgoing calls expose acceptance, pull-bounded progress, and one terminal
result:

```ts
const call = coordinator.calls.start({
  function: 'lighting.scene.activate',
  arguments: { scene: 'evening' },
  timeoutMs: 10_000,
  idempotencyKey: 'intent-018f',
});

await call.accepted;
for await (const progress of call.stream) console.log(progress);
const result = await call.result;
```

MiakAPI never retries state mutations, events, or calls. An idempotency key is
passed to the callee but does not enable hidden retries.

## Failure outcomes

Every `CoordinatorFailure` includes an `outcome`:

- `not_dispatched`: local validation, offline gating, or an explicit relay
  terminal proves the operation did not dispatch.
- `sent`: an event frame reached the active transport; delivery is not implied.
- `accepted`: a call was accepted before its terminal failure.
- `applied`: a state mutation was acknowledged by the relay.
- `outcome_unknown`: transport loss, deadline, or post-accept cancellation means
  an external effect may already have happened.

Treat `outcome_unknown` as uncertainty, never as rollback. MiakAPI does not turn
an uncertain physical effect into a safe automatic retry.

## Lifecycle and cleanup

`start()` may be called once. `stop()` is idempotent and repeated calls return the
same terminal promise. It aborts token and handler work, settles pending
operations conservatively, removes listeners, and closes the owned socket.

```ts
await coordinator.stop({ deadlineMs: 5_000 });
```

`deadlineMs` bounds cleanup even when an injected dependency ignores its abort
signal.

## Migration from MiakAPI 3

MiakAPI 4 removes the legacy `Miakapi(home, id, secret)` constructor, Firestore
lookup, mutable `home.variables`, UI callbacks, and notification helpers. Those
APIs depended on the retired Miakapp 3 transport and are not emulated.

Integrations now:

1. obtain short-lived access material through an `AccessTokenProvider`;
2. declare complete state, ACL, event, and function slices;
3. wait for `start()` readiness before issuing effects;
4. handle uncertainty explicitly through typed failures.

For UI automation and agent-driven homes, use [miakapp.com](https://miakapp.com/)
instead of building against the retired page-callback protocol.

## Protocol and conformance

The public TypeScript API and wire codec are pinned to the Miakapp-V3 coordinator
contract at an immutable commit in [`contracts/miakapp-v3.json`](contracts/miakapp-v3.json).
The external conformance subject runs the real SDK against a deterministic relay
and must pass every scenario in the `sdk` profile.

```sh
bun install --frozen-lockfile
bun run check
```

The check includes strict type checking, unit and adversarial tests, a Node.js
package smoke test, canonical external conformance, and an npm package dry run.

## License

[ISC](LICENSE)
