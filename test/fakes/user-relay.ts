import type {
  BrowserClient,
  BrowserClientLogger,
  BrowserReadySession,
  FirebaseIdTokenRequest,
} from '../../src/browser-api.js';
import { createBrowserClientWithRuntime } from '../../src/browser-client.js';
import { Opcode, type ProtocolValue } from '../../src/protocol/codec.js';
import { FakeRelay, type FakeRelayConnection, type FakeRelayOptions } from './relay.js';
import { FakeRuntime } from './runtime.js';

export interface UserBootstrapOptions {
  readonly revision?: number;
  readonly state?: Readonly<Record<string, ProtocolValue>>;
  readonly functions?: readonly string[];
}

export interface BrowserTestHarness {
  readonly client: BrowserClient;
  readonly relay: FakeRelay;
  readonly runtime: FakeRuntime;
  readonly tokenRequests: FirebaseIdTokenRequest[];
}

function dictionary(names: readonly string[], firstId: number): ProtocolValue[] {
  return names.map((name, index) => [firstId + index, name]);
}

export function sendUserBootstrap(
  connection: FakeRelayConnection,
  options: UserBootstrapOptions = {},
): void {
  const state = options.state ?? { 'home.temperature': 20 };
  const paths = Object.keys(state);
  const functions = options.functions ?? ['home.echo'];
  connection.sendWelcome();
  connection.send({
    opcode: Opcode.StateDict,
    payload: [connection.epoch, true, dictionary(paths, 101)],
  });
  connection.send({
    opcode: Opcode.StateSnapshot,
    payload: [
      connection.epoch,
      options.revision ?? 1,
      paths.map((path, index) => [101 + index, state[path] ?? null]),
    ],
  });
  connection.send({ opcode: Opcode.TopicDict, payload: [connection.epoch, true, []] });
  connection.send({
    opcode: Opcode.FunctionDict,
    payload: [connection.epoch, true, dictionary(functions, 301)],
  });
}

export function createBrowserTestHarness(
  relayOptions: FakeRelayOptions = {},
  logger?: BrowserClientLogger,
): BrowserTestHarness {
  const relay = new FakeRelay({ ...relayOptions, autoWelcome: false });
  const runtime = new FakeRuntime(relay);
  const tokenRequests: FirebaseIdTokenRequest[] = [];
  const baseOptions = {
    homeId: 'test-home',
    relayUrl: 'wss://relay.test/miakapp/ws',
    idTokenProvider: {
      async getIdToken(request: FirebaseIdTokenRequest): Promise<string> {
        tokenRequests.push(request);
        return `firebase-${request.reason}`;
      },
    },
  };
  const client = createBrowserClientWithRuntime(
    logger === undefined ? baseOptions : { ...baseOptions, logger },
    runtime,
  );
  return { client, relay, runtime, tokenRequests };
}

export async function startBrowserReady(
  harness: BrowserTestHarness,
  options: UserBootstrapOptions = {},
  connectionIndex = 0,
): Promise<{ connection: FakeRelayConnection; ready: BrowserReadySession }> {
  const started = harness.client.start();
  const connection = await harness.relay.connectionAt(connectionIndex);
  await connection.nextClientFrame(Opcode.Hello);
  sendUserBootstrap(connection, options);
  return { connection, ready: await started };
}
