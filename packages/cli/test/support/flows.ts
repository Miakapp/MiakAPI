import { MemoryFiles } from './host.js';

export const FLOWS_PATH = '/home/tester/node-red/flows.json';

/**
 * A synthetic V3 house, written to exercise every branch of the inventory: two
 * tabs of which one is disabled, one broker without TLS, a device topic beside a
 * wildcard subscription, a coordinator secret sitting in the export, variables
 * committed from all three value types, an action restricted to a group beside
 * one restricted to nobody, and node types the inventory does not model.
 *
 * Field names follow the two real schemas: Node-RED core `mqtt in`, `mqtt out`
 * and `mqtt-broker`, and the `node-red-contrib-MiakAPI` v3 nodes.
 */
export const FLOWS_EXPORT = JSON.stringify([
  { id: 't1', type: 'tab', label: 'Living room' },
  { id: 't2', type: 'tab', label: 'Heating', disabled: true },
  {
    id: 'b1',
    type: 'mqtt-broker',
    name: 'home',
    broker: '192.168.1.10',
    port: '1883',
    usetls: false,
    cleansession: true,
  },
  {
    id: 'i1',
    type: 'initMiakapi',
    z: 't1',
    home: 'sample-home',
    coordID: 'coord-1',
    coordSecret: 's3cr3t-in-the-file',
  },
  { id: 'm1', type: 'mqtt in', z: 't1', broker: 'b1', topic: 'home/living-room/temperature', qos: '2' },
  { id: 'm2', type: 'mqtt in', z: 't1', broker: 'b1', topic: 'home/living-room/#', qos: '0' },
  { id: 'm3', type: 'mqtt out', z: 't1', broker: 'b1', topic: 'home/living-room/lamp/set', retain: '' },
  {
    id: 'cv1',
    type: 'commitVariables',
    z: 't1',
    name: 'Living room',
    values: {
      'living_room.temperature': { type: 'jsonata', value: 'payload.temp' },
      'living_room.lamp.on': { type: 'str', value: 'false' },
      'living_room/humidity': { type: 'str', value: '0' },
    },
  },
  { id: 'a1', type: 'onUserAction', z: 't2', inputID: 'living_room.lamp.toggle', allowedGroups: [] },
  {
    id: 'a2',
    type: 'onUserAction',
    z: 't2',
    inputID: 'heating.set',
    allowedGroups: ['adults'],
  },
  {
    id: 'cv2',
    type: 'commitVariables',
    z: 't2',
    values: {
      'heating.setpoint': { type: 'env', value: 'DEFAULT_SETPOINT' },
      'living_room.*.on': { type: 'str', value: 'false' },
    },
  },
  { id: 'n1', type: 'sendPushNotif', z: 't2', title: 'Alert', body: 'x', adminOnly: true },
  { id: 'f1', type: 'function', z: 't2', func: 'return msg;' },
  { id: 'f2', type: 'function', z: 't2', func: 'return msg;' },
  { id: 'inj1', type: 'inject', z: 't2', repeat: '60' },
]);

export function flowsProject(): MemoryFiles {
  return new MemoryFiles({ [FLOWS_PATH]: FLOWS_EXPORT });
}
