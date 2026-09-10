# MiakAPI

MiakAPI is the typed SDK for running a trusted Bun/TypeScript coordinator and
connecting a first-party browser application to a Miakapp home. A coordinator
owns complete state, access, event, and function declarations for one
integration. The isolated browser entry point exposes the authenticated user role
without bundling server-runtime or coordinator-only dependencies.

Version 4 is a complete replacement for the legacy callback-based MiakAPI 3
client. It is currently an alpha while the Miakapp 4 stack is being completed.

## Coordinator requirements

- Bun 1.2.23 or newer (primary coordinator runtime)
- Node.js 22.9 or newer when running compatibility or migration tooling
- A Miakapp Home Key or another approved short-lived access-token provider
- A Miakapp relay implementing wire protocol 1.0

The default `miakapi` entry point is server-side software. Do not ship
coordinator credentials, Home Keys, or coordinator access-token providers to a
browser or an untrusted plugin runtime.

## Installation

```sh
bun add miakapi@next
```

Alpha releases use the `next` npm tag. The package is ESM-only and remains
Node-compatible so runtime-specific migration adapters can reuse the same SDK.

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

A complete minimal Bun coordinator matching the Miakapp V4 staging browser is
available in [`examples/synthetic-coordinator.ts`](examples/synthetic-coordinator.ts).
It publishes a small home state and implements one real `lighting.toggle` call.
Run it only in a trusted backend process:

```sh
bun run examples/synthetic-coordinator.ts
```

The process reads `MIAKAPP_HOME_KEY`,
`MIAKAPP_CONTROL_PLANE_EXCHANGE_ENDPOINT`, and `MIAKAPP_OWNER_USER_ID` from its
runtime environment. The Home Key is the only secret; the endpoint and Firebase
user ID are identifiers. Never pass any of them as command-line arguments.

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

## Trusted browser client

Use the isolated `miakapi/browser` entry point in the first-party Miakapp web
application. It relies on the browser's native WebSocket implementation and does
not expose coordinator declarations, Home Keys, or the Node.js `ws` transport.

```ts
import {
  createBrowserClient,
  createControlPlaneBrowserRelayCredentialProvider,
} from 'miakapi/browser';

const credentialProvider = createControlPlaneBrowserRelayCredentialProvider({
  exchangeEndpoint: 'https://control.example.com/v1/user-relay-tokens:exchange',
  async getFirebaseIdToken({ signal }) {
    if (signal.aborted) throw signal.reason;
    const user = firebaseAuth.currentUser;
    if (user === null) throw new Error('The user is signed out');
    return user.getIdToken();
  },
  async getAppCheckToken({ signal }) {
    if (signal.aborted) throw signal.reason;
    return (await getToken(firebaseAppCheck)).token;
  },
});

const client = createBrowserClient({
  homeId: 'my-home',
  credentialProvider,
});

await client.start();

const removeStateListener = client.state.subscribe((snapshot) => {
  if (!snapshot.stale) renderHome(snapshot.values);
});

const removeHomeListener = client.home.subscribe((home) => {
  renderAvailability(home.enrolled, home.coordinators, home.stale);
});

const call = client.calls.start({
  function: 'lighting.scene.activate',
  arguments: { scene: 'evening' },
  timeoutMs: 10_000,
  idempotencyKey: 'intent-018f',
});
await call.accepted;
const result = await call.result;

removeStateListener();
removeHomeListener();
await client.stop();
```

This replaces the earlier alpha browser options `relayUrl` and
`idTokenProvider`. They are intentionally rejected: callers must not pair an
independently selected relay with a source or access token.

The credential provider is invoked for the initial connection, reauthentication,
and reconnects. Its Firebase ID and App Check callbacks run only inside the
trusted host and send those source tokens solely to the HTTPS control plane.
MiakAPI never places them in a relay URL, WebSocket subprotocol, persistent
browser storage, log, error, `HELLO`, or `REAUTH` frame.

The control plane returns an up-to-five-minute Miakapp access token atomically
with its authoritative relay URL. MiakAPI sends only that audience-bound token
to the returned relay. If a renewal selects a different relay, the client marks
the old session stale and closes it. Before any automatic replacement connection,
including recovery from a transport or protocol failure, the client waits for the
native transport close event. If closure is not confirmed within ten seconds, the
client stops fail-closed instead of opening overlapping relay sockets. A routing
handoff uses the already-issued credential; it does not expose the new token to
the old relay or repeat the exchange. Stop and discard the client immediately
when the Firebase user signs out or the selected home changes. Relay routing
changes arrive through credentials and do not require mutating the client options.

Audience binding limits credential replay; it does not encrypt home traffic from
the selected relay. Users should still choose an operator they trust with the
plaintext state and calls that transit through it.

Browser state snapshots are defensive copies and become `stale` immediately
when continuity is lost. Revision or dictionary mismatches trigger one
fail-closed resynchronization request. Browser calls target the home's default
coordinator by function name, have no progress stream, and are never replayed by
the SDK. Incoming calls are rejected with an application error because this
first user profile deliberately exposes no browser call handlers. An
`outcome_unknown` failure means an effect may already have happened.

Token acquisition, protocol welcome, bootstrap, and reauthentication each have
bounded deadlines. The browser transport also caps individual frames, its
outbound queue, and rolling inbound bytes and frame counts. A native WebSocket
still materializes a complete message before JavaScript can reject it, so these
limits are defense in depth rather than isolation from a malicious relay; a
Worker boundary remains an option for a later hardened browser profile.

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

The check includes strict type checking, unit and adversarial tests, Node.js and
browser-bundle smoke tests, canonical external conformance, and an npm package
dry run.

## License

[ISC](LICENSE)
