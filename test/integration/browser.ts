import type {
  BrowserClientFailure,
  BrowserClientStatus,
  FirebaseIdTokenReason,
} from '../../src/browser.js';
import { createBrowserClient } from '../../src/browser.js';

interface BrowserIntegrationState {
  readonly revision: number;
  readonly stale: boolean;
  readonly temperature: unknown;
}

interface BrowserIntegrationFailure {
  readonly kind: BrowserClientFailure['kind'];
  readonly code?: number;
  readonly outcome: BrowserClientFailure['outcome'];
}

interface BrowserIntegration {
  start(): Promise<{ enrolled: boolean; coordinatorCount: number }>;
  state(): BrowserIntegrationState | undefined;
  call(target: number): Promise<unknown>;
  tokenReasons(): readonly FirebaseIdTokenReason[];
  statuses(): readonly BrowserClientStatus[];
  failures(): readonly BrowserIntegrationFailure[];
  stop(): Promise<void>;
}

interface BrowserGlobal {
  readonly location: { readonly host: string };
  miakappIntegration?: BrowserIntegration;
}

const browserGlobal = globalThis as unknown as BrowserGlobal;
const tokenReasons: FirebaseIdTokenReason[] = [];
const statuses: BrowserClientStatus[] = [];
const failures: BrowserIntegrationFailure[] = [];
const client = createBrowserClient({
  homeId: 'integration-home',
  relayUrl: `wss://${browserGlobal.location.host}/ws`,
  idTokenProvider: {
    async getIdToken({ reason, signal }) {
      if (signal.aborted) throw signal.reason;
      tokenReasons.push(reason);
      return reason === 'initial'
        ? 'integration-user-token'
        : 'integration-user-token-new';
    },
  },
});

client.subscribe(({ current }) => statuses.push(current));
client.errors.subscribe((failure) => failures.push(Object.freeze({
  kind: failure.kind,
  ...(failure.code === undefined ? {} : { code: failure.code }),
  outcome: failure.outcome,
})));

browserGlobal.miakappIntegration = Object.freeze({
  async start() {
    const ready = await client.start();
    return Object.freeze({
      enrolled: ready.enrolled,
      coordinatorCount: ready.coordinators.length,
    });
  },
  state() {
    const snapshot = client.state.snapshot();
    if (snapshot === undefined) return undefined;
    return Object.freeze({
      revision: snapshot.revision,
      stale: snapshot.stale,
      temperature: snapshot.values['integration.temperature'],
    });
  },
  async call(target: number) {
    const call = client.calls.start({
      function: 'integration.set',
      arguments: { target },
      timeoutMs: 5_000,
      idempotencyKey: 'integration-intent',
    });
    await call.accepted;
    return call.result;
  },
  tokenReasons: () => Object.freeze([...tokenReasons]),
  statuses: () => Object.freeze([...statuses]),
  failures: () => Object.freeze([...failures]),
  stop: () => client.stop({ deadlineMs: 2_000 }),
});
