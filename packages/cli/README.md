# @miakapp/cli

Build, validate, publish and roll back one Miakapp home component.

The CLI is the deployment mechanism, not the source of truth. **Git belongs to
you**: this tool never commits, never rewrites sources it did not generate and
never bundles for you. It reads a project file, verifies the artifact bytes you
built, and talks to the control plane over the closed RFC 0004 §13.2 surface.

It is written for a coding agent first and a person second. Every outcome is one
stable exit code and one stable failure kind, and `--json` prints exactly one
object on stdout.

```bash
bunx @miakapp/cli init --home my-home --control-plane https://control.miakapp.app
bunx @miakapp/cli check
bunx @miakapp/cli publish --expected-generation 0
```

## The project file

`miakapp.yaml` sits at the root of your repository:

```yaml
schema: miakapp.project/1
home: my-home
control_plane: https://control.miakapp.app

component:
  artifact: dist/component.js
  release: 2026-09-13.1
  requires:
    state_read:
      - climate.living_room.temperature
    event_subscribe: []
    event_publish: []
    call:
      - lighting.set
    presentation: []

coordinator:
  entry: coordinator/main.ts
```

`requires` is the closed RFC 0002 capability object. Lists are de-duplicated and
sorted before they are bound into an upload capability, so the value the CLI
sends is byte-identical on every later reconciliation read.

The parser is a deliberately small YAML subset: block mappings, block sequences
of scalars, two-space indentation, comments, quoted and plain scalars, and `[]`
for an empty list. Anything else — tabs, anchors, tags, multi-line scalars,
duplicate keys — is rejected with the offending line rather than guessed at.

## Commands

| Command | What it does |
| --- | --- |
| `init` | Writes `miakapp.yaml`. Never overwrites an existing one. |
| `check` | Offline. Parses the project, verifies the artifact, prints the digest. |
| `publish` | Capability → delivery → finalization → activation, in one run. |
| `activate` | Activates an already finalized digest at a new generation. |
| `rollback` | Alias of `activate`, for returning to a known-good digest. |
| `release <sha256>` | Reads one finalized release record. |
| `upload <uploadId>` | Reads one upload status, to reconcile a lost request. |

`check` is the command to run in CI and before every publication. It costs
nothing, touches no network and catches the four artifact rules the broker's
pinned parser would reject anyway: module syntax, dynamic `import`, a source-map
directive and the ABI 1 token ceiling.

## Authorization

The Home Key is read from `MIAKAPP_HOME_KEY` and from nowhere else. No command
accepts it as an argument, because an argument lands in shell history, in a
process listing and in most CI logs.

```bash
export MIAKAPP_HOME_KEY="$(op read op://home/miakapp/home-key)"   # or your own vault
bunx @miakapp/cli publish --expected-generation 4
```

The key is exchanged for a five-minute `components:publish` token before every
run. Publication endpoints never accept the Home Key itself, and the CLI never
prints either credential.

## Generations

Activation is a compare-and-set: `--expected-generation` is the generation you
believe the pointer holds, and `--generation` (default: expected + 1) is the one
you are publishing. A stale expectation fails with `generation_conflict` and
exit code 6 rather than last-write-wins.

`--expected-generation` is required rather than discovered, because RFC 0004
§13.2 publishes no read for the current pointer: the pointer lives in
`components/{homeID}` and reaches clients as authenticated platform data. Until
that surface exists, the CLI asks you for the number instead of guessing one —
inventing an endpoint would be worse than an explicit flag.

## Exit codes

| Code | Kind | Meaning |
| --- | --- | --- |
| 0 | — | success |
| 1 | `usage` | the invocation is malformed |
| 2 | `project` | `miakapp.yaml` is missing or invalid |
| 3 | `artifact` | the artifact is missing, malformed or not publishable |
| 4 | `authorization` | no Home Key, or the control plane refused it |
| 5 | `contract` | the control plane answered outside its own schema |
| 6 | `conflict` | the generation precondition failed |
| 7 | `unknown_outcome` | the effect on the control plane is undetermined |

Code 7 is the one that matters. It means a mutating request may already have
committed, so the next step is a read — `miakapp upload <id>` or
`miakapp release <sha256>` — and never a blind retry with a fresh capability.

## Failure output

```console
$ miakapp publish --expected-generation 0
miakapp: conflict: Activation failed with HTTP 409 generation_conflict (request Zq1...)
  Another publication advanced the pointer. Read the active generation and retry
  the activation with the observed expected_generation.
```

```console
$ miakapp publish --expected-generation 0 --json
{"ok":false,"kind":"conflict","exit_code":6,"message":"...","remedy":"..."}
```

## Status

Alpha, tracking Miakapp 4. The package is `private` until the control plane it
talks to is deployed; publishing it to npm is a deliberate, separate step.
