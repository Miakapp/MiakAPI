---
name: miakapp-publish
description: Publish a Miakapp home app, verify what is live, roll back, reconcile a lost request — miakapp check/status/publish/activate/rollback/release/upload, exit codes, the MCP tools and their confirm guard, notify. Use whenever shipping, verifying or undoing a release.
---

# Publish, verify, roll back

```bash
bun run check                        # typecheck, bundle, test, validate offline
miakapp status                       # what is live: generation, release, digest
miakapp publish                      # upload, finalize, activate
miakapp status                       # the live sha256 must be the one you built
miakapp rollback --sha256 <digest>   # back to a digest you trust
miakapp activate --sha256 <digest>   # same: promote any finalized digest
```

Then `miakapp open` it (skill `miakapp-test-real`) and hand the owner the
`home_url`, what you verified, and the previous digest. Keep every digest you
shipped: rollback is one command.

Activation is a compare-and-set on the home's generation; pass
`--expected-generation <n>` to assert the state you reviewed.

## Failures: branch on the kind

| Exit | Kind | Do |
| --- | --- | --- |
| 1 | `usage` | fix the invocation |
| 2 | `project` | fix `miakapp.yaml` |
| 3 | `artifact` | fix the bundle |
| 4 | `authorization` | pair again (ask the owner for a code) |
| 5 | `contract` | read the message; the control plane refused |
| 6 | `conflict` | the pointer moved: re-read with `status`, don't retry |
| 7 | `unknown_outcome` | **never retry**: reconcile with `miakapp release <sha256>` or `miakapp upload <uploadId>` |

`--json` prints one closed object. Over MCP (`miakapp mcp`, wired in
`.mcp.json`), each command is a `miakapp_*` tool; `publish`, `activate` and `rollback` need `confirm: true` —
set it because the owner asked for that publication, never to get past an
error. A failure is a result with `isError: true` carrying the same `kind`.

## Notify

```bash
miakapp notify --to <user-id>[,…] --title "Front door" --body "Open for 10 minutes"
```

Only the people you name, on devices where they turned notifications on;
`delivered: 0` is not an error. You decide who is told (skill `miakapp-members`).

## Before saying it is done

Inventory covered or explained · nothing invented, no technical words on
screen · `status` shows your digest · `taps` clean per role · physical
functions authorize on their first line, with a test · `requires` ↔ coordinator
asserted by a test · no unknown outcome retried · `bun run check` green in CI ·
no key in the repository · owner has the link and the rollback digest.
