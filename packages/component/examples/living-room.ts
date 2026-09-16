/**
 * A complete home component, small enough to read in one sitting.
 *
 * Bundle it to the single classic Worker program the runtime loads, then let
 * the CLI check it before publishing:
 *
 * ```bash
 * bun build examples/living-room.ts --format=iife --minify --outfile dist/component.js
 * bunx @miakapp/cli check
 * ```
 *
 * The component reads two granted state paths, calls one granted function and
 * renders one semantic tree. It never touches the network: inside the Worker
 * there is nothing to touch.
 */
import { defineComponent, ui, type StructuredValue } from '@miakapp/component';

function asBoolean(value: StructuredValue | undefined): boolean {
  return value === true;
}

function asNumber(value: StructuredValue | undefined, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

defineComponent((home) => {
  let pending = false;
  let failure: string | undefined;

  async function setLight(on: boolean): Promise<void> {
    pending = true;
    failure = undefined;
    home.invalidate();
    try {
      await home.call('lighting.set', { on }, { deadlineMs: 10_000 });
    } catch (error) {
      // An unknown outcome is deliberately not retried: the home may already
      // have applied it. The next state snapshot is the authority.
      failure = error instanceof Error ? error.message : 'The command failed';
    } finally {
      pending = false;
      home.invalidate();
    }
  }

  return {
    render: () => {
      const on = asBoolean(home.state.get('zone.living_room.light.on'));
      const temperature = asNumber(home.state.get('climate.living_room.temperature'), 0);

      return ui.screen({ title: 'Living room' }, [
        ui.section({ id: 'lights', heading: 'Lights' }, [
          ui.toggle({
            id: 'living-room-light',
            label: 'Living-room lamp',
            value: on,
            pending,
            onChange: (next) => void setLight(next),
          }),
          ui.status({
            id: 'light-status',
            label: 'Status',
            state: home.state.stale
              ? 'stale'
              : failure !== undefined
                ? 'failed'
                : pending
                  ? 'pending'
                  : 'applied',
            ...(failure === undefined ? {} : { detail: failure }),
          }),
        ]),
        ui.section({ id: 'climate', heading: 'Climate' }, [
          ui.text({
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
      ]);
    },
  };
});
