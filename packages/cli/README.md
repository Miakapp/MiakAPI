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
| `agent-pack` | Offline. Installs the guide and the MCP wiring into a repository. |
| `discover` | Offline. Inventories a Node-RED installation from its flows export. |
| `check` | Offline. Parses the project, verifies the artifact, prints the digest. |
| `publish` | Capability → delivery → finalization → activation, in one run. |
| `activate` | Activates an already finalized digest at a new generation. |
| `rollback` | Alias of `activate`, for returning to a known-good digest. |
| `release <sha256>` | Reads one finalized release record. |
| `upload <uploadId>` | Reads one upload status, to reconcile a lost request. |
| `mcp` | Serves every command above over MCP on stdio. |

`check` is the command to run in CI and before every publication. It costs
nothing, touches no network and catches the four artifact rules the broker's
pinned parser would reject anyway: module syntax, dynamic `import`, a source-map
directive and the ABI 1 token ceiling.

`discover` is the command to run *before* `init`, on a house that already exists:

```
miakapp discover --flows ~/node-red/flows.json --json
```

It needs no project file and no Home Key. It reads the bytes it was given —
opening no socket, contacting no broker, writing nothing back — and reports the
flows, the MQTT brokers with the topics their nodes actually reach, the v3
MiakAPI surface as V4 state and function candidates, and every node type it does
not model, so the reader knows what the inventory missed. It reports that a
coordinator secret is present in the export; it never prints the secret itself.
`docs/agent-guide.md` §3 explains what to do with each finding.

## The agent pack

`agent-pack` is the command to run *once* in a home repository, so that the next
agent to open it arrives already knowing the rules:

```
miakapp agent-pack            # or --dir /path/to/the/repository
```

It writes four files and reports what it did to each one:

| File | Why |
| --- | --- |
| `.miakapp/agent-guide.md` | The full guide, copied out of this package. No network, no stale bookmark. |
| `AGENTS.md` | The instruction file Codex reads. |
| `CLAUDE.md` | The instruction file Claude Code reads. |
| `.mcp.json` | Project-scope MCP configuration, registering `miakapp mcp`. |

The repository is yours, so the pack edits rather than replaces. The guide is a
file it owns outright. The instruction files are touched only between
`<!-- miakapp:begin -->` and `<!-- miakapp:end -->`: prose above and below the
markers is copied through byte for byte, and a second run rewrites the block in
place instead of appending another copy. `.mcp.json` is merged as a structure —
one key, by name — so every other server in it survives, and a file that does
not parse is refused rather than replaced with a valid one.

The server is registered as the bare `miakapp` command rather than an absolute
path, because the file is committed and the next machine to check it out will
not have this one's directory layout.

Run it again whenever the CLI is upgraded: an unchanged file is reported
`unchanged`, and a guide that moved on is reported `updated`.

## MCP

An agent that already runs a shell does not need this. An agent that speaks the
Model Context Protocol natively does: `miakapp mcp` serves the same commands as
tools over newline-delimited JSON-RPC on stdio.

```json
{
  "mcpServers": {
    "miakapp": {
      "command": "bunx",
      "args": ["@miakapp/cli", "mcp"],
      "env": { "MIAKAPP_HOME_KEY": "${MIAKAPP_HOME_KEY}" }
    }
  }
}
```

| Tool | Command | |
| --- | --- | --- |
| `miakapp_discover` | `discover` | read-only, offline |
| `miakapp_check` | `check` | read-only, offline |
| `miakapp_release` | `release` | read-only |
| `miakapp_upload` | `upload` | read-only |
| `miakapp_init` | `init` | writes `miakapp.yaml`, never overwrites |
| `miakapp_agent_pack` | `agent-pack` | offline, writes the pack into a repository |
| `miakapp_publish` | `publish` | **moves the pointer — needs `confirm: true`** |
| `miakapp_activate` | `activate` | **moves the pointer — needs `confirm: true`** |
| `miakapp_rollback` | `rollback` | **moves the pointer — needs `confirm: true`** |

The server is a translation layer: a tool call becomes the exact argv a person
would have typed and runs the same dispatch, so a tool and a command line cannot
drift apart. A tool argument is the option name with `_` for `-`
(`expected_generation` → `--expected-generation`); an argument the tool does not
declare is refused rather than ignored.

The three pointer-moving tools additionally require `confirm: true`. It is
checked before anything else and never reaches the command line, so a model that
hallucinated a publication spends the mistake on an argument check instead of on
a generation.

A command that fails comes back as a tool result carrying `isError: true` and
the same closed object the CLI prints — `kind`, `exit_code`, `message` and a
remedy — not as a JSON-RPC error. That distinction matters: a protocol error
means the call never happened, while a publication that reached the control
plane and failed did happen, and only `kind` says whether to reconcile.

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
