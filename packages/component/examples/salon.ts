/**
 * A complete home component, small enough to read in one sitting.
 *
 * Bundle it to the single classic Worker program the runtime loads, then let
 * the CLI check it before publishing:
 *
 * ```bash
 * bun build examples/salon.ts --format=iife --minify --outfile dist/component.js
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
      failure = error instanceof Error ? error.message : 'La commande a échoué';
    } finally {
      pending = false;
      home.invalidate();
    }
  }

  return {
    render: () => {
      const on = asBoolean(home.state.get('zone.salon.light.on'));
      const temperature = asNumber(home.state.get('climate.salon.temperature'), 0);

      return ui.screen({ title: 'Salon' }, [
        ui.section({ id: 'lights', heading: 'Lumières' }, [
          ui.toggle({
            id: 'salon-light',
            label: 'Lampe du salon',
            value: on,
            pending,
            onChange: (next) => void setLight(next),
          }),
          ui.status({
            id: 'light-status',
            label: 'État',
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
        ui.section({ id: 'climate', heading: 'Climat' }, [
          ui.text({
            id: 'temperature',
            text: `${temperature.toFixed(1)} °C`,
            emphasis: 'strong',
          }),
          ui.text({
            id: 'temperature-note',
            text: home.state.stale
              ? 'Valeur peut-être périmée, en attente d’un instantané.'
              : `Relevé à la révision ${home.state.revision}.`,
            tone: home.state.stale ? 'warning' : 'muted',
          }),
        ]),
      ]);
    },
  };
});
