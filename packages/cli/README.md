# @miakapp/cli

Pair, build, validate, publish and roll back independent Miakapp house applications.

The CLI is the deployment mechanism, not the source of truth. **Git belongs to
you**: this tool never commits, never rewrites sources it did not generate and
never bundles for you. It reads a project file, verifies the artifact bytes you
built, and talks to the control plane over the closed RFC 0004 §13.2 surface.

It is written for a coding agent first and a person second. Every outcome is one
stable exit code and one stable failure kind, and `--json` prints exactly one
object on stdout.

```bash
printf '%s\n' "$CODE" | bunx @miakapp/cli pair --issuer "$MIAKAPP_ISSUER"
bunx @miakapp/cli init                            # home and issuer from the paired context
bunx @miakapp/cli check
bunx @miakapp/cli publish
bunx @miakapp/cli status                          # verify what is live
```

Use the exact issuer command shown by your deployment's `/pair` page; do not
guess a staging issuer. `init` writes the project manifest, not an application:
build your house UI as one classic-script IIFE (the `@miakapp/app` SDK is
optional), then run `check` and `publish`. Open and verify the returned
`home_url` as a resident before handing it over.

## The project file

`miakapp.yaml` sits at the root of your repository:

```yaml
schema: miakapp.project/1
home: my-home
control_plane: https://control.example.test

app:
  artifact: dist/app.js
  release: 2026-10-03.1
  requires:
    state_read:
      - climate.living_room.temperature
    call:
      - lighting.set

coordinator:
  entry: coordinator/main.ts
```

`app` declares only `state_read` and `call`; events, media and reserved
`miakapp.*` calls are unavailable. Use `miakapp init --kind component` for the
semantic component ABI instead. Choose exactly one of `app` and `component`.

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
| `pair` | Redeems a one-time pairing code into a new stored context. |
| `context list\|show\|use\|remove` | Manages stored contexts. Never prints a key. |
| `init` | Writes `miakapp.yaml`. Never overwrites an existing one. |
| `agent-pack` | Offline. Installs the guide and the MCP wiring into a repository. |
| `discover` | Offline. Inventories a Node-RED installation from its flows export. |
| `check` | Offline. Parses the project, verifies the artifact, prints the digest. |
| `status` | Reads the live generation, release and digest of the home. |
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

The generated server entry uses `npx -y @miakapp/cli@<installed-version> mcp`,
so a new machine gets the same executable as the bundled guide without relying
on a global binary or this machine's directory layout.

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
      "args": ["@miakapp/cli", "mcp"]
    }
  }
}
```

| Tool | Command | |
| --- | --- | --- |
| `miakapp_pair` | `pair` | stores a new context; the code is a tool argument |
| `miakapp_context_list` | `context list` | read-only, offline |
| `miakapp_context_show` | `context show` | read-only, offline |
| `miakapp_context_use` | `context use` | offline, changes the current context |
| `miakapp_context_remove` | `context remove` | **deletes a stored key — needs `confirm: true`** |
| `miakapp_status` | `status` | read-only |
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

The three pointer-moving tools and `miakapp_context_remove` additionally
require `confirm: true`. It is
checked before anything else and never reaches the command line, so a model that
hallucinated a publication spends the mistake on an argument check instead of on
a generation.

A command that fails comes back as a tool result carrying `isError: true` and
the same closed object the CLI prints — `kind`, `exit_code`, `message` and a
remedy — not as a JSON-RPC error. That distinction matters: a protocol error
means the call never happened, while a publication that reached the control
plane and failed did happen, and only `kind` says whether to reconcile.

## Access: pairing and contexts

The owner grants access in their own browser; the agent never signs in. They
open `https://miakapp.com/pair`, choose the home, confirm, and send the
one-time code, which `pair` trades for a **new, separately revocable** Home Key:

```bash
printf '%s\n' "$CODE" | miakapp pair      # or run it in a terminal: hidden prompt
miakapp pair --code "$CODE"               # allowed, but lands in shell history
```

| Option | Default |
| --- | --- |
| `--issuer <https url>` | `https://control.miakapp.com` |
| `--label <label>` | `miakapp-cli@<host name>`, shown in the owner's key list |
| `--name <context>` | the paired home ID (`-2`, `-3`… if taken) |

Before the code is sent, the issuer must serve a discovery document naming
exactly itself; redirects are refused. The redeem response —
`POST {issuer}/v1/pairing/redeem` with `{code, label}`, answered with
`{home_key, home_id, key_id, issuer}` and `Cache-Control: no-store` — must name
the same issuer and a key whose ID is embedded in the key. The code is sent
once and never retried: a lost response is exit 7, because a key may exist.
`pair` then exchanges the key for a publication token, reported as
`publish_access`, so a key without the publish scope is caught now rather than
at the first publication.

Contexts live in `~/.miakapp` (or `$MIAKAPP_CONFIG_DIR`, absolute):

| File | Holds | Mode |
| --- | --- | --- |
| `config.json` | context names, home IDs, issuers, key IDs, labels, current context | 0600 |
| `credentials.json` | the Home Keys, nothing else | 0600 |

The directory is 0700. Both files are replaced through a temporary file, an
fsync and a rename, under a lock file, so concurrent runs never lose a context
and a crash never leaves half a file. A credentials file readable by another
account, a symbolic link, a foreign owner or a key that is not the one the
context was paired with is refused rather than used.

```bash
miakapp context list
miakapp context show [name]     # credential: stored (never printed)
miakapp context use <name>
miakapp context remove <name>   # local only: the owner revokes the key server-side
```

Which Home Key a command uses, highest precedence first:

1. `--context <name>`, then `MIAKAPP_CONTEXT=<name>`;
2. `MIAKAPP_HOME_KEY` — a raw key, kept for CI and compatibility;
3. the stored context whose home and issuer match `miakapp.yaml`, the current
   context breaking a tie between keys for that same home.

A selected context for another home — or a `MIAKAPP_HOME_KEY` this machine
knows was paired with another home — is refused before any request, so a key
can never publish into the wrong house. Every networked result reports
`credential_source` and `context`, never the key.

No command accepts a Home Key as an argument: an argument lands in shell
history, in a process listing and in most CI logs. The key is exchanged for a
five-minute `components:publish` token before every run, and publication
endpoints never see the Home Key itself.

## Generations

Activation is a compare-and-set: `--expected-generation` is the generation you
believe the pointer holds, and `--generation` (default: expected + 1) is the one
you are publishing. A stale expectation fails with `generation_conflict` and
exit code 6 rather than last-write-wins.

Without `--expected-generation`, `publish` and `activate` read the live pointer
first (`GET /v1/homes/{homeId}/component-pointer`, RFC 0004 §13.2) and use its
generation. That read takes no lock, so the activation is still a
compare-and-set: a publication that lands in between makes this one fail with
exit 6, never overwrites it. `miakapp status` prints the same read.

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
$ miakapp publish
miakapp: conflict: Activation failed with HTTP 409 generation_conflict (request Zq1...)
  Another publication advanced the pointer. Read the active generation and retry
  the activation with the observed expected_generation.
```

```console
$ miakapp publish --json
{"ok":false,"kind":"conflict","exit_code":6,"message":"...","remedy":"..."}
```

## Status

Alpha, tracking Miakapp 4. The package is `private` until the control plane it
talks to is deployed; publishing it to npm is a deliberate, separate step.
