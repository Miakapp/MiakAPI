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
 * 3. give every path a resident-facing name in LABELS, and replace this layout
 *    with one organized the way people live in the house;
 * 4. add controls only for calls the owner authorized, and never retry one
 *    that failed with `outcome_unknown`.
 *
 * You own the whole document: any DOM, CSS, router or library a bundler can
 * inline. `bun run build` emits one classic-script IIFE. The only way to the
 * home is `./miakapp.ts`, the bridge copied from this CLI release.
 */
import { connect, type HomeState } from './miakapp.js';

/** Resident-facing names, from your inventory. A path without one shows as the path. */
const LABELS: Readonly<Record<string, string>> = {};

const home = connect();
const french = home.locale.toLowerCase().startsWith('fr');
const TEXT = french
  ? {
    empty: 'Rien de cette maison n’est encore partagé avec cette interface.',
    stale: 'Dernières valeurs connues ; en attente de la maison.',
    yes: 'Oui',
    no: 'Non',
    missing: '—',
  }
  : {
    empty: 'Nothing from this home is shared with this interface yet.',
    stale: 'Showing the last known values; waiting for the home.',
    yes: 'Yes',
    no: 'No',
    missing: '—',
  };

const style = document.createElement('style');
style.textContent = `
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 0; background: Canvas; color: CanvasText; }
  h1 { margin: 0; padding: 20px 20px 8px; font-size: 1.5rem; }
  main { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); padding: 16px; }
  section { padding: 18px; border-radius: 18px; background: color-mix(in srgb, CanvasText 6%, Canvas); }
  h2 { margin: 0 0 8px; font-size: 1rem; text-transform: capitalize; }
  dl { margin: 0; display: grid; grid-template-columns: 1fr auto; gap: 6px 12px; }
  dd { margin: 0; font-weight: 600; text-align: end; }
  .notice { margin: 0 16px; padding: 10px 14px; border-radius: 12px; background: #ffe2a8; color: #4a3000; }
  .empty { padding: 0 20px; opacity: .7; }
  .stale dd { opacity: .55; }
`;
document.head.append(style);

const title = document.createElement('h1');
const notice = document.createElement('p');
const main = document.createElement('main');
document.body.append(title, notice, main);

function element(tag: string, text?: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className !== undefined) node.className = className;
  return node;
}

function format(value: unknown): string {
  if (value === undefined || value === null) return TEXT.missing;
  if (typeof value === 'boolean') return value ? TEXT.yes : TEXT.no;
  if (typeof value === 'number') return Number.isFinite(value) ? value.toLocaleString(home.locale) : TEXT.missing;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function render(state: HomeState): void {
  title.textContent = home.name;
  notice.className = state.stale ? 'notice' : '';
  notice.textContent = state.stale ? TEXT.stale : '';

  const paths = home.paths();
  if (paths.length === 0) {
    main.replaceChildren(element('p', TEXT.empty, 'empty'));
    return;
  }
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const group = path.split('.')[0] ?? path;
    groups.set(group, [...groups.get(group) ?? [], path]);
  }
  main.replaceChildren(...[...groups].map(([group, members]) => {
    const section = element('section', undefined, state.stale ? 'stale' : undefined);
    const list = element('dl');
    for (const path of members) {
      list.append(element('dt', LABELS[path] ?? path), element('dd', format(state.values[path])));
    }
    section.append(element('h2', group), list);
    return section;
  }));
}

home.subscribe(render);
home.ready();
