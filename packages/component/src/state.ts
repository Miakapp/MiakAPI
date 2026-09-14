/**
 * The granted state projection, as the broker delivers it.
 *
 * RFC 0002 §12.2 is explicit that the SDK must expose staleness rather than
 * pretend cached values are current, so {@link StateStore.stale} is part of the
 * public surface and every read can be paired with it.
 */
import type {
  StatePatch,
  StateSnapshot,
  StateStale,
  StructuredValue,
} from './protocol.js';

export interface StateView {
  /** Last authoritative revision this component saw. */
  readonly revision: number;
  /**
   * True once a patch gap was reported. Values keep their last known contents
   * until a fresh snapshot arrives; they are not current.
   */
  readonly stale: boolean;
  readonly staleReason: string | undefined;
  get(path: string): StructuredValue | undefined;
  has(path: string): boolean;
  paths(): readonly string[];
  entries(): Readonly<Record<string, StructuredValue>>;
}

export class StateStore implements StateView {
  #values = new Map<string, StructuredValue>();
  #revision = 0;
  #stale = false;
  #staleReason: string | undefined;

  get revision(): number {
    return this.#revision;
  }

  get stale(): boolean {
    return this.#stale;
  }

  get staleReason(): string | undefined {
    return this.#staleReason;
  }

  get(path: string): StructuredValue | undefined {
    return this.#values.get(path);
  }

  has(path: string): boolean {
    return this.#values.has(path);
  }

  paths(): readonly string[] {
    return [...this.#values.keys()].sort();
  }

  entries(): Readonly<Record<string, StructuredValue>> {
    return Object.fromEntries(this.#values);
  }

  /** A snapshot is authoritative: it replaces the projection and clears staleness. */
  applySnapshot(snapshot: StateSnapshot): void {
    this.#values = new Map(Object.entries(snapshot.values));
    this.#revision = snapshot.revision;
    this.#stale = false;
    this.#staleReason = undefined;
  }

  /**
   * Applies one contiguous patch.
   *
   * The broker already refuses to forward a gap, but a guest that applied a
   * non-contiguous patch anyway would silently diverge from the home, so the
   * check is repeated here and a mismatch marks the projection stale instead.
   */
  applyPatch(patch: StatePatch): boolean {
    if (patch.base_revision !== this.#revision || patch.revision !== patch.base_revision + 1) {
      this.#stale = true;
      this.#staleReason = 'revision_gap';
      return false;
    }
    for (const mutation of patch.mutations) {
      if (mutation.op === 'set') this.#values.set(mutation.path, mutation.value);
      else this.#values.delete(mutation.path);
    }
    this.#revision = patch.revision;
    return true;
  }

  markStale(stale: StateStale): void {
    this.#stale = true;
    this.#staleReason = stale.reason;
    if (stale.revision > this.#revision) this.#revision = stale.revision;
  }
}
