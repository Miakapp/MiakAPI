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
 * tokens, four themes and component recipes. Minuit follows the resident's
 * dark mode, Lumière the light one. Keep it, restyle it or drop it.
 */
import { connect, type HomeState, type Theme } from './miakapp.js';
import { THEME_CSS } from './theme.js';

/** Resident-facing names, from your inventory. A path without one shows as the path. */
const LABELS: Readonly<Record<string, string>> = {};

/**
 * The home screen's tiles: one page each, the most used first. A group of
 * state paths without an entry here gets a tile named after its first segment.
 */
const PAGES: Readonly<Record<string, { readonly label: string; readonly glyph: string }>> = {};

const home = connect();
const french = home.locale.toLowerCase().startsWith('fr');
const TEXT = french
  ? {
    empty: 'Rien de cette maison n’est encore partagé avec cette interface.',
    stale: 'Dernières valeurs connues ; en attente de la maison.',
    yes: 'Oui',
    no: 'Non',
    missing: '—',
    back: 'Retour',
  }
  : {
    empty: 'Nothing from this home is shared with this interface yet.',
    stale: 'Showing the last known values; waiting for the home.',
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
  /* The Miakapp bar floats over the bottom of the frame: keep that strip free. */
  body { margin: 0; min-height: 100vh; padding-bottom: 96px; box-sizing: border-box; }
  h1 { margin: 0; padding: 28px 20px 12px; }
  main { padding: 0 16px 16px; max-width: 720px; margin: 0 auto; }
  .back { margin: 20px 16px 0; }
  section { padding: 18px; }
  dl { margin: 0; display: grid; grid-template-columns: 1fr auto; gap: 8px 12px; }
  dt { color: var(--mk-ink-2); }
  dd { margin: 0; font-weight: 700; text-align: end; }
  .mk-stale-banner { margin: 8px 16px 0; }
  .empty { padding: 0 20px; color: var(--mk-ink-2); }
  .is-stale dd { opacity: .55; }
`;
document.head.append(style);

/** The resident's light or dark preference picks the theme; "system" asks the browser. */
function applyTheme(preference: Theme): void {
  const dark = preference === 'dark' || (preference === 'system'
    && typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset['theme'] = dark ? 'minuit' : 'lumiere';
}
applyTheme(home.theme());
home.onThemeChange(applyTheme);
if (typeof matchMedia === 'function') {
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(home.theme()));
}
document.body.className = 'mk-app';

const title = element('h1', undefined, 'mk-display');
const notice = document.createElement('p');
const main = document.createElement('main');
document.body.append(title, notice, main);

function format(value: unknown): string {
  if (value === undefined || value === null) return TEXT.missing;
  if (typeof value === 'boolean') return value ? TEXT.yes : TEXT.no;
  if (typeof value === 'number') return Number.isFinite(value) ? value.toLocaleString(home.locale) : TEXT.missing;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/** The page on screen: null is the home screen (a launcher), otherwise a group. */
let page: string | null = null;
let last: HomeState | undefined;

function groupsOf(paths: readonly string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const group = path.split('.')[0] ?? path;
    groups.set(group, [...groups.get(group) ?? [], path]);
  }
  return groups;
}

function show(next: string | null): void {
  page = next;
  if (last !== undefined) render(last);
}

function render(state: HomeState): void {
  last = state;
  notice.className = state.stale ? 'mk-stale-banner' : '';
  notice.textContent = state.stale ? TEXT.stale : '';

  const groups = groupsOf(home.paths());
  if (groups.size === 0) {
    title.textContent = home.name;
    main.replaceChildren(element('p', TEXT.empty, 'empty'));
    return;
  }
  const members = page === null ? undefined : groups.get(page);
  if (page === null || members === undefined) {
    // Home screen: it opens pages, it does not show values.
    page = null;
    title.textContent = home.name;
    const entries = element('div', undefined, 'mk-entries');
    for (const group of groups.keys()) {
      const entry = element('button', undefined, 'mk-entry');
      entry.append(element('span', PAGES[group]?.glyph ?? '•', 'glyph'), PAGES[group]?.label ?? group);
      entry.addEventListener('click', () => show(group));
      entries.append(entry);
    }
    main.replaceChildren(entries);
    return;
  }
  // One page about one thing: what it is now, then (once you add calls) what to do.
  title.textContent = PAGES[page]?.label ?? page;
  const back = element('button', `← ${TEXT.back}`, 'mk-button is-quiet back');
  back.addEventListener('click', () => show(null));
  const section = element('section', undefined, state.stale ? 'mk-glass is-stale' : 'mk-glass');
  const list = element('dl');
  for (const path of members) {
    list.append(element('dt', LABELS[path] ?? path), element('dd', format(state.values[path])));
  }
  section.append(list);
  main.replaceChildren(back, section);
}

home.subscribe(render);
home.ready();
