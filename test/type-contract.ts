import type {
  Coordinator,
  CoordinatorModule,
  CoordinatorOptions,
  ProtocolValue,
} from '../src/index.js';
import { createCoordinator } from '../src/index.js';

const options: CoordinatorOptions = {
  name: 'type-contract',
  accessTokenProvider: {
    async getAccessToken() {
      return {
        relayUrl: 'wss://relay.example.test/miakapp/ws',
        token: 'token',
        expiresAtMs: Date.now() + 60_000,
      };
    },
  },
};

const moduleSurface: CoordinatorModule = { createCoordinator };

export function compilePublicSurface(value: ProtocolValue): Coordinator {
  const coordinator = moduleSurface.createCoordinator(options);
  coordinator.configure({
    state: { 'contract.value': value },
    stateAccess: [],
    events: [],
    eventAccess: [],
    functions: {},
  });
  return coordinator;
}
