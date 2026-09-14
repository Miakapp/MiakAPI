/**
 * The only file in this template that touches the outside world.
 *
 * It reads its credentials from the environment, wires the home configuration
 * to real hardware, and runs until the process is asked to stop.
 */
import {
  createCoordinator,
  createHomeKeyAccessTokenProvider,
  type Coordinator,
} from 'miakapi';
import { EVENT_LIGHT_CHANGED, STATE, createHomeConfiguration } from './home.js';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') throw new Error(`${name} is required`);
  return value;
}

/**
 * Replace this with your hardware: a GPIO write, an MQTT publish, a Zigbee
 * command, an HTTP call to an existing hub. Everything above it stays the same.
 */
async function driveLamp(on: boolean): Promise<void> {
  console.log(`[lamp] ${on ? 'on' : 'off'}`);
}

export function createHomeCoordinator(): Coordinator {
  const coordinator = createCoordinator({
    name: required('MIAKAPP_COORDINATOR_NAME'),
    accessTokenProvider: createHomeKeyAccessTokenProvider({
      exchangeEndpoint: required('MIAKAPP_CONTROL_PLANE_EXCHANGE_ENDPOINT'),
      homeKey: required('MIAKAPP_HOME_KEY'),
    }),
  });

  coordinator.configure(createHomeConfiguration({
    ownerUserId: required('MIAKAPP_OWNER_USER_ID'),
    setLight: driveLamp,
    onLightChanged: async (on) => {
      // State first, then the event. A subscriber that reacts to the event and
      // immediately reads the state must not see the old value.
      await coordinator.state.set([{ path: STATE.lightOn, value: on }]);
      await coordinator.events.publish(EVENT_LIGHT_CHANGED, { on });
    },
  }));

  return coordinator;
}

async function main(): Promise<void> {
  const coordinator = createHomeCoordinator();
  const stop = (): void => void coordinator.stop({ deadlineMs: 2_000 });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  const session = await coordinator.start();
  console.log(`[coordinator] session ${session.sessionId}, generation ${session.generation}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
