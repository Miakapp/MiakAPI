/**
 * Serves a home's app on the local network, without the relay or the internet.
 *
 * The coordinator process opens a small HTTP server. A device on the same
 * network opens `http://<coordinator address>:<port>/`: the page installs the
 * same `window.miakapp` the trusted shell installs, wired straight to this
 * process (state over Server-Sent Events, calls over POST), then runs the
 * published `app.js`. Nothing here needs Firebase or the control plane, so it
 * keeps working when the home's internet link is down.
 *
 * Access: anyone on the network, or only holders of `token` when one is set
 * (open the page once as `/?key=<token>`).
 */
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';

export type LocalFunction = (args: unknown) => unknown;

export interface LocalServerOptions {
  readonly home: { readonly id: string; readonly name: string };
  /** The built app bundle (`dist/app.js`): a path or its contents. */
  readonly artifact: string | Uint8Array;
  readonly release?: string;
  readonly state?: Readonly<Record<string, unknown>>;
  readonly functions?: Readonly<Record<string, LocalFunction>>;
  readonly port?: number;
  readonly host?: string;
  readonly token?: string;
}

export interface LocalServer {
  /** Addresses a device on the network can open. */
  readonly urls: readonly string[];
  /** Merges values into the state and pushes them to open pages; `undefined` removes a path. */
  set(values: Readonly<Record<string, unknown>>): void;
  close(): Promise<void>;
}

const SHIM = `(() => {
  const config = JSON.parse(document.getElementById('miakapp-local').textContent);
  const key = new URLSearchParams(location.search).get('key') || '';
  const query = key ? '?key=' + encodeURIComponent(key) : '';
  let values = config.state;
  let revision = 0;
  let stale = false;
  const listeners = new Set();
  const snapshot = () => ({ values, revision, stale });
  const emit = () => { for (const listener of listeners) listener(snapshot()); };
  const events = new EventSource('/events' + query);
  events.onmessage = (message) => { values = JSON.parse(message.data); revision += 1; stale = false; emit(); };
  events.onerror = () => { stale = true; emit(); };
  window.miakapp = {
    abi: 'miakapp.app/1',
    release: config.release,
    home: config.home,
    locale: navigator.language || 'en',
    theme: 'system',
    onThemeChange: () => () => {},
    state: {
      get: (path) => values[path],
      values: () => values,
      get revision() { return revision; },
      get stale() { return stale; },
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    },
    can: { read: () => true, call: (name) => config.functions.includes(name) },
    async call(name, args, options) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), (options && options.timeoutMs) || 15000);
      try {
        const response = await fetch('/call' + query, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, args: args === undefined ? null : args }),
          signal: controller.signal,
        });
        const body = await response.json();
        if (!response.ok) throw Object.assign(new Error(body.code), { code: body.code });
        return body.result;
      } catch (error) {
        if (error && error.code) throw error;
        throw Object.assign(new Error('timeout'), { code: controller.signal.aborted ? 'timeout' : 'unavailable' });
      } finally {
        clearTimeout(timer);
      }
    },
    ready() {},
  };
})();`;

function escapeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function lanUrls(port: number): string[] {
  const urls = [`http://localhost:${port}/`];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) urls.push(`http://${address.address}:${port}/`);
    }
  }
  return urls;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.byteLength;
    if (size > 1_048_576) throw new Error('Body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function serveLocal(options: LocalServerOptions): Promise<LocalServer> {
  const artifact = typeof options.artifact === 'string'
    ? readFileSync(options.artifact)
    : Buffer.from(options.artifact);
  const functions = options.functions ?? {};
  let state: Record<string, unknown> = { ...(options.state ?? {}) };
  const streams = new Set<ServerResponse>();
  const port = options.port ?? 8787;

  const send = (response: ServerResponse, status: number, type: string, body: string | Buffer) => {
    response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    response.end(body);
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://local');
    if (options.token !== undefined && url.searchParams.get('key') !== options.token) {
      send(response, 401, 'text/plain; charset=utf-8', 'Open this page with ?key=<token>.');
      return;
    }
    if (request.method === 'GET' && url.pathname === '/') {
      const config = {
        home: options.home,
        release: options.release ?? 'local',
        state,
        functions: Object.keys(functions),
      };
      send(response, 200, 'text/html; charset=utf-8', `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${options.home.name.replace(/[<&]/g, '')}</title></head>
<body><script type="application/json" id="miakapp-local">${escapeJson(config)}</script>
<script>${SHIM}</script><script src="/app.js${url.search}"></script></body></html>`);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/app.js') {
      send(response, 200, 'application/javascript; charset=utf-8', artifact);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/events') {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      response.write(`data: ${JSON.stringify(state)}\n\n`);
      streams.add(response);
      request.on('close', () => streams.delete(response));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/call') {
      void (async () => {
        try {
          const { name, args } = await readJson(request) as { name?: unknown; args?: unknown };
          const handler = typeof name === 'string' ? functions[name] : undefined;
          if (handler === undefined) {
            send(response, 403, 'application/json', JSON.stringify({ code: 'denied' }));
            return;
          }
          const result = await handler(args);
          send(response, 200, 'application/json', JSON.stringify({ result: result ?? null }));
        } catch {
          send(response, 500, 'application/json', JSON.stringify({ code: 'failed' }));
        }
      })();
      return;
    }
    send(response, 404, 'text/plain; charset=utf-8', 'Not found');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, options.host ?? '0.0.0.0', () => resolve());
  });

  return {
    urls: lanUrls(port),
    set(values) {
      const next = { ...state };
      for (const [path, value] of Object.entries(values)) {
        if (value === undefined) delete next[path];
        else next[path] = value;
      }
      state = next;
      const frame = `data: ${JSON.stringify(state)}\n\n`;
      for (const stream of streams) stream.write(frame);
    },
    close() {
      for (const stream of streams) stream.end();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
