# Building a Miakapp home

For a coding agent handed someone's house: read what is there, write a
coordinator and an app, check them on the real home, publish. The owner is not a
home-automation developer and should not have to become one.

The how-to lives in short skills, one per job (listed at the end). This page is
what holds across all of them.

## What "done" means

The household can open the published app, read real values in it and use every
control the owner authorized — and you checked that yourself on the real home.

- **Publish, then verify.** A mockup, a local build or a screenshot is never the
  deliverable, and never something to stop and ask about: publication is
  reversible in one command.
- **Hand over the `home_url`** that `miakapp publish` and `miakapp status`
  print, and say what you verified there. Never the artifact URL.
- **Ask once, at the start, for what you cannot find.** Access comes from
  pairing, the house from inventory, physical controls from one question.
- **Right the first time.** The owner should never have to ask you to remove
  or restyle something you added.
- **Nothing from the platform's source.** The CLI, its starter and these skills
  are the whole toolchain. If a capability is missing, tell the owner; never
  patch or redeploy the platform for one house.

## Build it with the owner, one visible step at a time

Each step ends with something the owner sees in the published app, a few plain
sentences, and **one** question that opens the next step. A first session:

1. Right after pairing, publish the empty app and send its `home_url`: "Here is
   your home's app, empty for now. Do you have something precise in mind?
   Otherwise, which connected devices do you have?"
2. Ask only what you need to reach the devices (account, a Pi or small PC that
   runs 24/7), and **once** for the green light on physical controls, each
   reserved to the people the owner chooses. That answer covers the journey;
   still never trigger something that opens, unlocks or heats yourself — say it
   is ready to try.
3. Connect, publish, check, then propose the next step: rooms, **people and
   their rights** (early, before the home is shared), automations, devices that
   are not connected yet.

The owner's words, no technical detail unless asked. "Carry on without me"
means chain the steps and report at the end.

| In scope by default | Needs the owner's explicit request |
| --- | --- |
| reading the existing installation | changing flows, automations or devices that already run the house |
| giving the coordinator its own access to devices | removing or replacing the existing hub |
| writing, testing, publishing and rolling back | physical controls, until the one question is answered |

## What you are building

| Artifact | Runs | Owns |
| --- | --- | --- |
| Coordinator | the owner's machine, under Bun (`miakapi`) | state, events, functions, **authorization** |
| App | an isolated frame in each resident's browser | what residents see and touch |
| `miakapp.yaml` | — the contract | what the app may ask for |

The coordinator is trusted, the app is not. The relay terminates TLS and stores
plaintext state: self-hosting it is not end-to-end encryption; never say so.

## Access

Never ask for a password, a login or a key. The owner opens
https://miakapp.com/pair, picks the home, and sends you a one-time code
(10 minutes, once):

```bash
printf '%s\n' "<code>" | miakapp pair      # --issuer <url> if the page shows one
miakapp context list                      # homes this machine can publish to
```

The key lands in `~/.miakapp` (or `MIAKAPP_HOME_KEY` for CI), never in the
repository. The home's own coordinators may use the same key: give it to them
through their environment, never ask for a second pairing. Keys and wiring are
your business; tell the owner what works, not how.

## Keep this repository readable by the next agent

`miakapp agent-pack` (once) installs this guide, the skills below, a pointer in
`AGENTS.md` and `CLAUDE.md`, and the `miakapp` MCP server pinned in `.mcp.json`.
It only rewrites what it generated. `miakapp update` moves the repository to a
newer CLI (see the `miakapp-update` skill).

## Skills

| Skill | Use it to |
| --- | --- |
| `miakapp-coordinator` | inventory the house, talk to devices, write and test the coordinator |
| `miakapp-interface` | build the app: starter, design, state, calls |
| `miakapp-test-real` | check the app on the real home with `open`, `preview`, `taps` |
| `miakapp-publish` | publish, verify, roll back; exit codes; MCP |
| `miakapp-members` | members, join requests, invitations, roles, notifications |
| `miakapp-update` | a newer Miakapp exists: tell the owner, update, migrate |

They live in `.claude/skills/` (Claude Code) and `.agents/skills/` (Codex).
`miakapp docs start` prints this page and every skill; `miakapp docs design`
and `miakapp docs members` print the design and members guides.
