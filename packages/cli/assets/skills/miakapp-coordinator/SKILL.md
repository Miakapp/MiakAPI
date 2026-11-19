---
name: miakapp-coordinator
description: Inventory a Miakapp house and write its coordinator (miakapi, Bun) — reading an existing Node-RED/MQTT/Zigbee install, talking to devices directly, state, events, functions, authorization, direct mode on the home network, tests. Use when adding a device, a datum or an action, or touching coordinator/.
---

# The coordinator

The coordinator runs on the owner's machine and **authorizes everything**. The
relay says who is calling; deciding whether they may act is the first line of
every function, and nothing else will catch a missing check:

```ts
if (call.source.kind !== 'user' || !canDriveLights(call.source.id)) {
  throw new ApplicationCallError(2003, 'Only the household may drive the lights');
}
```

## Inventory first

Before designing anything, write `docs/inventory.md`: one line per datum or
action — source, what it is (unit), how fresh, who may read it, command or
measurement, path (`direct` or `bridge: <hub>`). On an inherited V3 house, read
the Node-RED export offline first:

```bash
miakapp discover --flows ~/node-red/flows.json
```

Act on its findings: `secret_in_export` (rotate it, keep the file out of Git),
`unrestricted_action` (an empty group list granted everyone), `name_needs_rename`,
`wildcard_subscription`. Which actions heat, lock, open or close is your
judgement with the owner, never a keyword list.

## Talk to the devices, not the old hub

MQTT/Zigbee2MQTT topics, GPIO, the device's local API, an RF/IR bridge — with
the coordinator's own broker user or token. A hub may serve as a temporary
`bridge:` for one datum, behind one function you can swap; never two masters
on one device. For new hardware recommend local open protocols (Zigbee,
MQTT, Tasmota/ESPHome), not Bluetooth or Wi-Fi.

## Shape

Keep the configuration a pure function of its options (`coordinator/home.ts`),
with `coordinator/main.ts` the only file touching the outside world, so
authorization is under test.

- `stateAccess[].patterns` is the disclosure boundary: widen it one path at a
  time. `directPatterns` (miakapi ≥ 4.4) are seen only on the home network.
- **State first, event second**, or a subscriber reads the old value.
- Caller mistakes throw `ApplicationCallError` (2000–2999); the app gets its
  sentence (≥ 4.5.1).
- Several coordinators share a home: scope your names, or the relay rejects
  with `4409`.
- `call.source.transport` is `direct` or `relay` (≥ 4.4); `address` is the
  phone's LAN address on direct calls (≥ 4.5).

**Intersection rule.** Every name the app uses is in `miakapp.yaml`
`requires` *and* granted here (`state_read` ↔ `stateAccess`, `call` ↔
`functions`, events likewise). A mismatch fails silently as a hole in the UI:
assert the correspondence in a test, and change state, access, `requires` and
test in one commit.

## Direct mode (on by default, miakapi ≥ 4.1)

Phones on the home network talk to the coordinator directly (UDP 4455,
WebRTC) and keep working without internet. Run it with host networking (or
publish 4455/udp and pass `direct: { hosts: [...] }`), keep `.miakapp/direct`
on a persistent volume, ask the owner for a DHCP reservation, and don't
`await start()` before wiring devices: it resolves only once the relay answers.

`bun run check` before every publication, and in CI with the pinned Bun.
