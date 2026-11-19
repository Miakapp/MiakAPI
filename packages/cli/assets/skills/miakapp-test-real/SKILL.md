---
name: miakapp-test-real
description: Check a Miakapp app on the real home before and after publishing — miakapp open, preview and taps at phone size as a test member, per role. Use before telling the owner something works, after any app change, or when a button seems dead.
---

# Check it on the real home

Never test against a bridge you wrote yourself: it hides what breaks on a phone
(sandbox refusals, late answers, refused calls). Use the real home:

```bash
bun run build
miakapp preview --as member     # your build, not activated: prints a link (≤ 1 h)
miakapp taps --as member        # taps every control, reports what is wrong
miakapp open --as member        # the live release, same kind of link
```

The links open the home at phone size (390 × 844) as `test:<role>`, with no
account, through the real bar, relay and coordinator. Your coordinator gives
`test:<role>` that role's rights (never owner). Check once per role you built.

Open the link in the browser you already drive — never install one — and look
at every page with touch: pages slide, the left-edge swipe goes back, held
actions fire after 0.3 s.

`taps` reports controls with no call, no navigation and no visible change,
failed calls, start-up calls that failed or took over 1.5 s, app errors, and
saves a screenshot per page. Calls a tap makes are **held, never sent**, unless
you name the function with `--send` — reads only, never something that moves.
It drives a browser over CDP (`--cdp`, default `$MIAKAPP_CDP` or
`$AGENT_BROWSER_BASIC_CDP`).

Done when `taps` reports nothing for each role and you looked at every page.
