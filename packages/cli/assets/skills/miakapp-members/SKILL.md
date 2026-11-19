---
name: miakapp-members
description: Members of a Miakapp home — who is in, roles and rights, join requests, invitations (e-mail, links), the miakapp.join visitors' door, guests on the home Wi-Fi, who gets notified. Use before the home is shared with anyone, or when adding people, roles or invitations.
---

# Members

Miakapp only says **who is calling** (account id, verified e-mail; on direct
calls, transport and LAN address). It keeps no member list and grants nothing:
**your coordinator decides who is a member, what each role sees and does, and
who is told.** Read the full guide before building it:

```bash
miakapp docs members
```

The shape it describes:

- A member list in the coordinator's own storage (never the repository):
  id, e-mail, name, role. Roles designed once with the owner ("parents:
  everything; kids: lights and shutters; guests: lights").
- Rights applied the moment the list changes: recompute `stateAccess` /
  `eventAccess` and `declareState(...)` again; every function checks the role
  on its first line.
- A visitor can call one function only: **`miakapp.join`** (miakapi ≥ 4.6),
  with `action: 'me' | 'request' | 'redeem'` — who am I, ask to join, redeem an
  invite. Anyone not admitted gets nothing else.
- Invitation links `…/h/<home>?invite=<code>`, read in the app from
  `home.link.params.invite`; share them with `home.share()`.
- Join requests notify the owner and admins with `miakapp notify --to`, and a
  badge on a bar button (`home.bar.setButtons([{ …, icon: 'people', badge }])`).
- Guests on the home Wi-Fi only: `directPatterns` and `call.source.transport`.
- Test each role with `miakapp taps --as <role>`: map `test:<role>` to that
  role in your list.
