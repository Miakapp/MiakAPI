/**
 * What this home is, as data.
 *
 * The configuration is a pure function of its options so it can be tested
 * without a relay, a control plane or a network. `coordinator/main.ts` is the
 * only file that touches the outside world.
 */
import {
  ApplicationCallError,
  EventDirection,
  type CoordinatorConfiguration,
  type ProtocolValue,
} from 'miakapi';

export const STATE = {
  lightOn: 'zone.salon.light.on',
  temperature: 'climate.salon.temperature',
  health: 'service.coordinator.health',
} as const;

export const EVENT_LIGHT_CHANGED = 'zone.salon.light.changed';

export interface HomeOptions {
  /** Firebase UID of the person who may see and drive this home. */
  readonly ownerUserId: string;
  /** Drives the real lamp. Replace the stub in main.ts with your hardware. */
  readonly setLight: (on: boolean) => Promise<void>;
  /** Called after a successful change so the coordinator can publish it. */
  readonly onLightChanged: (on: boolean) => Promise<void>;
}

function booleanArgument(value: ProtocolValue, name: string): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApplicationCallError(2001, `${name} expects an object argument`);
  }
  const on = (value as Record<string, ProtocolValue>)['on'];
  if (typeof on !== 'boolean') {
    throw new ApplicationCallError(2002, `${name} expects a boolean "on"`);
  }
  return on;
}

export function createHomeConfiguration(options: HomeOptions): CoordinatorConfiguration {
  return {
    state: {
      [STATE.lightOn]: false,
      [STATE.temperature]: 19.5,
      [STATE.health]: 'healthy',
    },

    // The user sees exactly these paths and nothing else. Widen deliberately:
    // this list is the disclosure boundary, and the component's requirements in
    // miakapp.yaml can never exceed it.
    stateAccess: [{
      userId: options.ownerUserId,
      patterns: ['climate.salon.*', 'service.coordinator.health', 'zone.salon.*'],
    }],

    events: [{ topic: EVENT_LIGHT_CHANGED, directions: EventDirection.publishToUsers }],
    eventAccess: [{
      userId: options.ownerUserId,
      publish: [],
      subscribe: [EVENT_LIGHT_CHANGED],
    }],

    functions: {
      async 'lighting.set'(call) {
        const on = booleanArgument(call.arguments, 'lighting.set');

        // The coordinator authorizes every application operation. The relay
        // proved who is calling; deciding whether they may is this line's job.
        if (call.source.kind !== 'user' || call.source.id !== options.ownerUserId) {
          throw new ApplicationCallError(2003, 'Only the owner may drive the lights');
        }

        await options.setLight(on);
        await options.onLightChanged(on);
        return { on };
      },
    },
  };
}
