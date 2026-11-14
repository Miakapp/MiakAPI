/**
 * This home's interface: a Miakapp whole-house application (miakapp.app/1).
 *
 * A starting point, not a finished home. As written it shows exactly what the
 * home shares with this interface — every granted state path, grouped by its
 * first segment, with an honest notice when the view is stale — and nothing
 * else: no invented value, no control. Before publishing it for residents:
 *
 * 1. inventory the house (sources, values, freshness, possible actions);
 * 2. declare the paths and calls you need in miakapp.yaml (app.requires);
 * 3. give every path a resident-facing name in LABELS and every group a page in
 *    PAGES: the home screen is a launcher of large tiles that fits one phone
 *    screen, each page is about one room or one type of device (never both),
 *    with its state first and its actions below (`miakapp docs design`,
 *    "How a home app works");
 * 4. add controls only for calls the owner authorized, and never retry one
 *    that failed with `outcome_unknown`.
 *
 * You own the whole document: any DOM, CSS, router or library a bundler can
 * inline. `bun run build` emits one classic-script IIFE. The only way to the
 * home is `./miakapp.ts`, the bridge copied from this CLI release.
 *
 * `./theme.ts` is the Miakapp design starting point (`miakapp docs design`):
 * tokens, four themes, component recipes, line icons (`icon()`),
 * `holdToConfirm()` for actions nobody should trigger by accident, `haptic()`,
 * and `createNav()`: pages that slide in, one history entry each (Android's back
 * button, Safari's swipe) and a swipe back from the left edge for the app
 * installed on an iPhone. Minuit is the default and follows dark mode; Lumière
 * follows a light preference. Keep it, restyle it or drop it.
 *
 * Old values are dimmed (`.mk-app.is-stale`), never announced by a banner: the
 * Miakapp bar already says when the home is reconnecting.
 */
import { connect, type HomeState, type Theme } from './miakapp.js';
import { THEME_CSS, createNav, icon, type IconName } from './theme.js';

/** Resident-facing names, from your inventory. A path without one shows as the path. */
const LABELS: Readonly<Record<string, string>> = {};

/**
 * The home screen's tiles: one page each, the most used first. The first one
 * is featured (wide and gold: the gate, the front door); give the others a
 * hue each (`.mk-tint-*`: lilac, sky, peach, rose, mint, honey) and a line
 * icon, never an emoji. A group of state paths without an entry here gets a
 * plain tile named after its first segment.
 */
const PAGES: Readonly<Record<string, {
  readonly label: string;
  readonly icon: IconName;
  readonly tint?: 'lilac' | 'sky' | 'peach' | 'rose' | 'mint' | 'honey';
}>> = {};

const home = connect();
const french = home.locale.toLowerCase().startsWith('fr');
const TEXT = french
  ? {
    empty: 'Rien de cette maison n’est encore partagé avec cette interface.',
    yes: 'Oui',
    no: 'Non',
    missing: '—',
    back: 'Retour',
  }
  : {
    empty: 'Nothing from this home is shared with this interface yet.',
    yes: 'Yes',
    no: 'No',
    missing: '—',
    back: 'Back',
  };

function element(tag: string, text?: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className !== undefined) node.className = className;
  return node;
}

const style = document.createElement('style');
style.textContent = `${THEME_CSS}
  /* .mk-screen fills the phone and keeps the bottom strip free for the Miakapp bar. */
  body { margin: 0; overscroll-behavior: none; }
  section { padding: 18px; }
  dl { margin: 0; display: grid; grid-template-columns: 1fr auto; gap: 8px 12px; }
  dt { color: var(--mk-ink-2); }
  dd { margin: 0; font-weight: 700; text-align: end; }
  .empty { color: var(--mk-ink-2); }
  .mk-app.is-stale dd { opacity: .5; }
`;
document.head.append(style);

/** Minuit unless the resident prefers light; "system" asks the browser. */
function applyTheme(preference: Theme): void {
  const light = preference === 'light' || (preference === 'system'
    && typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.dataset['theme'] = light ? 'lumiere' : 'minuit';
}
applyTheme(home.theme());
home.onThemeChange(applyTheme);
if (typeof matchMedia === 'function') {
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => applyTheme(home.theme()));
}
document.body.className = 'mk-app';

function format(value: unknown): string {
  if (value === undefined || value === null) return TEXT.missing;
  if (typeof value === 'boolean') return value ? TEXT.yes : TEXT.no;
  if (typeof value === 'number') return Number.isFinite(value) ? value.toLocaleString(home.locale) : TEXT.missing;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function groupsOf(paths: readonly string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const group = path.split('.')[0] ?? path;
    groups.set(group, [...groups.get(group) ?? [], path]);
  }
  return groups;
}

let last: HomeState | undefined;

/** Home screen: it opens pages, it does not show values. It fills the screen. */
function homeScreen(): HTMLElement {
  const screen = element('main', undefined, 'mk-screen');
  screen.append(element('h1', home.name, 'mk-headline'));
  const groups = groupsOf(home.paths());
  if (groups.size === 0) {
    screen.append(element('p', TEXT.empty, 'empty'));
    return screen;
  }
  const tiles = element('div', undefined, 'mk-entries');
  for (const [index, group] of [...groups.keys()].entries()) {
    const spec = PAGES[group];
    const classes = ['mk-entry'];
    if (spec !== undefined && index === 0) classes.push('is-featured');
    else if (spec?.tint !== undefined) classes.push(`mk-tint-${spec.tint}`);
    const entry = element('button', undefined, classes.join(' '));
    const glyph = element('span', undefined, 'mk-icon');
    glyph.innerHTML = icon(spec?.icon ?? 'grid');
    entry.append(glyph, element('span', spec?.label ?? group, 'name'));
    entry.addEventListener('click', () => nav.go(group));
    tiles.append(entry);
  }
  screen.append(tiles);
  return screen;
}

/** One page about one thing: what it is now, then (once you add calls) what to do. */
function groupPage(group: string): HTMLElement {
  const screen = element('main', undefined, 'mk-screen');
  const back = element('button', undefined, 'mk-back');
  back.innerHTML = icon('back');
  back.ariaLabel = TEXT.back;
  back.addEventListener('click', () => nav.back());
  const top = element('div', undefined, 'mk-topbar');
  top.append(back, element('span', PAGES[group]?.label ?? group));
  const section = element('section', undefined, 'mk-glass');
  const list = element('dl');
  for (const path of groupsOf(home.paths()).get(group) ?? []) {
    list.append(element('dt', LABELS[path] ?? path), element('dd', format(last?.values[path])));
  }
  section.append(list);
  screen.append(top, section);
  return screen;
}

// Pages slide in and out, each with its own history entry; swipe from the left edge to go back.
const nav = createNav({ render: (route) => (route === '' ? homeScreen() : groupPage(route)) });

home.subscribe((state) => {
  last = state;
  // Old values are dimmed, not announced: the Miakapp bar says the home is reconnecting.
  document.body.classList.toggle('is-stale', state.stale);
  nav.refresh();
});
home.ready();
