# Releasing MiakAPI

Releases are cut by pushing a tag. `.github/workflows/release.yml` runs the full
`bun run check` gate, refuses to continue when the tag and `package.json`
disagree, and publishes with npm provenance.

## One-time setup

Pick one of the two credentials. Trusted publishing is preferred: nothing
long-lived is stored in the repository.

**Trusted publishing (recommended).** On npmjs.com, open the package settings →
*Trusted publisher* → GitHub Actions, and register:

| Field | Value |
| --- | --- |
| Organization or user | `Miakapp` |
| Repository | `MiakAPI` |
| Workflow filename | `release.yml` |
| Environment | `npm` |

**Automation token (fallback).** Create a granular automation token with publish
access to the package and store it as the `NPM_TOKEN` repository secret.

Either way, the `npm` GitHub environment is where required reviewers belong if
publishing should need a second pair of eyes.

## Cutting a release

1. Land every change on `main` and confirm CI is green.
2. Set the version in the package being released. Root `miakapi` pre-releases
   keep the `next` dist-tag through `publishConfig`; `@miakapp/cli` remains the
   installable agent entry point on `latest`.
3. Tag and push:

   ```sh
   git tag v4.0.0-alpha.1
   git push origin v4.0.0-alpha.1
   ```

   For the CLI, use its package-specific tag:

   ```sh
   git tag cli-v4.0.0-alpha.1
   git push origin cli-v4.0.0-alpha.1
   ```

4. Watch the *Release* workflow. It publishes only on a tag push. A manual
   `workflow_dispatch` run stops after the gate — which ends with
   `npm pack --dry-run` — and is the way to rehearse a release without
   publishing anything.

## After publishing

Verify the dist-tags before announcing:

```sh
npm view miakapi dist-tags
npm view @miakapp/cli dist-tags
```

`latest` must still point at the MiakAPI 3 line until version 4 is stable.
