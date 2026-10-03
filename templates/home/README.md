# A Miakapp home

A complete, working home: a coordinator that owns the logic, a component that is
the interface, and a project file that ties them to a control plane. It controls
one lamp and reports one temperature. Replace those with yours.

```
coordinator/home.ts    what this home is, as data — testable without a network
coordinator/main.ts    the only file that touches the outside world
component/main.ts      the interface, running in a sandboxed Worker
miakapp.yaml           home, control plane, artifact, capability requirements
test/home.test.ts      the coordinator's authorization, tested without a relay
```

## Copying this out of the MiakAPI repository

The three Miakapp dependencies use `file:` paths so the template stays verified
inside the repository. Replace them with published versions:

```bash
bun remove miakapi @miakapp/component @miakapp/cli
bun add miakapi @miakapp/component
bun add -d @miakapp/cli
```

Nothing else in the template refers to the repository.

## Running it

```bash
bun install
bun run check      # typecheck, bundle, test, then validate the artifact offline
```

`check` is the command to run before every publication and in CI. It costs
nothing and catches the artifact rules the runtime would reject anyway.

To run the coordinator against a real home:

```bash
export MIAKAPP_COORDINATOR_NAME=living-room
export MIAKAPP_CONTROL_PLANE_EXCHANGE_ENDPOINT=https://control.miakapp.com/v1/access-tokens:exchange
export MIAKAPP_OWNER_USER_ID=<your Firebase UID>
export MIAKAPP_HOME_KEY="$(your-secret-manager read miakapp/home-key)"
bun run dev
```

The coordinator's Home Key is read from its environment and never written to a
file in this project. Give the coordinator its own key, separate from the one
you publish with, so either can be revoked alone.

Publishing uses the key `miakapp pair` stored for this home in `~/.miakapp` —
the owner confirms the home at https://miakapp.com/pair and sends you a
one-time code — or `MIAKAPP_HOME_KEY` in CI:

```bash
printf '%s\n' "<code>" | miakapp pair   # once per home and machine
bun run publish:home                    # bundles, then publishes the next generation
miakapp status                          # verify the new digest is live
```

`miakapp.yaml` names the home. Replace `my-home` with the home ID `pair`
printed (or write the file with `miakapp init`, which takes both values from
the paired context); a key paired with another home is refused. The CLI reads
the live generation before activating, and the activation stays a
compare-and-set, so a concurrent publication fails with `conflict` instead of
being overwritten.

## The one rule that ties the three files together

A component receives the **intersection** of what it asks for and what the
coordinator grants. So every name in `miakapp.yaml` under `requires` must also
be covered by `coordinator/home.ts`:

| `miakapp.yaml` | `coordinator/home.ts` |
| --- | --- |
| `requires.state_read` | `stateAccess[].patterns` |
| `requires.event_subscribe` | `eventAccess[].subscribe` |
| `requires.event_publish` | `eventAccess[].publish` |
| `requires.call` | `functions` |

Asking for more than the coordinator grants does not fail loudly at publication.
The component simply never receives that path, and the interface renders a hole.
`test/home.test.ts` checks the correspondence so a mismatch fails in CI instead
of in someone's living room.

## Where the decisions live

**The coordinator authorizes everything.** The relay proves who is calling and
attaches non-spoofable caller metadata; deciding whether that person may act is
the coordinator's job, and `lighting.set` does it on its first line. Removing
that check does not produce an error — it produces a home anyone enrolled can
drive.

**The component trusts nothing it has not been told.** It has no network, no
storage and no DOM. It cannot request a capability that is not in the pointer.

**State first, event second.** `onLightChanged` writes the state before
publishing the event, so a subscriber that reacts to the event and immediately
reads the state never sees the old value.

**An unknown outcome is not a failure.** `component/main.ts` catches a failed
call and shows it, but never retries: the call may already have reached the
lamp. The next state snapshot is the authority.

## Next steps

- Replace `driveLamp` in `coordinator/main.ts` with your hardware.
- Add state paths in `coordinator/home.ts`, grant them in `stateAccess`, request
  them in `miakapp.yaml`, read them in `component/main.ts`.
- Keep `bun run check` green.
