/**
 * The household's interface: a whole-house application.
 *
 * It owns its document — this file builds the DOM, styles it and routes between
 * two views with plain `location.hash`. Swap any of it for React, Svelte, Vue or
 * anything a bundler can inline: the build emits one classic-script IIFE
 * (`dist/app.js`), which is what Miakapp publishes and runs in its isolated
 * frame. The only way to the home is `@miakapp/app`.
 *
 * Every path read and function called is declared in `miakapp.yaml`; the
 * coordinator still decides per resident.
 */
import { callErrorCode, connect, type HomeState } from '@miakapp/app';

import { STATE } from '../coordinator/home.js';
import { buildView, phaseAfterFailure, type LightPhase } from './view.js';

const home = connect();
let phase: LightPhase = 'idle';
let state: HomeState = home.state();

const style = document.createElement('style');
style.textContent = `
  :root { color-scheme: light dark; font-family: ui-rounded, system-ui, sans-serif; }
  body { margin: 0; min-height: 100vh; background: Canvas; color: CanvasText; }
  header { display: flex; align-items: baseline; justify-content: space-between; padding: 20px 20px 8px; }
  h1 { margin: 0; font-size: 1.6rem; }
  nav { display: flex; gap: 6px; padding: 0 16px; }
  nav a { padding: 8px 14px; border-radius: 999px; color: inherit; text-decoration: none; }
  nav a[aria-current="page"] { background: color-mix(in srgb, CanvasText 12%, transparent); font-weight: 600; }
  main { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); padding: 16px; }
  .card { padding: 20px; border-radius: 22px; background: color-mix(in srgb, CanvasText 6%, Canvas); }
  .value { margin: 8px 0 0; font-size: 2.4rem; font-weight: 700; }
  .muted { opacity: .65; }
  .stale { margin: 0 16px; padding: 10px 14px; border-radius: 12px; background: #ffe2a8; color: #4a3000; }
  button { font: inherit; padding: 12px 20px; border: 0; border-radius: 999px; background: CanvasText; color: Canvas; }
  button:disabled { opacity: .45; }
`;
document.head.append(style);

const header = document.createElement('header');
const nav = document.createElement('nav');
const notice = document.createElement('p');
const main = document.createElement('main');
document.body.append(header, nav, notice, main);

const ROUTES = [['overview', 'Overview'], ['lights', 'Lights']] as const;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className !== undefined) node.className = className;
  return node;
}

async function toggleLight(next: boolean): Promise<void> {
  phase = 'sending';
  render();
  try {
    await home.call('lighting.set', { on: next }, { timeoutMs: 10_000 });
    phase = 'idle';
  } catch (error) {
    // Never retried: the next state snapshot says what really happened.
    phase = phaseAfterFailure(callErrorCode(error));
  }
  render();
}

function render(): void {
  const view = buildView(home.name, state, phase, home.canCall('lighting.set'));
  const route = location.hash.slice(1) === 'lights' ? 'lights' : 'overview';

  header.replaceChildren(element('h1', view.title), element('span', view.healthy ? 'Home online' : 'Home offline', 'muted'));
  nav.replaceChildren(...ROUTES.map(([id, label]) => {
    const link = element('a', label);
    link.href = `#${id}`;
    if (id === route) link.setAttribute('aria-current', 'page');
    return link;
  }));
  notice.className = view.stale ? 'stale' : '';
  notice.textContent = view.stale ? 'Showing the last known state; waiting for the home.' : '';

  const light = element('section', undefined, 'card');
  const button = element('button', view.light.label);
  button.disabled = !view.light.usable;
  button.addEventListener('click', () => void toggleLight(view.light.on !== true));
  light.append(
    element('h2', 'Living-room lamp'),
    element('p', view.light.on === undefined ? '—' : view.light.on ? 'On' : 'Off', 'value'),
    button,
    ...(view.light.note === undefined ? [] : [element('p', view.light.note, 'muted')]),
  );

  const climate = element('section', undefined, 'card');
  climate.append(
    element('h2', 'Temperature'),
    element('p', view.temperature ?? '—', 'value'),
    element('p', home.canRead(STATE.temperature) ? 'Living room' : 'Not shared with you', 'muted'),
  );

  main.replaceChildren(...(route === 'lights' ? [light] : [climate, light]));
}

window.addEventListener('hashchange', render);
home.subscribe((next) => {
  state = next;
  if (phase === 'unknown') phase = 'idle';
  render();
});
