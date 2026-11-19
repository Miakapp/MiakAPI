# Members of a home: who is in, who sees what

`miakapp docs members` — read it when you set the home up, before the first
person other than the owner opens it.

## Who decides what

Miakapp only knows **accounts**: it signs people in (verified e-mail, Google…)
and tells your coordinator *who* is calling. It does not keep a member list and
grants nothing. **Your coordinator decides who is a member, with which rights,
and what each one sees.** Everything below is yours to build, in your
coordinator and your app, the way this home needs it.

What Miakapp gives you:

| Need | What exists |
| --- | --- |
| Who is calling | Every call and event carries a `principal`: `kind: 'user'`, `id` (stable account id), `verifiedEmail` (or null), `address` (direct calls: the phone's address on the home network), `transport` (`'direct'` = over the home network, `'relay'` = through Miakapp). |
| Who is connected | `coordinator.presence` lists `{ sessionId, userId }`. |
| What each person sees | `stateAccess` / `eventAccess` per `userId`, changed at runtime with `coordinator.access.declareState(...)`. |
| Telling someone | `miakapp notify --to <id>[,<id>…]` (or `POST` to the push audience with `to`). Only the people you name receive it, on the devices where they turned notifications on. |
| A tab with a count | `home.bar.setButtons([{ id: 'members', label: 'Members', icon: 'people', badge: 2 }])`. |
| An invitation link | `www.miakapp.com/h/<home>?invite=<code>`: your app reads `home.link.params.invite` (kept through sign-in). |
| Testing as each role | `miakapp open --as <role>` (also `preview`, `taps`) opens the home as `test:<role>`, with no e-mail: give that id the role's rights in your member list (never owner), and nothing else. |

Anyone signed in can open any home's address and load its app (the bundle holds
no household data: see the `miakapp-interface` skill). A person you have not admitted must get
**nothing** from the coordinator: no state path, no event, no function.

**A visitor can call one function only: `miakapp.join`.** The relay refuses
every other call from an account that no `stateAccess`/`eventAccess` entry
names (code 1201, the app only sees `failed`). So the visitor's door is a
single function your coordinator declares (miakapi ≥ 4.6.0), taking an
action: `miakapp.join({ action: 'me' | 'request' | 'redeem', … })`. Your app
calls it for "who am I", "ask to join" and "redeem this invite", for members
and visitors alike.

## What to build (the usual shape)

Keep the member list in the coordinator's own storage (a JSON file next to its
state, never in the repository: it holds names, e-mail addresses and ids).

```ts
interface Member {
  id: string | null;      // account id; null until an e-mail invitee first signs in
  email: string | null;   // verified e-mail, for invitations by address
  name: string;
  role: string;           // your roles: 'owner' | 'admin' | 'member' | 'guest'…
  rights?: string[];      // or finer permissions, if this home needs them
}
```

1. **Rights come from roles you design with the owner.** Ask them once who
   should do what ("Parents: everything. Kids: lights and shutters, not the
   gate. Guests: lights only"). Map each role to `stateAccess` patterns and to a
   check at the first line of every function. The owner's id comes from your
   coordinator's configuration; nobody can remove the owner.
2. **Apply rights the moment the list changes**: recompute `stateAccess` and
   `eventAccess` for everyone and `declareState(...)` again. A new member sees
   the home without reloading; a removed one loses it at once.
3. **A visitor asks to join.** Your app calls `miakapp.join({ action: 'me' })`:
   a non-member gets `{ member: false, requested: boolean }` and your app shows a
   "Request to join" screen with the home's name. `{ action: 'request' }` records
   `{ id, email, at }` (one pending request per account, refuse floods), then
   `miakapp notify --to` the owner and admins: "Diana wants to join".
4. **A Members tab for those who manage.** Show the bar button only to owner and
   admins, with `badge` = pending requests (0 hides it). The screen: members
   grouped by role, requests with Accept / Decline, and an **Invite** button.
5. **Invitations, several modes** (let the owner choose; offer what this home
   needs):
   - *by e-mail*: store `{ email, role }` with `id: null`; when a caller's
     `principal.verifiedEmail` matches, fill in the id: they are in.
   - *link with approval*: the link only pre-fills a request the manager
     accepts.
   - *pre-approved link*: whoever opens it gets the role in it.
   - *signed, expiring, revocable link*: the code is
     `base64url(payload).base64url(HMAC-SHA256(secret, payload))` with
     `{ role, exp, nonce }`; the coordinator keeps the secret and a revocation
     list, checks signature, expiry and revocation, and admits once per
     account (optionally single use).
   To hand the link over, call `home.share({ title, url })` straight from the
   Invite/Share button's tap handler (the frame cannot reach the share sheet or
   the clipboard; Miakapp does it, with a copy fallback). On `'unavailable'`,
   show the link in a read-only field so it can be copied by hand.
   The app reads `home.link.params.invite` on start and, if present, calls
   `miakapp.join({ action: 'redeem', code })`. Never trust the app: the coordinator checks
   everything.
6. **Roles that manage**: decide who may accept, invite and with which roles
   (an admin may not create an owner or remove an admin, for example). Check it
   in the coordinator, not only by hiding buttons.

## Rights only at home (guests on the Wi-Fi)

A call that arrives with `principal.transport === 'direct'` came over the home
network (WebRTC straight to this coordinator, miakapi ≥ 4.4.0): the caller is
on the home's Wi-Fi now. Use it for a role such as "guest: the gate from
anywhere, the rest only while at home":

- `stateAccess` entries take `directPatterns`: paths this person sees only on a
  direct session. They are never declared to the relay, so the same person
  opening the home from outside does not get them.
  `{ userId, patterns: ['gate.*'], directPatterns: ['living.*', 'shutters.*'] }`
- At the first line of each function outside the guest's everywhere-set, refuse
  when `call.source.transport !== 'direct'` ("only on the home Wi-Fi").
- Every coordinator of the home applies the same rule (the browser goes direct
  only when it reaches them all), and each must enroll the guest (at least an
  empty `patterns` entry) or the guest never gets a direct session.

## Notifications go to people you name

The platform never notifies "the whole home": anyone may turn notifications on
for any home, so a home-wide send would reach strangers. Choose recipients from
your member list for each message (alarm → everyone with the role; a join
request → owner and admins). `delivered: 0` is not an error: the person has not
turned notifications on yet.

## Check before you say it works

- A second account that is not a member opens the home: it sees your "Request
  to join" screen and gets nothing else (no state, every other call refused).
- The owner gets the notification, the Members tab shows the badge, Accept
  makes the home appear for the new member without a reload.
- An invite link opened while signed out survives the sign-in and admits.
- A revoked or expired link is refused with a clear message in your app.
