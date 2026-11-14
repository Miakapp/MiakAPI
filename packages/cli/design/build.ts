/**
 * Generates the design files the CLI ships from the sources in this folder.
 *
 *   assets/design/fonts.css            Manrope as a data: URL (the app frame has no network)
 *   assets/design/gallery.html         self-contained inspiration screens
 *   assets/starter/app/app/theme.ts    fonts + tokens + components, as one string for the starter
 *
 * `bun design/build.ts` writes them; `bun design/build.ts --check` fails when
 * one is out of date, so a test catches an edit to tokens.css that was not
 * regenerated.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const at = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
const text = (relative: string): Promise<string> => readFile(at(relative), 'utf8');
const base64 = async (relative: string): Promise<string> => (await readFile(at(relative))).toString('base64');

// The Latin subset covers English and the Western European languages, French included.
const LATIN = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,'
  + 'U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';

export async function designOutputs(): Promise<ReadonlyArray<readonly [path: string, content: string]>> {
  const fonts = `/* Manrope (SIL Open Font License 1.1, see OFL-Manrope.txt), Latin subset, weights 200-800. */
@font-face {
  font-family: "Manrope";
  font-style: normal;
  font-display: swap;
  font-weight: 200 800;
  src: url("data:font/woff2;base64,${await base64('manrope-latin.woff2')}") format("woff2");
  unicode-range: ${LATIN};
}
`;
  const tokens = await text('../assets/design/tokens.css');
  const components = await text('../assets/design/components.css');
  const gallery = (await text('gallery.template.html'))
    .replace('/*__FONT__*/', () => fonts)
    .replace('/*__TOKENS__*/', () => tokens)
    .replace('/*__COMPONENTS__*/', () => components)
    .replace('__LOGO__', `data:image/svg+xml;base64,${await base64('miakapp.svg')}`);
  const theme = `/**
 * Miakapp design tokens and component recipes, as one stylesheet.
 *
 * Generated from the CLI's assets/design/ (fonts.css, tokens.css,
 * components.css): run \`miakapp docs design\` for the guide. This copy is
 * yours: edit it, trim it or replace it.
 */
export const THEME_CSS = ${JSON.stringify(`${fonts}\n${tokens}\n${components}`)};
`;
  return [
    ['../assets/design/fonts.css', fonts],
    ['../assets/design/gallery.html', gallery],
    ['../assets/starter/app/app/theme.ts', theme],
  ];
}

if (import.meta.main) {
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const [relative, content] of await designOutputs()) {
    if (check) {
      const current = await readFile(at(relative), 'utf8').catch(() => '');
      if (current !== content) {
        stale += 1;
        console.error(`out of date: ${relative.replace('../', 'packages/cli/')}`);
      }
    } else {
      await writeFile(at(relative), content);
      console.log(`wrote ${relative.replace('../', 'packages/cli/')} (${content.length} bytes)`);
    }
  }
  if (stale > 0) {
    console.error('Run: bun design/build.ts');
    process.exit(1);
  }
}
