/**
 * The interface your household sees.
 *
 * It runs in a sandboxed Worker with no network and no DOM. It reads the state
 * the coordinator granted, calls the function the coordinator declared, and
 * renders a semantic tree the trusted host draws with its own components.
 *
 * Every path and name used here must also appear in `miakapp.yaml`.
 */
import { defineComponent, ui, type StructuredValue } from '@miakapp/component';

const LIGHT_ON = 'zone.living_room.light.on';
const TEMPERATURE = 'climate.living_room.temperature';
const HEALTH = 'service.coordinator.health';
const LIGHT_CHANGED = 'zone.living_room.light.changed';

function asBoolean(value: StructuredValue | undefined): boolean {
  return value === true;
}

function asNumber(value: StructuredValue | undefined): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

defineComponent((home) => {
  let pending = false;
  let failure: string | undefined;

  home.events.subscribe(LIGHT_CHANGED, () => {
    // The state snapshot is the authority; the event only tells us to look.
    failure = undefined;
  });

  async function setLight(on: boolean): Promise<void> {
    pending = true;
    failure = undefined;
    home.invalidate();
    try {
      await home.call('lighting.set', { on }, { deadlineMs: 10_000 });
    } catch (error) {
      // Deliberately not retried. The call may already have reached the lamp,
      // and the next state snapshot settles the question.
      failure = error instanceof Error ? error.message : 'The command failed';
    } finally {
      pending = false;
      home.invalidate();
    }
  }

  function lightState(): 'stale' | 'failed' | 'pending' | 'applied' {
    if (home.state.stale) return 'stale';
    if (failure !== undefined) return 'failed';
    return pending ? 'pending' : 'applied';
  }

  return {
    render: () => {
      const temperature = asNumber(home.state.get(TEMPERATURE));
      const healthy = home.state.get(HEALTH) === 'healthy';

      return ui.screen({ title: 'Living room' }, [
        ui.section({ id: 'lights', heading: 'Lights' }, [
          ui.toggle({
            id: 'living-room-light',
            label: 'Living-room lamp',
            value: asBoolean(home.state.get(LIGHT_ON)),
            disabled: home.staging || !healthy,
            pending,
            onChange: (next) => void setLight(next),
          }),
          ui.status({
            id: 'light-status',
            label: 'Status',
            state: lightState(),
            ...(failure === undefined ? {} : { detail: failure }),
          }),
        ]),

        ui.section({ id: 'climate', heading: 'Climate' }, [
          temperature === undefined
            ? ui.text({ id: 'temperature', text: 'Temperature unavailable', tone: 'muted' })
            : ui.text({
              id: 'temperature',
              text: `${temperature.toFixed(1)} °C`,
              emphasis: 'strong',
            }),
          ui.text({
            id: 'temperature-note',
            text: home.state.stale
              ? 'Value may be stale; waiting for a snapshot.'
              : `Reading at revision ${home.state.revision}.`,
            tone: home.state.stale ? 'warning' : 'muted',
          }),
        ]),

        ...(home.staging
          ? [ui.text({
            id: 'staging-note',
            text: 'Pre-activation version: display works; controls do not.',
            tone: 'warning',
          })]
          : []),
      ]);
    },
  };
});
