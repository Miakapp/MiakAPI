import type {
  Coordinator,
  CoordinatorModule,
  CoordinatorOptions,
  ProtocolValue,
} from '../src/index.js';
import { createCoordinator } from '../src/index.js';
import type {
  BrowserClient,
  BrowserClientFactory,
  BrowserClientOptions,
} from '../src/browser.js';
import { createBrowserClient } from '../src/browser.js';

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
const browserOptions: BrowserClientOptions = {
  homeId: 'type-contract-home',
  relayUrl: 'wss://relay.example.test/miakapp/ws',
  idTokenProvider: {
    async getIdToken() {
      return 'firebase-id-token';
    },
  },
};
const browserFactory: BrowserClientFactory = createBrowserClient;

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

export function compileBrowserSurface(): BrowserClient {
  return browserFactory(browserOptions);
}
