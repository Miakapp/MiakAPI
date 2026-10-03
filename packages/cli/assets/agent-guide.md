# Building a Miakapp home

This guide is written for a coding agent — Claude Code, Codex, or any successor —
that has been handed someone's house and asked to make it work. You are expected
to read the existing installation, write a coordinator, write an interface, test
both, and publish. The owner is not a home-automation developer and should not
have to become one.

Everything below is true of the code in this repository. Where a rule exists for
a reason that is not obvious, the reason is given, because a rule whose purpose
you cannot see is one you will optimize away.

## 0. What "done" means

The owner asked for a home they can use, not for a picture of one. You are done
when the household can open the published interface, read real values from it
and use every control the owner authorized — and you checked that yourself.
Concretely:

- **Publish, then verify.** A build that only runs on your machine, a mockup, a
  prototype kept offline or a screenshot is an intermediate result, never the
  deliverable. Do not stop to show one and ask whether to continue: the owner
  asked for the home, and publication is reversible in one command (§8).
- **Hand over a link that works.** Give the owner the `home_url` that
  `miakapp publish` and `miakapp status` print — the Miakapp address where the
  home opens for its members — and say what you verified there. The
  `artifact_url` (JSON `url`) is the raw bundle, not an interface: never send it
  as "the link". If the control plane advertises no `home_url`, say so instead of
  inventing one, and say what `miakapp status` proved.
- **Ask once, at the start, and only for what you cannot find.** Access comes
  from pairing (§9), the existing installation from inventory (§3). Repeated
  permission questions in the middle of the work are a failure of the work.
- **You need nothing from the platform's source.** This guide, the CLI, the
  public packages and `templates/home` are the whole toolchain. Never edit or
  redeploy the Miakapp platform to make one house work; if a capability is
  missing, report it to the owner as missing instead of patching around it.

Two scopes must not be confused:

| In scope by default | Needs the owner's explicit, separate request |
| --- | --- |
| reading the existing installation (§3) | changing flows, automations, brokers or devices that already run the house |
| writing and testing a coordinator and a component | granting a physical action (heat, lock, unlock, open, close) that the owner has not named |
| publishing, verifying and rolling back the V4 interface | anything on the owner's own machines beyond the coordinator you were asked to run |

Caution about the second column is not a reason to withhold the first. A new V4
interface that only reads is still a useful, publishable V1; say plainly which
controls are not offered and why.

## 1. What you are building

Three artifacts, and no more:

| Artifact | Where it runs | What it owns |
| --- | --- | --- |
| Coordinator | the owner's machine, under Bun | state, events, functions, **authorization** |
| Interface | an isolated frame (app) or sandboxed Worker (component) in the household's browser | what residents see and touch |
| `miakapp.yaml` | neither; it is the contract | what the interface may ask for |

The interface is, by default, a **whole-house application** (`app:` in
`miakapp.yaml`, ABI `miakapp.app/1`): your own layout, styles, navigation and
libraries, bundled into one file. A semantic **component** (`component:`,
`miakapp.component/1`) is still supported for a minimal tree Miakapp draws for
you. §5 covers both.

The coordinator is trusted. The interface is not. The relay between them is
platform-untrusted but not blind: it terminates TLS, stores plaintext state and
enforces routing, so self-hosting it does not give end-to-end confidentiality.
Do not tell the owner otherwise.

Start from `templates/home`. It is a complete working home — one lamp, one
temperature — with the three files already in the right relationship, and its
own `README.md` covering the mechanics of copying it out. This guide covers the
judgment the template cannot.

### Leave the repository readable by the next agent

You are probably not the last agent to open this repository, and the next one
will not have this conversation. Run the pack once, in the repository root:

```bash
miakapp agent-pack
```

It copies this guide to `.miakapp/agent-guide.md`, points `AGENTS.md` and
`CLAUDE.md` at it, and registers `miakapp mcp` in `.mcp.json` so the tools are
wired rather than described. It edits instead of replacing: prose outside the
`<!-- miakapp:begin -->` markers is kept, other MCP servers are kept by name,
and running it twice changes nothing.

If you are reading this file *as* `.miakapp/agent-guide.md`, someone already
ran it. Run it again after upgrading the CLI, and commit what changes — a guide
that contradicts the CLI installed beside it is worse than no guide.

## 2. The division of responsibility

**The coordinator authorizes everything.** The relay proves *who* is calling and
attaches non-spoofable caller metadata. Deciding whether that person *may* act is
the coordinator's job and nobody else's. In the template that decision is the
first line of the function body:

```ts
if (call.source.kind !== 'user' || call.source.id !== options.ownerUserId) {
  throw new ApplicationCallError(2003, 'Only the owner may drive the lights');
}
```

Removing that check does not produce an error anywhere. It produces a home that
anyone enrolled can drive. There is no second layer that will catch it for you.

**The component trusts nothing it was not given.** It has no network, no storage
and no DOM. It cannot reach the lamp except through a call the coordinator
declared, and it cannot read a state path the coordinator did not grant. This is
why it is safe to let a component be rewritten often and reviewed lightly, and
why it is not safe to move a decision into it.

**You own the UI; the coordinator owns the facts.** The coordinator exposes state
and actions. What the household actually sees — the layout, the wording, the
language, which controls are prominent — is yours to design from the semantic
vocabulary in §5. Do not push presentation choices into the coordinator, and do
not push authorization into the component.

## 3. Before you write anything: characterize the house

You are almost never starting from an empty building. Read what is already there
before you design anything:

- existing hubs and brokers — Node-RED, MQTT, Zigbee/Z-Wave coordinators, an
  HTTP-speaking hub;
- what each device actually reports, and how often;
- which values are *measurements* (temperature, power) and which are
  *commanded* (a lamp, a valve) — they have different failure modes;
- which actions are physically consequential: anything that heats, locks,
  unlocks, opens or closes.

Write down what you found before you write the configuration. The state paths you
choose become a disclosure boundary and a public interface at the same time, and
renaming one after the household has used it is not free.

### The inventory comes before the design

Commit the inventory as `docs/inventory.md` in the home repository, one line per
datum or action, before you design a single screen:

| Field | Example |
| --- | --- |
| source | `zigbee2mqtt/salon_thermo` over the house broker |
| what it is | temperature, °C, one decimal |
| how fresh | reports every ~60 s; last seen 2 min ago |
| who may read it | every member / owner only |
| command | none — a measurement, not a control |

Then design **from** it: the V1 shows every datum the household would care
about and every action that is both technically possible and authorized,
grouped the way people live in the house — by room or by use, not by device
or protocol. Anything you leave out, leave out on purpose, and say why in the
inventory. A V1 that shows three values when the house reports twenty is not a
first version; it is an unfinished one.

What the interface must never do:

- **invent data.** A value with no source is shown as absent, never filled in
  with a plausible number or a demo fixture;
- **blur freshness.** Distinguish *current*, *stale* (with its age) and
  *unavailable* for every value, in words a resident understands;
- **spend space on plumbing.** No protocol or platform vocabulary
  (`ACCEPTED`, "relay connected", ABI, schema names, IDs), no banner restating
  that a view is read-only, no title repeating the home's name on every card.
  Every line of text is either information or an action.

### Reading a V3 house you inherited

Most houses arriving at V4 already run Node-RED with the v3 MiakAPI nodes. Ask
the owner for the `flows.json` Node-RED writes, or for an *Export > All flows*
download, and read it before you read anything else:

```
miakapp discover --flows ~/node-red/flows.json
miakapp discover --flows ~/node-red/flows.json --json
```

The command is offline and read-only: it opens no socket, contacts no broker and
never writes back into the export. It reports the tabs, the MQTT brokers with the
topics their nodes actually reach, the `initMiakapi` home bindings, every
`commitVariables` path as a state candidate, every `onUserAction` id as a
function candidate with the groups allowed to invoke it, and every node type it
does not model — so you know what the inventory missed rather than assuming it
missed nothing.

Four of its findings decide work you would otherwise discover late:

- **`secret_in_export`.** The v3 `initMiakapi` node declares `coordSecret` in its
  `defaults`, not in its `credentials`, so Node-RED stores that secret in
  cleartext in `flows.json` rather than in the encrypted `flows_cred.json`. If
  the export has one, treat it as leaked: rotate it, and keep the file out of
  Git. §9 is the V4 rule that replaces it.
- **`unrestricted_action`.** The v3 handler allows an action outright when its
  node lists no group, so an empty `allowedGroups` is a grant to every signed-in
  user, not a deny. Each one needs a deliberate V4 rule before you port it.
- **`name_needs_rename`.** A v3 variable path or action id that is not a legal V4
  dotted name has to be renamed now, while nobody depends on it.
- **`wildcard_subscription`.** A topic holding `#` or `+` is a subscription
  pattern, not one device. Enumerate what it actually matches.

The command deliberately does not tell you which actions are physically
consequential. It lists every action it found; deciding which of them heats,
locks, unlocks, opens or closes is a judgement you make with the owner, and no
keyword list should make it for you.

## 4. The coordinator

`templates/home/coordinator/home.ts` is the shape to copy: the configuration is a
**pure function of its options**, so it can be tested without a relay, a control
plane or a network. `coordinator/main.ts` is the only file that touches the
outside world. Keep that split. It is what makes `test/home.test.ts` possible,
and the authorization rules are exactly the thing you want under test.

Four declarations:

```ts
{
  state:        { 'zone.living_room.light.on': false },   // paths and initial values
  stateAccess:  [{ userId, patterns: ['zone.living_room.*'] }],
  events:       [{ topic, directions: EventDirection.publishToUsers }],
  eventAccess:  [{ userId, publish: [], subscribe: [topic] }],
  functions:    { async 'lighting.set'(call) { /* authorize, act, return */ } },
}
```

`stateAccess[].patterns` is the disclosure boundary. A user sees exactly those
paths and nothing else. Widen it deliberately, one path at a time, and never with
a wildcard that happens to be convenient.

Three ordering and failure rules that are easy to get wrong:

**State first, event second.** Write the state, *then* publish the event:

```ts
await coordinator.state.set([{ path: STATE.lightOn, value: on }]);
await coordinator.events.publish(EVENT_LIGHT_CHANGED, { on });
```

A subscriber that reacts to the event and immediately reads the state must never
see the old value. The reverse order is a race that will reproduce once a month
and waste a day.

**Reject bad arguments with a typed application error.** `ApplicationCallError`
carries a numeric code the component can branch on. Do not throw a bare `Error`
for a caller mistake; the distinction between "you asked wrongly" and "something
broke" is the one the interface needs most.

**A home has several coordinators.** Names are namespace sharding by convention.
The relay keeps ownership tables for topics, state paths and functions, detects
collisions and rejects with `4409`. If you claim `lighting.set` for the whole
house, you have taken a name another integration may need; scope what you own.

## 5. The interface

### A whole-house application (default)

`miakapp init` writes an `app:` section; `templates/home/app/` is a working
example. You own the document: build any DOM, ship your own CSS, route with
`location.hash`, use React, Svelte, Vue, charts or WebAssembly — anything a
bundler can inline. The deliverable is **one classic-script IIFE** of at most
2 MiB, with no `import()` and no source map:

```bash
bun build app/main.ts --format=iife --minify --outfile dist/app.js
```

Miakapp runs it in an isolated, opaque-origin frame below a permanent Miakapp
bar, after the resident agreed to open the home. The frame has no network, no
cookies or storage, no popups and no fullscreen; assets go in the bundle as
`data:`/`blob:` URLs. Its only way to the home is `@miakapp/app`:

```ts
import { callErrorCode, connect } from '@miakapp/app';

const home = connect();
home.subscribe((state) => render(state));        // also called once immediately
await home.call('lighting.set', { on: true });   // rejects with a closed code
```

Declare every state path (exact or `prefix.*`) under `app.requires.state_read`
and every function under `app.requires.call`. Events, media and `miakapp.*`
functions are refused by `miakapp check`. Show `state.stale`, disable controls
while it is true, and handle `outcome_unknown` exactly as below.

**The bundle is not private.** Any signed-in user who learns its digest can
fetch it. Put no household data in it — no names, rooms, devices or accounts —
and read everything from state, which the coordinator filters per resident.

### A semantic component (compatible)

Import from `@miakapp/component`. The whole public surface is one module, and the
whole rendering vocabulary is `ui.*`:

```
screen  stack  grid  section          layout
text  status  progress  media         output
button  toggle  input  select         interaction
```

You return one complete semantic tree per render; the trusted host draws it with
its own components. You do not ship CSS, you do not ship a DOM, and you cannot
style your way around the host. This is a constraint worth accepting rather than
fighting: it is what lets the host stay accessible, themed and localized without
auditing your code.

Handlers are functions, not identifiers to wire up by hand:

```ts
ui.toggle({
  id: 'living-room-light',
  label: 'Living-room lamp',
  value: asBoolean(home.state.get(LIGHT_ON)),
  disabled: home.staging || !healthy,
  pending,
  onChange: (next) => void setLight(next),
})
```

Handlers are registered for the render that created them, so a stale tree cannot
fire an action against new state.

The limits are real and enforced: 1 024 nodes, depth 32, 30 renders per second,
32 outstanding calls, 8 KiB per text node. If you are approaching any of them you
are building a dashboard the household will not read.

### Two states the interface must never hide

**Staleness.** `home.state.stale` means the snapshot may no longer reflect the
house. Show it. Per RFC 0002 §12.2 it is exposed, never hidden — a thermostat
reading that is silently forty minutes old is worse than one labelled uncertain.

**Staging.** `home.staging` is true while a release is staged: rendering works,
calls and events do not. Disable the controls and say why, as the template does.
An interface that looks live and silently does nothing is the worst outcome
available.

### An unknown outcome is never retried

This is the rule that will most tempt you to break it, so it is stated plainly:

```ts
try {
  await home.call('lighting.set', { on }, { deadlineMs: 10_000 });
} catch (error) {
  // Deliberately not retried. The call may already have reached the lamp,
  // and the next state snapshot settles the question.
  failure = error instanceof Error ? error.message : 'The command failed';
}
```

A failed call is not a call that did not happen. `CallOutcomeUnknownError` exists
precisely to name the case where the effect is undetermined, and the physical
world does not have a rollback. Surface it, let the next state snapshot settle
it, and let the person decide. The same principle has a CLI counterpart: exit
code 7.

## 6. The intersection rule

Every name a component may touch appears in **two** places, and the effective
grant is the intersection:

| `miakapp.yaml` → `requires` | `coordinator/home.ts` |
| --- | --- |
| `state_read` | `stateAccess[].patterns` |
| `event_subscribe` | `eventAccess[].subscribe` |
| `event_publish` | `eventAccess[].publish` |
| `call` | `functions` |

Asking for more than the coordinator grants **does not fail loudly at
publication**. The component simply never receives that path, and the interface
renders a hole — an empty card, a control that does nothing, a temperature that
is permanently unavailable. This is the single most common way a Miakapp home
breaks, and it breaks quietly.

So: assert the correspondence in a test. `templates/home/test/home.test.ts` does
exactly this, and it is the reason a mismatch fails in CI rather than in
someone's living room. When you add a path, change four things in one commit —
the state declaration, the access pattern, the `requires` entry, and the test.

## 7. The loop

```bash
bun run check     # typecheck → bundle → test → validate the artifact offline
```

Run it before every publication and in CI. It costs nothing and catches the
artifact rules the runtime would reject anyway.

Do not treat a check that exists as a check that runs. On 2026-09-14 this
repository had a template and a component example that were both verified
locally and built by nobody, because the workflow called `bun run check` and not
`check:packages`; when CI finally exercised them they failed three times in a
row on defects that had been sitting there invisibly. If you add a package, add
it to the job that runs in CI, then watch one run go green before believing it.

Reproduce CI with the toolchain version it pins, not the one you have. Bun 1.4
self-references the root package and resolves `bunx` from `node_modules`; the
pinned 1.2.23 does neither, so a green local run proves nothing about the runner.
Install the pinned version alongside yours:

```bash
BUN_INSTALL=/tmp/bun1223 curl -fsSL https://bun.sh/install | bash -s bun-v1.2.23
```

Note also that `bun test foo/` is a **substring filter**, not a directory scope.

## 8. Publishing

The CLI builds, validates, publishes and rolls back. **It never owns Git.** It
writes no history, rewrites no source it did not generate, and invents no
control-plane endpoint. The repository is the owner's.

```bash
miakapp docs start                             # this guide, from the installed CLI
miakapp pair                                   # once per home and machine (§9)
miakapp agent-pack                             # once, per repository
miakapp init                                   # app: by default; --kind component for a semantic tree
miakapp check
miakapp status                                 # what is live now: generation, release, digest
miakapp publish                                # upload, finalize, activate
miakapp status                                 # verify the new digest is what is live
miakapp activate --sha256 <digest>             # promote an already finalized digest
miakapp rollback --sha256 <digest>             # alias of activate
miakapp release <sha256>      # read one finalized release
miakapp upload  <uploadId>    # reconcile a lost request
```

Activation is a compare-and-set on the home's component pointer. Without
`--expected-generation` the CLI reads the live generation first and activates
the next one; the read takes no lock, so another publication landing in between
still fails with `conflict` instead of being overwritten. Pass
`--expected-generation <n>` when you want to assert the state you reviewed.

Rollback is `activate` pointed at a digest you already trust. Keep the digest of
every release you shipped; a rollback you can perform in one command is worth
more than an incident you can explain.

`miakapp status` after `publish` is the minimum verification: the live `sha256`
must be the one you just built. It proves what the home runs, not that the
interface is right — open its `home_url` as a member would before telling the
owner it works.

### Driving the CLI as a program

Every failure maps to exactly one stable exit code and one stable
machine-readable kind. New kinds may be added; existing codes never change
meaning. Pass `--json` and you get exactly one closed object on stdout.

| Code | Kind | Meaning |
| --- | --- | --- |
| 0 | `success` | |
| 1 | `usage` | the invocation was wrong |
| 2 | `project` | `miakapp.yaml` is missing or invalid |
| 3 | `artifact` | the built bytes violate an artifact rule |
| 4 | `authorization` | the Home Key is missing, wrong or unscoped |
| 5 | `contract` | the control plane rejected the request |
| 6 | `conflict` | `--expected-generation` did not match; re-read, do not retry |
| 7 | `unknown_outcome` | **effect undetermined — reconcile with a read** |

Branch on the code, not on the prose. On 7, call `miakapp upload <uploadId>` or
`miakapp release <sha256>` and reconcile before acting again. Never retry a 7
with a fresh capability.

### If you speak MCP instead of shell

`miakapp mcp` serves the same commands as tools over JSON-RPC on stdio. It is the
same code: a tool call becomes the argv a person would have typed and runs the
same dispatch, so everything above still holds — the same defaults, the same
validation, the same `kind` on every failure.

Three differences are worth knowing before you call anything:

- `miakapp_publish`, `miakapp_activate` and `miakapp_rollback` refuse to run
  without `confirm: true`. Set it when the owner asked for that publication, and
  not to get past an error;
- a failure arrives as a tool result with `isError: true`, carrying the same
  closed object, not as a JSON-RPC error. A JSON-RPC error means your call never
  happened; `isError` means it ran and failed, and `kind` says what to do next;
- a tool argument is the option name with `_` instead of `-`. An argument the
  tool does not declare is refused, never ignored.

`packages/cli/README.md` lists the tools. The exit codes above are the
`exit_code` field in every result, so branch on the same table either way.

## 9. Access: pairing and contexts

You never sign in as the owner and never ask for a password, a Google login or
an existing key. The owner grants access to one home, in their own browser:

1. Ask the owner to open **https://miakapp.com/pair**, sign in to their own
   account, choose the home (or create it), confirm the access it grants, and
   send you the one-time code it shows. A code works once, for ten minutes.
2. Redeem it. The code is read from stdin and never echoed:

   ```bash
   printf '%s\n' "<code>" | miakapp pair            # add --issuer <url> if the page shows one
   ```

   Over MCP, call `miakapp_pair` with `code`. Never repeat the code back in a
   message, and never retry a refused code — ask for a new one.
3. `pair` stores a **new, separately revocable** Home Key for this machine as a
   context in `~/.miakapp`, keeps every other context, makes the new one
   current, and proves the key can publish. It prints the key ID and label,
   never the key.

```bash
miakapp context list          # every home this machine can publish to
miakapp context show [name]   # one context; the key is never printed
miakapp context use <name>    # make a context current
miakapp context remove <name> # delete it locally (the owner revokes it server-side)
```

`~/.miakapp/config.json` holds names, homes, issuers and key IDs;
`credentials.json` holds the keys. Both are mode 0600 in a 0700 directory and
are replaced atomically; the CLI refuses a credentials file other accounts can
read. `MIAKAPP_CONFIG_DIR` relocates the directory.

Which key a command uses, highest precedence first:

1. `--context <name>`, then `MIAKAPP_CONTEXT=<name>`;
2. `MIAKAPP_HOME_KEY`, a raw key for CI and compatibility;
3. the stored context paired with the home and issuer in `miakapp.yaml` — the
   current context breaks a tie between two keys for that same home.

A context, or a known key, for a different home than `miakapp.yaml` names is
refused before any request: a key can never publish into the wrong house.

Prefer one key per agent or machine, so the owner can revoke one without
breaking the others. A coordinator running on the owner's machine still reads
its own key from its environment (`templates/home/README.md`).

If you are about to write a secret into `miakapp.yaml` or any file in the
repository so something works, stop: that is the failure this design exists to
prevent.

## 10. Before you tell the owner you are done

- [ ] `docs/inventory.md` lists every source, datum and action you found, and
      the interface covers it or says why not.
- [ ] Every value shows whether it is current, stale or unavailable; nothing is
      invented, and no technical vocabulary is on screen.
- [ ] The interface is published, `miakapp status` shows your digest live, and
      you opened it as a member would — or you say precisely what you could not
      check.
- [ ] The owner received a working link and the rollback digest, not a
      screenshot or a mockup.
- [ ] Every physically consequential function authorizes its caller on its first
      line, and a test proves an unauthorized caller is refused.
- [ ] Every name in `miakapp.yaml` is covered by the coordinator, and a test
      asserts the correspondence.
- [ ] `home.state.stale` and `home.staging` are visible in the interface.
- [ ] No call path retries an unknown outcome.
- [ ] State is written before its event is published.
- [ ] `bun run check` is green, and CI ran it — not just you.
- [ ] The Home Key exists only in `~/.miakapp` or the environment, never in the
      repository.
- [ ] You recorded the digest of what you published, so rollback is one command.

## Where to read further

Everything a home needs is above, in the CLI and in the template. The RFCs and
platform paths below explain *why* the platform behaves as it does; you never
need them, or the platform repository, to build and publish a home.

- `packages/cli/README.md` — every command and every tool, including what the
  pack writes and what it refuses to overwrite.
- `templates/home/README.md` — the mechanics of the template itself.
- `docs/rfcs/0001` (Miakapp-V3) — wire protocol: ownership, collisions, `4409`.
- `docs/rfcs/0002` — component runtime and the staleness rule. **The broker is
  the authority for the guest ABI, not the RFC**: `component-runtime/src/runtime-broker.ts`
  and `contract.ts` define the exact payloads, and the broker terminates the
  instance rather than answering when a field is wrong.
- `docs/rfcs/0003` — the coordinator SDK surface.
- `docs/rfcs/0004` — Home Key bootstrap, scopes, publication.
- `docs/rfcs/0005` — the trusted browser client.
