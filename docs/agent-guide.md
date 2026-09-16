# Building a Miakapp home

This guide is written for a coding agent — Claude Code, Codex, or any successor —
that has been handed someone's house and asked to make it work. You are expected
to read the existing installation, write a coordinator, write an interface, test
both, and publish. The owner is not a home-automation developer and should not
have to become one.

Everything below is true of the code in this repository. Where a rule exists for
a reason that is not obvious, the reason is given, because a rule whose purpose
you cannot see is one you will optimize away.

## 1. What you are building

Three artifacts, and no more:

| Artifact | Where it runs | What it owns |
| --- | --- | --- |
| Coordinator | the owner's machine, under Bun | state, events, functions, **authorization** |
| Component | a sandboxed Worker in the household's browser | the interface |
| `miakapp.yaml` | neither; it is the contract | what the component may ask for |

The coordinator is trusted. The component is not. The relay between them is
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

## 5. The component

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
miakapp agent-pack                                             # once, per repository
miakapp init --home <homeId> --control-plane <https url>
miakapp check
miakapp publish  --expected-generation <n>
miakapp activate --sha256 <digest> --expected-generation <n>
miakapp rollback --sha256 <digest> --expected-generation <n>   # alias of activate
miakapp release <sha256>      # read one finalized release
miakapp upload  <uploadId>    # reconcile a lost request
```

`--expected-generation` is a compare-and-swap on the home's component pointer: the
generation you believe it currently holds. It is `0` for a home that has never
published. It is required, and it is what stops two agents from silently
overwriting each other.

Rollback is `activate` pointed at a digest you already trust. Keep the digest of
every release you shipped; a rollback you can perform in one command is worth
more than an incident you can explain.

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

## 9. Secrets

`MIAKAPP_HOME_KEY` comes from the environment. It is never a command-line
argument, never printed, never written into a project file. No command accepts
one, deliberately: an argument lands in shell history, in a process listing and
in most CI logs.

```bash
export MIAKAPP_HOME_KEY="$(your-secret-manager read miakapp/home-key)"
```

If you are about to write a secret into `miakapp.yaml` so something works, stop:
that is the failure this design exists to prevent.

## 10. Before you tell the owner you are done

- [ ] Every physically consequential function authorizes its caller on its first
      line, and a test proves an unauthorized caller is refused.
- [ ] Every name in `miakapp.yaml` is covered by the coordinator, and a test
      asserts the correspondence.
- [ ] `home.state.stale` and `home.staging` are visible in the interface.
- [ ] No call path retries an unknown outcome.
- [ ] State is written before its event is published.
- [ ] `bun run check` is green, and CI ran it — not just you.
- [ ] The Home Key exists only in the environment.
- [ ] You recorded the digest of what you published, so rollback is one command.

## Where to read further

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
