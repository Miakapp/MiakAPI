import type { Coordinator, CoordinatorStatus } from 'miakapi';

import { createSyntheticCoordinator } from './synthetic-coordinator';

const LIVE_STATUSES: ReadonlySet<CoordinatorStatus> = new Set<CoordinatorStatus>([
  'idle',
  'connecting',
  'authenticating',
  'synchronizing',
  'ready',
  'reconnecting',
]);

function port(): number {
  const value = process.env['PORT'];
  if (value === undefined || value.trim() === '') return 8080;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`PORT must be a TCP port, received ${value}`);
  }
  return parsed;
}

function log(severity: 'INFO' | 'WARNING' | 'ERROR', message: string, extra: object = {}): void {
  console.log(JSON.stringify({ severity, message, ...extra }));
}

/**
 * Wraps the synthetic coordinator in the liveness surface a scale-to-one
 * container platform expects: the HTTP listener answers immediately, while the
 * relay session starts in the background and reports through `/healthz`.
 */
export function serveSyntheticCoordinator(coordinator: Coordinator): {
  readonly stopped: Promise<void>;
  readonly stop: () => Promise<void>;
} {
  let status: CoordinatorStatus = 'idle';
  let resolveStopped: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  coordinator.subscribe(({ current, reason }) => {
    status = current;
    log(LIVE_STATUSES.has(current) ? 'INFO' : 'WARNING', `coordinator ${current}`, {
      ...(reason === undefined ? {} : { reason: reason.kind }),
    });
    if (current === 'stopped') resolveStopped();
  });

  const server = Bun.serve({
    port: port(),
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname !== '/healthz') {
        return new Response('miakapp synthetic coordinator\n', {
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      }
      const live = LIVE_STATUSES.has(status);
      return new Response(JSON.stringify({ status, live }), {
        status: live ? 200 : 503,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  log('INFO', `listening on ${String(server.port)}`);

  return {
    stopped,
    stop: async () => {
      await coordinator.stop({ deadlineMs: 5_000 });
      await server.stop(true);
    },
  };
}

async function main(): Promise<void> {
  const coordinator = createSyntheticCoordinator();
  const service = serveSyntheticCoordinator(coordinator);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('INFO', `received ${signal}, draining`);
    void service.stop().then(() => process.exit(0));
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await coordinator.start();
  } catch (error) {
    log('ERROR', 'coordinator start failed', { error: String(error) });
    if (!shuttingDown) process.exit(1);
    return;
  }

  // `start()` resolves once the first session is ready. The coordinator
  // reconnects on its own afterwards; a terminal stop means the platform must
  // restart the container rather than keep a dead listener alive.
  await service.stopped;
  if (shuttingDown) return;
  log('ERROR', 'coordinator stopped without a shutdown signal');
  process.exit(1);
}

if (import.meta.main) await main();
