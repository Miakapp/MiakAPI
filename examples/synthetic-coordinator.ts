import {
  ApplicationCallError,
  createCoordinator,
  createHomeKeyAccessTokenProvider,
  type Coordinator,
  type CoordinatorConfiguration,
} from 'miakapi';

export interface SyntheticConfigurationOptions {
  readonly ownerUserId: string;
  readonly setLightState: (on: boolean) => Promise<void>;
}

export function createSyntheticConfiguration(
  options: SyntheticConfigurationOptions,
): CoordinatorConfiguration {
  let lightOn = false;
  return {
    state: {
      'system.connection.status': 'connected',
      'zone.alpha.light.on': lightOn,
      'access.barrier.phase': 'closed',
      'climate.zone_gamma.temperature': 19.5,
      'climate.zone_gamma.setpoint': 20,
      'energy.grid.power_w': 350,
      'device.contact_alpha.battery_percent': 80,
      'service.coordinator.health': 'healthy',
    },
    stateAccess: [{
      userId: options.ownerUserId,
      patterns: [
        'access.*',
        'climate.*',
        'device.*',
        'energy.*',
        'service.*',
        'system.*',
        'zone.*',
      ],
    }],
    events: [],
    eventAccess: [],
    functions: {
      async 'lighting.toggle'(call) {
        if (call.arguments !== null) {
          throw new ApplicationCallError(2001, 'lighting.toggle takes no arguments');
        }
        lightOn = !lightOn;
        await options.setLightState(lightOn);
        return { on: lightOn };
      },
    },
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') throw new Error(`${name} is required`);
  return value;
}

export function createSyntheticCoordinator(): Coordinator {
  const homeKey = required('MIAKAPP_HOME_KEY');
  const exchangeEndpoint = required('MIAKAPP_CONTROL_PLANE_EXCHANGE_ENDPOINT');
  const ownerUserId = required('MIAKAPP_OWNER_USER_ID');
  const coordinator = createCoordinator({
    name: 'miakapp-v4-bun',
    accessTokenProvider: createHomeKeyAccessTokenProvider({ exchangeEndpoint, homeKey }),
  });

  coordinator.configure(createSyntheticConfiguration({
    ownerUserId,
    setLightState: async (on) => {
      await coordinator.state.set([{ path: 'zone.alpha.light.on', value: on }]);
    },
  }));
  return coordinator;
}

async function main(): Promise<void> {
  const coordinator = createSyntheticCoordinator();
  const stop = () => void coordinator.stop({ deadlineMs: 2_000 });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  coordinator.subscribe(({ current, reason }) => {
    console.log(`Miakapp coordinator: ${current}${reason === undefined ? '' : ` (${reason.kind})`}`);
  });
  await coordinator.start();
}

if (import.meta.main) await main();
