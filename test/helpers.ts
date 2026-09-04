import type {
  AccessTokenRequest,
  Coordinator,
  CoordinatorConfiguration,
  CoordinatorFailure,
  CoordinatorLogger,
  FunctionHandler,
  ReadySession,
} from '../src/api.js';
import { EventDirection } from '../src/api.js';
import { createCoordinatorWithRuntime } from '../src/coordinator.js';
import { Opcode } from '../src/protocol/codec.js';
import { FakeRelay, type FakeRelayConnection, type FakeRelayOptions } from './fakes/relay.js';
import { FakeRuntime } from './fakes/runtime.js';

export interface TestHarness {
  coordinator: Coordinator;
  relay: FakeRelay;
  runtime: FakeRuntime;
  tokenRequests: AccessTokenRequest[];
}

export function configuration(
  handler: FunctionHandler = (call) => call.arguments,
): CoordinatorConfiguration {
  return {
    state: { 'home.temperature': 20 },
    stateAccess: [{ userId: 'user-1', patterns: ['home.*'] }],
    events: [{
      topic: 'home.alert',
      directions: EventDirection.acceptFromUsers | EventDirection.publishToUsers,
    }],
    eventAccess: [{
      userId: 'user-1',
      publish: ['home.alert'],
      subscribe: ['home.alert'],
    }],
    functions: { 'home.echo': handler },
  };
}

export function createTestHarness(
  relayOptions: FakeRelayOptions = {},
  logger?: CoordinatorLogger,
): TestHarness {
  const relay = new FakeRelay(relayOptions);
  const runtime = new FakeRuntime(relay);
  const tokenRequests: AccessTokenRequest[] = [];
  const baseOptions = {
    name: relayOptions.coordinatorName ?? 'test-coordinator',
    accessTokenProvider: {
      async getAccessToken(request: AccessTokenRequest) {
        tokenRequests.push(request);
        return {
          relayUrl: 'wss://relay.test/miakapp/ws',
          token: `token-${request.reason}`,
          expiresAtMs: runtime.now() + 1_000_000,
        };
      },
    },
  };
  const coordinator = createCoordinatorWithRuntime(
    logger === undefined ? baseOptions : { ...baseOptions, logger },
    runtime,
  );
  return { coordinator, relay, runtime, tokenRequests };
}

export async function startReady(
  harness: TestHarness,
  declarations: CoordinatorConfiguration = configuration(),
  connectionIndex = 0,
): Promise<{ connection: FakeRelayConnection; ready: ReadySession }> {
  harness.coordinator.configure(declarations);
  const started = harness.coordinator.start();
  const connection = await harness.relay.connectionAt(connectionIndex);
  await connection.nextClientFrame(Opcode.Hello);
  await connection.acknowledgeDeclarations();
  const ready = await started;
  return { connection, ready };
}

export function isCoordinatorFailure(value: unknown): value is CoordinatorFailure {
  return value instanceof Error
    && 'kind' in value
    && 'outcome' in value
    && 'retryable' in value;
}
