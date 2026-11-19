---
name: miakapp-update
description: A newer Miakapp CLI is available ("Miakapp X is available", an update_available field, or the owner asks) — tell the owner what it improves for their home and what you will change, ask, then update the repository, apply the migrations and verify on the real home. Also use to check whether this home is up to date.
---

# Update Miakapp

Run `miakapp changes` and `miakapp update` through the newest CLI, never the
pinned one — an old release cannot describe or install what came after it.

1. **See what changed** since the version this repository pins:

   ```bash
   npx -y @miakapp/cli@latest changes
   ```

   Each version says what it brings the home (plain words) and what you must
   change (migration steps).

2. **Ask the owner, briefly**, in their words: what it improves for them, what
   you will change (e.g. "I'll update the app's toolkit and check every
   button again; nothing changes in how you use it"), and whether to do it
   now. Suggest "yes". Don't update without that answer, unless the owner
   already said to keep Miakapp up to date.

3. **Update the repository** with the new CLI:

   ```bash
   npx -y @miakapp/cli@latest update
   bun install
   ```

   It pins the new version in `.mcp.json` and `package.json`, rewrites the
   pack (guide, skills, instruction block), refreshes the generated bridge
   `app/miakapp.ts`, checks the project, and prints the migrations to apply.
   It never touches anything else.

4. **Apply each migration**, then `bun run check`. If a step concerns the
   coordinator (a `miakapi` bump), restart it the way this home runs it.

5. **Verify on the real home** (skill `miakapp-test-real`), publish if the app
   changed (skill `miakapp-publish`), commit, and tell the owner what is new
   in one or two sentences.

Restart the session or reload MCP servers afterwards: the `miakapp` server
runs the version pinned in `.mcp.json`.
