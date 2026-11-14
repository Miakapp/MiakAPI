/**
 * Generates the design files the CLI ships from the sources in this folder.
 *
 *   assets/design/fonts.css            Manrope as a data: URL (the app frame has no network)
 *   assets/design/gallery.html         self-contained inspiration screens
 *   assets/design/icons.svg            the line icons of icons.ts, as an SVG sprite
 *   assets/starter/app/app/theme.ts    fonts + tokens + components as one string, the icons, hold to confirm
 *
 * `bun design/build.ts` writes them; `bun design/build.ts --check` fails when
 * one is out of date, so a test catches an edit to tokens.css that was not
 * regenerated.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ICONS } from './icons.ts';

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
  const symbols = Object.entries(ICONS)
    .map(([name, body]) => `  <symbol id="${name}" viewBox="0 0 24 24">${body}</symbol>`)
    .join('\n');
  const sprite = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <!-- Miakapp line icons, 24 × 24. Use one with <svg class="mk-i"><use href="#gate"/></svg> once this sprite is inlined. -->
${symbols}
</svg>
`;
  const gallery = (await text('gallery.template.html'))
    .replace('<!--__ICONS__-->', () => `<svg width="0" height="0" style="position:absolute" aria-hidden="true">\n${symbols}\n</svg>`)
    .replace('/*__FONT__*/', () => fonts)
    .replace('/*__TOKENS__*/', () => tokens)
    .replace('/*__COMPONENTS__*/', () => components)
    .replace('__LOGO__', `data:image/svg+xml;base64,${await base64('miakapp.svg')}`);
  const theme = `/**
 * Miakapp design tokens and component recipes, as one stylesheet.
 *
 * Generated from the CLI's assets/design/ (fonts.css, tokens.css,
 * components.css, icons.svg): run \`miakapp docs design\` for the guide. This copy is
 * yours: edit it, trim it or replace it.
 */
export const THEME_CSS = ${JSON.stringify(`${fonts}\n${tokens}\n${components}`)};

/** Line icons, 24 × 24 (\`icons.svg\` in the design directory). Use them instead of emoji. */
export const ICONS = ${JSON.stringify(ICONS, null, 2)} as const;

export type IconName = keyof typeof ICONS;

/** An icon as \`<svg class="mk-i">\` markup, for innerHTML: \`tile.innerHTML = icon('gate')\`. */
export function icon(name: IconName, className = 'mk-i'): string {
  return \`<svg class="\${className}" viewBox="0 0 24 24" aria-hidden="true">\${ICONS[name]}</svg>\`;
}

/**
 * Hold to confirm, for an action nobody should trigger by accident (open the
 * gate, unlock the door): \`run\` fires once the button has been held for \`ms\`;
 * letting go earlier cancels. The button's \`--hold\` goes from 0 to 1 while it
 * is held, and \`.mk-action.is-hold\` draws it as a filling gauge. Enter and
 * Space work the same from a keyboard. Returns a function that detaches it.
 */
export function holdToConfirm(button: HTMLButtonElement, run: () => void, ms = 600): () => void {
  let holding = false;
  let started = 0;
  let frame = 0;
  const show = (progress: number): void => { button.style.setProperty('--hold', String(progress)); };
  const stop = (): void => {
    holding = false;
    cancelAnimationFrame(frame);
    show(0);
  };
  const tick = (now: number): void => {
    if (!holding) return;
    const progress = Math.min(1, (now - started) / ms);
    show(progress);
    if (progress < 1) {
      frame = requestAnimationFrame(tick);
      return;
    }
    stop();
    run();
  };
  const begin = (event: Event): void => {
    if (holding || button.disabled) return;
    event.preventDefault();
    holding = true;
    started = performance.now();
    frame = requestAnimationFrame(tick);
  };
  const isPress = (event: KeyboardEvent): boolean => event.key === 'Enter' || event.key === ' ';
  const keydown = (event: KeyboardEvent): void => { if (isPress(event) && !event.repeat) begin(event); };
  const keyup = (event: KeyboardEvent): void => { if (isPress(event)) stop(); };
  const noMenu = (event: Event): void => { event.preventDefault(); };
  const cancels = ['pointerup', 'pointerleave', 'pointercancel', 'blur'] as const;
  button.addEventListener('pointerdown', begin);
  for (const type of cancels) button.addEventListener(type, stop);
  button.addEventListener('keydown', keydown);
  button.addEventListener('keyup', keyup);
  button.addEventListener('contextmenu', noMenu);
  return () => {
    stop();
    button.removeEventListener('pointerdown', begin);
    for (const type of cancels) button.removeEventListener(type, stop);
    button.removeEventListener('keydown', keydown);
    button.removeEventListener('keyup', keyup);
    button.removeEventListener('contextmenu', noMenu);
  };
}
`;
  return [
    ['../assets/design/fonts.css', fonts],
    ['../assets/design/gallery.html', gallery],
    ['../assets/design/icons.svg', sprite],
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
