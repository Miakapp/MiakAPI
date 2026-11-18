/**
 * `miakapp taps`: open a test session in a real browser (Chrome DevTools
 * Protocol), tap every interactive element of the home's app at phone size,
 * and report the ones that do nothing — no call, no navigation, no visible
 * change — plus the calls that failed or answered late and the errors the app
 * threw.
 *
 * Nothing a tap would send reaches the house unless its function is listed in
 * `send`: the shell of a test session holds those calls and records them
 * (`window.miakappTest`). Calls the app makes on its own (start-up, timers)
 * do go through, so the report shows their real latency and errors.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TapOptions {
  readonly url: string;
  readonly cdp: string;
  /** Function names (or `prefix*`) whose calls a tap may really send. */
  readonly send: readonly string[];
  readonly maxTaps?: number;
  readonly log?: (line: string) => void;
}

export interface TapResult {
  readonly page: string;
  readonly element: string;
  readonly effect: 'call' | 'navigation' | 'change' | 'nothing' | 'disabled';
  readonly calls: readonly { name: string; outcome: string; error?: string }[];
  readonly errors: readonly string[];
}

export interface CallReport {
  readonly name: string;
  readonly outcome: string;
  readonly error?: string;
  readonly ms?: number;
}

export interface TapReport {
  readonly pages: number;
  readonly taps: readonly TapResult[];
  readonly startupCalls: readonly CallReport[];
  readonly errors: readonly string[];
  readonly screenshots: string;
  readonly width: number;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string };
  sessionId?: string;
}

class Cdp {
  readonly #socket: WebSocket;
  #next = 1;
  readonly #pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  readonly #listeners = new Set<(message: CdpMessage) => void>();

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      if (message.id !== undefined) {
        const pending = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (message.error !== undefined) pending?.reject(new Error(message.error.message));
        else pending?.resolve(message.result ?? {});
        return;
      }
      for (const listener of this.#listeners) listener(message);
    });
  }

  static async connect(endpoint: string): Promise<Cdp> {
    let url = endpoint;
    if (/^https?:/u.test(url)) {
      const version = await (await fetch(`${url.replace(/\/+$/u, '')}/json/version`)).json() as { webSocketDebuggerUrl: string };
      url = version.webSocketDebuggerUrl;
    }
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('Cannot reach the browser (CDP)')), { once: true });
    });
    return new Cdp(socket);
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 30_000);
    });
  }

  on(listener: (message: CdpMessage) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): void {
    this.#socket.close();
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs in the app frame: the visible interactive elements, outermost first. */
const LIST_ELEMENTS = `(() => {
  const SEMANTIC = 'button, a[href], [role=button], [role=tab], [role=switch], [role=link], [role=menuitem], [role=checkbox], [role=radio], input:not([type=hidden]), select, textarea, summary, label[for], [onclick]';
  const path = (el) => {
    const parts = [];
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      let index = 1;
      for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (sibling.tagName === node.tagName) index += 1;
      }
      parts.unshift(node.tagName.toLowerCase() + ':nth-of-type(' + index + ')');
    }
    return 'body > ' + parts.join(' > ');
  };
  const label = (el) => {
    const text = (el.getAttribute('aria-label') || el.innerText || el.value || el.title || el.getAttribute('placeholder') || '').replace(/\\s+/g, ' ').trim();
    const name = el.tagName.toLowerCase() + (el.classList.length ? '.' + [...el.classList].slice(0, 2).join('.') : '');
    return text === '' ? name : name + ' "' + text.slice(0, 40) + '"';
  };
  const out = [];
  const taken = [];
  for (const el of document.querySelectorAll('body *')) {
    const style = getComputedStyle(el);
    const parentPointer = el.parentElement && getComputedStyle(el.parentElement).cursor === 'pointer';
    const semantic = el.matches(SEMANTIC);
    const pointer = style.cursor === 'pointer' && !parentPointer;
    if (!semantic && !pointer) continue;
    if (taken.some((outer) => outer.contains(el))) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
    if (r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) continue;
    const x = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1);
    const y = Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1);
    const hit = document.elementFromPoint(x, y);
    if (!hit || !(hit === el || el.contains(hit))) continue;
    taken.push(el);
    out.push({
      path: path(el), label: label(el), x, y,
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
    });
  }
  return out;
})()`;

/** Runs in the app frame: what a tap could have changed. */
const SIGNATURE = `(() => {
  let classes = '';
  for (const el of document.querySelectorAll('body *')) classes += el.getAttribute('class') || '';
  const heading = document.querySelector('h1, h2, [role=heading]');
  const active = document.activeElement;
  return {
    focus: active && active !== document.body ? active.tagName + (active.getAttribute('name') || active.getAttribute('placeholder') || '') : '',
    href: location.href,
    history: history.length,
    title: heading ? heading.textContent.trim().slice(0, 60) : '',
    dom: document.body.innerText + '|' + document.querySelectorAll('body *').length + '|' + classes,
  };
})()`;

interface Element {
  readonly path: string;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly disabled: boolean;
}

interface Signature {
  readonly focus: string;
  readonly href: string;
  readonly history: number;
  readonly title: string;
  readonly dom: string;
}

interface CallRecord {
  readonly name: string;
  readonly outcome: string;
  readonly error?: string;
  readonly ms?: number;
}

function matches(patterns: readonly string[], name: string): boolean {
  return patterns.some((pattern) => (pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern));
}

export async function runTaps(options: TapOptions): Promise<TapReport> {
  const log = options.log ?? (() => undefined);
  const maxTaps = options.maxTaps ?? 120;
  const cdp = await Cdp.connect(options.cdp);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }) as { targetId: string };
  const shots = join(tmpdir(), `miakapp-taps-${Date.now()}`);
  mkdirSync(shots, { recursive: true });
  try {
    const { sessionId: page } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string };
    // Every frame of the page, including the app's isolated frame (a target of its own).
    const sessions = new Set<string>([page]);
    const contexts = new Map<string, Set<number>>();
    const errors: string[] = [];
    cdp.on((message) => {
      if (message.method === 'Target.attachedToTarget') {
        const child = (message.params as { sessionId: string }).sessionId;
        sessions.add(child);
        void cdp.send('Runtime.enable', {}, child).catch(() => undefined);
        void cdp.send('Runtime.runIfWaitingForDebugger', {}, child).catch(() => undefined);
      } else if (message.method === 'Runtime.executionContextCreated' && message.sessionId !== undefined) {
        const context = (message.params as { context: { id: number; auxData?: { isDefault?: boolean } } }).context;
        if (context.auxData?.isDefault !== true) return;
        const set = contexts.get(message.sessionId) ?? new Set<number>();
        set.add(context.id);
        contexts.set(message.sessionId, set);
      } else if (message.method === 'Runtime.executionContextsCleared' && message.sessionId !== undefined) {
        contexts.delete(message.sessionId);
      } else if (message.method === 'Runtime.exceptionThrown') {
        const details = (message.params as { exceptionDetails: { text: string; exception?: { description?: string } } }).exceptionDetails;
        errors.push((details.exception?.description ?? details.text).split('\n')[0] ?? 'error');
      } else if (message.method === 'Runtime.consoleAPICalled') {
        const call = message.params as { type: string; args: { value?: unknown; description?: string }[] };
        if (call.type === 'error') {
          errors.push(call.args.map((arg) => String(arg.value ?? arg.description ?? '')).join(' ').slice(0, 200));
        }
      }
    });
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, page);
    await cdp.send('Runtime.enable', {}, page);
    await cdp.send('Page.enable', {}, page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, page);

    const evaluate = async <T>(sessionId: string, expression: string, contextId?: number): Promise<T> => {
      const response = await cdp.send('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: true,
        ...(contextId === undefined ? {} : { contextId }),
      }, sessionId) as { result: { value?: T }; exceptionDetails?: { text: string } };
      if (response.exceptionDetails !== undefined) throw new Error(response.exceptionDetails.text);
      return response.result.value as T;
    };

    /** The app's frame: the default context where the bridge lives. */
    const findApp = async (): Promise<{ session: string; context: number } | undefined> => {
      for (const [session, ids] of contexts) {
        for (const context of ids) {
          try {
            if (await evaluate<boolean>(session, "typeof window.miakapp === 'object' && window.miakapp !== null && typeof window.miakapp.call === 'function'", context)) {
              return { session, context };
            }
          } catch {
            ids.delete(context);
          }
        }
      }
      return undefined;
    };

    const shell = (expression: string) => evaluate<unknown>(page, expression);

    const load = async (): Promise<{ session: string; context: number }> => {
      const deadline = Date.now() + 30_000;
      for (;;) {
        const app = await findApp();
        if (app !== undefined) {
          // Ready: the shell says nothing about the connection, the app drew, and it holds still.
          const ready = await shell("!document.querySelector('.house-bar__status')").catch(() => false);
          const drawn = await evaluate<number>(app.session, 'document.body.innerText.length', app.context).catch(() => 0);
          if (ready && drawn > 0) {
            let last = await evaluate<Signature>(app.session, SIGNATURE, app.context);
            for (let stable = 0; stable < 2 && Date.now() < deadline;) {
              await sleep(500);
              const next = await evaluate<Signature>(app.session, SIGNATURE, app.context);
              stable = next.dom === last.dom ? stable + 1 : 0;
              last = next;
            }
            return app;
          }
        }
        if (Date.now() > deadline) {
          const status = await shell("document.querySelector('.house-bar__status')?.textContent ?? document.body.innerText.slice(0, 200)").catch(() => '');
          throw new Error(`The home's app did not open within 30 s (${String(status).trim() || 'no app frame'})`);
        }
        await sleep(400);
      }
    };

    const navigate = async (url: string): Promise<void> => {
      contexts.clear();
      await cdp.send('Page.navigate', { url }, page);
    };

    log('opening the home…');
    await navigate(options.url);
    let app = await load();
    const width = await evaluate<number>(app.session, 'innerWidth', app.context);
    const startupCalls = await shell('JSON.stringify(window.miakappTest?.calls ?? [])')
      .then((raw) => (JSON.parse(String(raw)) as CallRecord[]).map(({ name, outcome, error, ms }) => ({
        name, outcome, ...(error === undefined ? {} : { error }), ...(ms === undefined ? {} : { ms }),
      })));
    // Reloads keep the ticket (this tab's session storage), not the fragment.
    const homeUrl = String(await shell('location.href'));

    // Where the app's frame is on screen, and how much a test session shrank
    // the phone to fit the window (the app itself stays 390 × 844).
    const frameOffset = async (): Promise<{ x: number; y: number; scale: number }> => await shell(`(() => {
      const frame = [...document.querySelectorAll('iframe')].find((f) => /app\\.html/.test(f.src)) ?? document.querySelector('iframe');
      if (!frame) return { x: 0, y: 0, scale: 1 };
      const r = frame.getBoundingClientRect();
      const scale = frame.offsetWidth > 0 ? r.width / frame.offsetWidth : 1;
      return { x: r.left + frame.clientLeft * scale, y: r.top + frame.clientTop * scale, scale };
    })()`) as { x: number; y: number; scale: number };

    const tapAt = async (x: number, y: number): Promise<void> => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }, page);
      await sleep(60);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, page);
    };

    const tap = async (element: Element): Promise<void> => {
      const offset = await frameOffset();
      await tapAt(offset.x + element.x * offset.scale, offset.y + element.y * offset.scale);
    };

    const screenshot = async (name: string): Promise<void> => {
      const scale = Number(await shell("Number(getComputedStyle(document.documentElement).getPropertyValue('--miakapp-test-scale')) || 1"));
      const { data } = await cdp.send('Page.captureScreenshot', {
        format: 'png', clip: { x: 0, y: 0, width: 390 * scale, height: 844 * scale, scale: 1 / scale },
      }, page) as { data: string };
      writeFileSync(join(shots, `${name}.png`), Buffer.from(data, 'base64'));
    };

    /** Back to a page: reload the home, then replay the taps that led there. */
    const reach = async (path: readonly Element[]): Promise<void> => {
      await navigate(homeUrl);
      app = await load();
      for (const step of path) {
        const found = await evaluate<Element[]>(app.session, LIST_ELEMENTS, app.context);
        const element = found.find((candidate) => candidate.path === step.path) ?? found.find((candidate) => candidate.label === step.label);
        if (element === undefined) throw new Error(`cannot find ${step.label} again`);
        await tap(element);
        await sleep(900);
        app = (await findApp()) ?? app;
      }
    };

    const taps: TapResult[] = [];
    const queue: { name: string; path: Element[] }[] = [{ name: 'home', path: [] }];
    const seenPages = new Set<string>();
    let pageCount = 0;

    while (queue.length > 0 && taps.length < maxTaps) {
      const current = queue.shift() as { name: string; path: Element[] };
      if (current.path.length > 0) await reach(current.path);
      const signature = await evaluate<Signature>(app.session, SIGNATURE, app.context);
      const pageKey = `${signature.href}|${signature.title}`;
      if (seenPages.has(pageKey)) continue;
      seenPages.add(pageKey);
      pageCount += 1;
      await screenshot(`page-${pageCount}`);
      const elements = await evaluate<Element[]>(app.session, LIST_ELEMENTS, app.context);
      log(`page ${pageCount} (${current.name}): ${elements.length} elements`);
      let dirty = false;
      for (const element of elements) {
        if (taps.length >= maxTaps) break;
        if (element.disabled) {
          taps.push({ page: current.name, element: element.label, effect: 'disabled', calls: [], errors: [] });
          continue;
        }
        if (dirty) {
          await reach(current.path);
          dirty = false;
        }
        const before = await evaluate<Signature>(app.session, SIGNATURE, app.context);
        const callsBefore = Number(await shell('window.miakappTest?.calls.length ?? 0'));
        const errorsBefore = errors.length;
        // The shell holds a call unless its name is in the list given to hold.
        await shell(`window.miakappTest && (window.miakappTest.hold = (name) => !${JSON.stringify(options.send)}.some((p) => p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : name === p))`);
        await tap(element);
        await sleep(900);
        await shell('window.miakappTest && (window.miakappTest.hold = false)');
        const frame = (await findApp()) ?? app;
        app = frame;
        const after = await evaluate<Signature>(app.session, SIGNATURE, app.context).catch(() => before);
        const newCalls = (JSON.parse(String(await shell(`JSON.stringify((window.miakappTest?.calls ?? []).slice(${callsBefore}))`))) as CallRecord[])
          .map(({ name, outcome, error }) => ({ name, outcome, ...(error === undefined ? {} : { error }) }));
        const navigated = after.href !== before.href || after.history !== before.history;
        const changed = after.dom !== before.dom || (after.focus !== before.focus && after.focus !== '');
        const effect: TapResult['effect'] = newCalls.length > 0 ? 'call' : navigated ? 'navigation' : changed ? 'change' : 'nothing';
        taps.push({ page: current.name, element: element.label, effect, calls: newCalls, errors: errors.slice(errorsBefore) });
        log(`  ${effect.padEnd(10)} ${element.label}${newCalls.length > 0 ? ` → ${newCalls.map((call) => `${call.name} (${call.outcome})`).join(', ')}` : ''}`);
        if (navigated && current.path.length < 3) {
          queue.push({ name: `${current.name} › ${element.label}`, path: [...current.path, element] });
        }
        if (navigated || changed || newCalls.length > 0) dirty = true;
      }
    }

    // A call the app sent by itself is reported with its real outcome.
    return {
      pages: pageCount,
      taps,
      startupCalls,
      errors: [...new Set(errors)],
      screenshots: shots,
      width,
    };
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
    cdp.close();
  }
}

export { matches as matchesFunction };
