/**
 * The package's own identity, in one place.
 *
 * `main.ts` imports `agent-pack.ts`, so the constants cannot live in `main.ts`
 * without a cycle: the pack needs them to write a runnable MCP entry.
 *
 * Both values are duplicates of `package.json`, which cannot be imported here
 * without a JSON import assertion the build does not emit. `test/version.test.ts`
 * compares them to the manifest, because the drift is not cosmetic: the pack
 * writes `PACKAGE_NAME@CLI_VERSION` into a repository, and a stale version
 * would resolve a different release than the guide shipped beside it.
 */
export const PACKAGE_NAME = '@miakapp/cli';

export const CLI_VERSION = '4.0.0-alpha.4';
