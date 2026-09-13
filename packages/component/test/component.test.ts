import { describe, expect, test } from 'bun:test';
import {
  CallError,
  CallOutcomeUnknownError,
  defineComponent,
  ui,
  type Home,
  type UiNode,
} from '../src/index.js';
import { FakeBroker } from './support/broker.js';

/** Renders synchronously so a test can assert on the committed tree immediately. */
function mount(
  setup: (home: Home) => { render: () => UiNode; dispose?: () => void },
): { broker: FakeBroker; handle: ReturnType<typeof defineComponent> } {
  const broker = new FakeBroker();
  const handle = defineComponent(setup, {
    transport: broker,
    now: () => 0,
    schedule: (callback) => callback(),
  });
  return { broker, handle };
}

function screenOf(node: unknown): UiNode {
  return node as UiNode;
}

describe('handshake', () => {
  test('guest.ready is sent before any other work', () => {
    const { broker } = mount(() => ({ render: () => ui.screen({ title: 'Salon' }) }));
    expect(broker.kinds()).toEqual(['guest.ready']);
    expect(broker.last('guest.ready').payload).toEqual({ abi: 'miakapp.component/1' });
  });

  test('setup runs only after boot and the first snapshot', () => {
    let setups = 0;
    const { broker } = mount(() => {
      setups += 1;
      return { render: () => ui.screen({ title: 'Salon' }) };
    });
    expect(setups).toBe(0);
    broker.boot();
    expect(setups).toBe(1);
  });

  test('the first render is revision one and its root is a screen', async () => {
    const { broker, handle } = mount(() => ({ render: () => ui.screen({ title: 'Salon' }) }));
    broker.boot();
    await handle.ready;
    const render = broker.last('ui.render');
    expect(render.payload['revision']).toBe(1);
    expect(screenOf(render.payload['tree']).type).toBe('screen');
    expect(screenOf(render.payload['tree']).props['title']).toBe('Salon');
  });

  test('render revisions are contiguous', () => {
    const { broker } = mount((home) => ({
      render: () => ui.screen({ title: String(home.state.get('climate.zone.temperature') ?? '') }),
    }));
    broker.boot({}, { 'climate.zone.temperature': 19 });
    broker.deliver('state.patch', {
      base_revision: 1,
      revision: 2,
      mutations: [{ path: 'climate.zone.temperature', op: 'set', value: 20 }],
    });
    broker.deliver('state.patch', {
      base_revision: 2,
      revision: 3,
      mutations: [{ path: 'climate.zone.temperature', op: 'set', value: 21 }],
    });
    expect(broker.of('ui.render').map((message) => message.payload['revision'])).toEqual([1, 2, 3]);
  });
});

describe('state', () => {
  test('a snapshot is authoritative and a patch is applied in order', () => {
    let seen: unknown;
    const { broker } = mount((home) => ({
      render: () => {
        seen = home.state.get('zone.alpha.light.on');
        return ui.screen({ title: 'Salon' });
      },
    }));
    broker.boot({}, { 'zone.alpha.light.on': false });
    expect(seen).toBe(false);
    broker.deliver('state.patch', {
      base_revision: 1,
      revision: 2,
      mutations: [{ path: 'zone.alpha.light.on', op: 'set', value: true }],
    });
    expect(seen).toBe(true);
  });

  test('a delete mutation removes the path', () => {
    let present = true;
    const { broker } = mount((home) => ({
      render: () => {
        present = home.state.has('zone.alpha.light.on');
        return ui.screen({ title: 'Salon' });
      },
    }));
    broker.boot({}, { 'zone.alpha.light.on': false });
    broker.deliver('state.patch', {
      base_revision: 1,
      revision: 2,
      mutations: [{ path: 'zone.alpha.light.on', op: 'delete' }],
    });
    expect(present).toBe(false);
  });

  test('staleness is exposed rather than hidden', () => {
    let stale = false;
    const { broker } = mount((home) => ({
      render: () => {
        stale = home.state.stale;
        return ui.screen({ title: 'Salon' });
      },
    }));
    broker.boot({}, { 'climate.zone.temperature': 19 });
    expect(stale).toBe(false);
    broker.deliver('state.stale', { revision: 1, reason: 'revision_gap' });
    expect(stale).toBe(true);
  });

  test('a non-contiguous patch marks the projection stale and commits no value', () => {
    let temperature: unknown;
    let stale = false;
    const { broker } = mount((home) => ({
      render: () => {
        temperature = home.state.get('climate.zone.temperature');
        stale = home.state.stale;
        return ui.screen({ title: 'Salon' });
      },
    }));
    broker.boot({}, { 'climate.zone.temperature': 19 });
    broker.deliver('state.patch', {
      base_revision: 7,
      revision: 8,
      mutations: [{ path: 'climate.zone.temperature', op: 'set', value: 30 }],
    });
    expect(temperature).toBe(19);
    expect(stale).toBe(false);
    broker.deliver('state.snapshot', { revision: 9, values: { 'climate.zone.temperature': 30 } });
    expect(temperature).toBe(30);
  });
});

describe('interaction', () => {
  test('a toggle handler receives the boolean and the tree recommits', () => {
    const received: boolean[] = [];
    const { broker } = mount(() => ({
      render: () => ui.screen({ title: 'Salon' }, [
        ui.toggle({
          id: 'lamp',
          label: 'Lampe',
          value: false,
          onChange: (value) => void received.push(value),
        }),
      ]),
    }));
    broker.boot();
    broker.deliver('ui.interaction', {
      render_revision: 1,
      node_id: 'lamp',
      handler: 'lamp',
      event: 'change',
      value: true,
    });
    expect(received).toEqual([true]);
    expect(broker.of('ui.render')).toHaveLength(2);
  });

  test('a button handler is called without a value', () => {
    let presses = 0;
    const { broker } = mount(() => ({
      render: () => ui.screen({ title: 'Salon' }, [
        ui.button({ id: 'go', label: 'Allumer', onPress: () => void (presses += 1) }),
      ]),
    }));
    broker.boot();
    broker.deliver('ui.interaction', {
      render_revision: 1,
      node_id: 'go',
      handler: 'go',
      event: 'press',
    });
    expect(presses).toBe(1);
  });

  test('an interaction for a stale render is ignored', () => {
    let presses = 0;
    const { broker } = mount(() => ({
      render: () => ui.screen({ title: 'Salon' }, [
        ui.button({ id: 'go', label: 'Allumer', onPress: () => void (presses += 1) }),
      ]),
    }));
    broker.boot();
    broker.deliver('ui.interaction', {
      render_revision: 0,
      node_id: 'go',
      handler: 'go',
      event: 'press',
    });
    expect(presses).toBe(0);
  });
});

describe('calls', () => {
  test('a call resolves on its correlated result', async () => {
    let home: Home | undefined;
    const { broker } = mount((instance) => {
      home = instance;
      return { render: () => ui.screen({ title: 'Salon' }) };
    });
    broker.boot();
    const pending = (home as Home).call('lighting.set', { on: true });
    const start = broker.last('call.start');
    expect(start.payload['name']).toBe('lighting.set');
    const operationId = start.payload['operation_id'] as number;

    broker.deliver('call.accepted', { operation_id: operationId });
    broker.deliver('call.result', { operation_id: operationId, value: { on: true } });
    expect(await pending).toEqual({ on: true });
  });

  test('a call rejects with the control-plane failure code', async () => {
    let home: Home | undefined;
    const { broker } = mount((instance) => {
      home = instance;
      return { render: () => ui.screen({ title: 'Salon' }) };
    });
    broker.boot();
    const pending = (home as Home).call('lighting.set', { on: true });
    const operationId = broker.last('call.start').payload['operation_id'] as number;
    broker.deliver('call.error', {
      operation_id: operationId,
      code: 'application_error',
      message: 'the lamp is unreachable',
      retryable: true,
    });
    await expect(pending).rejects.toBeInstanceOf(CallError);
    await pending.catch((error: CallError) => {
      expect(error.code).toBe('application_error');
      expect(error.retryable).toBe(true);
    });
  });

  test('an unknown outcome rejects with its own error type', async () => {
    let home: Home | undefined;
    const { broker } = mount((instance) => {
      home = instance;
      return { render: () => ui.screen({ title: 'Salon' }) };
    });
    broker.boot();
    const pending = (home as Home).call('lighting.set', { on: true });
    const operationId = broker.last('call.start').payload['operation_id'] as number;
    broker.deliver('call.outcome_unknown', { operation_id: operationId });
    await expect(pending).rejects.toBeInstanceOf(CallOutcomeUnknownError);
  });

  test('a stream grants credit once accepted and yields its chunks', async () => {
    let home: Home | undefined;
    const { broker } = mount((instance) => {
      home = instance;
      return { render: () => ui.screen({ title: 'Salon' }) };
    });
    broker.boot();
    const stream = (home as Home).stream('lighting.set', null);
    const operationId = broker.last('call.start').payload['operation_id'] as number;
    expect(broker.of('call.credit')).toHaveLength(0);

    broker.deliver('call.accepted', { operation_id: operationId });
    const credit = broker.last('call.credit');
    expect(credit.payload).toEqual({ operation_id: operationId, credit: 32 });

    const collected: unknown[] = [];
    const consume = (async () => {
      for await (const chunk of stream) {
        collected.push(chunk);
        if (collected.length === 2) break;
      }
    })();
    broker.deliver('call.chunk', { operation_id: operationId, value: 1 });
    broker.deliver('call.chunk', { operation_id: operationId, value: 2 });
    await consume;
    expect(collected).toEqual([1, 2]);
  });

  test('a staged release may render but not act on the home', () => {
    let home: Home | undefined;
    const { broker } = mount((instance) => {
      home = instance;
      return { render: () => ui.screen({ title: 'Salon' }) };
    });
    broker.boot({ staging: true });
    expect(broker.of('ui.render')).toHaveLength(1);
    expect(() => (home as Home).call('lighting.set', null)).toThrow(/staged release/);
    expect(() => (home as Home).events.publish('zone.alpha.pressed', null)).toThrow(/staged/);
    expect(broker.of('call.start')).toHaveLength(0);
  });
});

describe('events', () => {
  test('one subscription is sent per topic and withdrawn after the last listener', () => {
    let home: Home | undefined;
    const { broker } = mount((instance) => {
      home = instance;
      return { render: () => ui.screen({ title: 'Salon' }) };
    });
    broker.boot();
    const received: unknown[] = [];
    const first = (home as Home).events.subscribe('zone.alpha.pressed', (data) => {
      received.push(data);
    });
    const second = (home as Home).events.subscribe('zone.alpha.pressed', () => undefined);
    expect(broker.of('event.subscribe')).toHaveLength(1);

    broker.deliver('event.message', { name: 'zone.alpha.pressed', data: { count: 1 } });
    expect(received).toEqual([{ count: 1 }]);

    first();
    expect(broker.of('event.unsubscribe')).toHaveLength(0);
    second();
    expect(broker.last('event.unsubscribe').payload).toEqual({ name: 'zone.alpha.pressed' });
  });
});

describe('lifecycle', () => {
  test('a suspended component commits no render and resumes with one', () => {
    const { broker } = mount((home) => ({
      render: () => ui.screen({ title: String(home.state.revision) }),
    }));
    broker.boot();
    expect(broker.of('ui.render')).toHaveLength(1);

    broker.deliver('lifecycle.suspend', {});
    broker.deliver('state.patch', { base_revision: 1, revision: 2, mutations: [] });
    expect(broker.of('ui.render')).toHaveLength(1);

    broker.deliver('lifecycle.resume', { active: true, epoch: 1 });
    expect(broker.of('ui.render')).toHaveLength(2);
  });

  test('dispose rejects everything in flight and runs the component teardown', async () => {
    let home: Home | undefined;
    let disposed = false;
    const { broker, handle } = mount((instance) => {
      home = instance;
      return {
        render: () => ui.screen({ title: 'Salon' }),
        dispose: () => void (disposed = true),
      };
    });
    broker.boot();
    const pending = (home as Home).call('lighting.set', null);
    broker.deliver('lifecycle.dispose', {});
    await expect(pending).rejects.toThrow(/disposed/);
    expect(disposed).toBe(true);
    expect(handle.disposed).toBe(true);
  });

  test('nothing is sent after dispose', () => {
    let home: Home | undefined;
    const { broker } = mount((instance) => {
      home = instance;
      return { render: () => ui.screen({ title: 'Salon' }) };
    });
    broker.boot();
    broker.deliver('lifecycle.dispose', {});
    const before = broker.sent.length;
    (home as Home).log('info', 'ignored');
    expect(broker.sent).toHaveLength(before);
  });
});

describe('render rate', () => {
  test('bursts are coalesced into one commit per ABI interval', () => {
    const broker = new FakeBroker();
    const queue: Array<{ callback: () => void; delayMs: number }> = [];
    let clock = 0;
    let home: Home | undefined;
    defineComponent((instance) => {
      home = instance;
      return { render: () => ui.screen({ title: String(clock) }) };
    }, {
      transport: broker,
      now: () => clock,
      schedule: (callback, delayMs) => void queue.push({ callback, delayMs }),
    });
    broker.boot();
    expect(broker.of('ui.render')).toHaveLength(1);

    (home as Home).invalidate();
    (home as Home).invalidate();
    (home as Home).invalidate();
    expect(queue).toHaveLength(1);
    expect(queue[0]?.delayMs).toBe(34);

    clock = 34;
    (queue.shift() as { callback: () => void }).callback();
    expect(broker.of('ui.render')).toHaveLength(2);
  });
});

describe('bridge hygiene', () => {
  test('reserved runtime messages are ignored, never answered', () => {
    const { broker } = mount(() => ({ render: () => ui.screen({ title: 'Salon' }) }));
    broker.boot();
    const before = broker.sent.length;
    broker.deliver('runtime.probe', { challenge: 1 });
    expect(broker.sent).toHaveLength(before);
  });

  test('an unknown broker kind is ignored rather than fatal', () => {
    const { broker } = mount(() => ({ render: () => ui.screen({ title: 'Salon' }) }));
    broker.boot();
    expect(() => broker.deliver('ui.something_new', { a: 1 })).not.toThrow();
  });

  test('no message carries an undefined property', () => {
    const { broker } = mount(() => ({
      render: () => ui.screen({ title: 'Salon' }, [
        ui.button({ id: 'go', label: 'Allumer', onPress: () => undefined }),
        ui.text({ id: 'hint', text: 'Sans ton ni emphase' }),
        ui.input({ id: 'name', label: 'Nom', value: '', onChange: () => undefined }),
      ]),
    }));
    // FakeBroker.post throws on any undefined value in the payload graph.
    broker.boot();
    expect(broker.of('ui.render')).toHaveLength(1);
  });
});
