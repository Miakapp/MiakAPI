/**
 * Typed builders for the ABI 1 semantic tree.
 *
 * The broker validates every node against a closed schema, so these builders
 * exist to make the legal tree the easy one to write: exact property names,
 * closed token enums in the type system, and no way to emit a key the broker
 * would reject. Two rules are enforced here rather than left to the broker,
 * because breaking them terminates the instance instead of returning an error:
 * a property is omitted when it is `undefined` (the bridge forbids `undefined`
 * as a structured value), and node IDs are checked for shape and uniqueness.
 *
 * Everything else is left to the broker on purpose. Duplicating its validation
 * would mean two sources of truth that drift.
 */
import { LIMITS } from './protocol.js';

export type UiNodeType =
  | 'screen'
  | 'stack'
  | 'grid'
  | 'section'
  | 'text'
  | 'status'
  | 'button'
  | 'toggle'
  | 'input'
  | 'select'
  | 'progress'
  | 'media';

export interface UiNode {
  readonly id: string;
  readonly type: UiNodeType;
  readonly props: Readonly<Record<string, unknown>>;
  readonly children?: readonly UiNode[];
}

export type Gap = 'none' | 'small' | 'medium' | 'large';
export type Direction = 'vertical' | 'horizontal';
export type Align = 'start' | 'center' | 'end' | 'stretch';
export type Tone = 'default' | 'muted' | 'positive' | 'warning' | 'critical';
export type Emphasis = 'normal' | 'strong';
export type ButtonVariant = 'primary' | 'secondary' | 'danger';
export type InputType = 'text' | 'number' | 'email' | 'search';
export type StatusState =
  | 'idle'
  | 'pending'
  | 'accepted'
  | 'applied'
  | 'failed'
  | 'stale'
  | 'outcome_unknown';

export type PressHandler = () => void;
export type ToggleHandler = (value: boolean) => void;
export type TextHandler = (value: string) => void;
export type Handler = PressHandler | ToggleHandler | TextHandler;

const NODE_ID = /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/;
const UTF8 = new TextEncoder();

export class UiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MiakappUiError';
  }
}

/**
 * Handlers registered by the render pass currently running.
 *
 * A builder is a pure function, so a callback passed to `ui.button` has to be
 * recorded somewhere the dispatcher can find it. The scope is set for exactly
 * the duration of one render and cleared afterwards, which is safe in a Worker:
 * the guest is single-threaded and a render never awaits.
 */
let activeHandlers: Map<string, Handler> | undefined;

export function collectHandlers<T>(render: () => T): { result: T; handlers: Map<string, Handler> } {
  if (activeHandlers !== undefined) {
    throw new UiError('A render is already in progress; renders must not nest');
  }
  const handlers = new Map<string, Handler>();
  activeHandlers = handlers;
  try {
    return { result: render(), handlers };
  } finally {
    activeHandlers = undefined;
  }
}

function nodeId(id: string): string {
  if (!NODE_ID.test(id)) {
    throw new UiError(
      `Node ID ${JSON.stringify(id)} must match [A-Za-z][A-Za-z0-9._:-]{0,63}`,
    );
  }
  return id;
}

function register(id: string, handler: string | Handler | undefined, label: string): string {
  if (typeof handler === 'string') return nodeId(handler);
  if (handler === undefined) {
    throw new UiError(`${label} ${id} needs a handler callback or a handler ID`);
  }
  if (activeHandlers === undefined) {
    throw new UiError(
      `${label} ${id} passed a handler callback outside a render; `
      + 'build trees inside the component render function',
    );
  }
  activeHandlers.set(id, handler);
  return id;
}

/** Drops `undefined` entries, which the bridge forbids as structured values. */
function props(entries: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function container(
  id: string,
  type: UiNodeType,
  nodeProps: Readonly<Record<string, unknown>>,
  children: readonly UiNode[],
): UiNode {
  return { id: nodeId(id), type, props: nodeProps, children };
}

export interface ScreenProps {
  readonly id?: string;
  readonly title: string;
}

export function screen(options: ScreenProps, children: readonly UiNode[] = []): UiNode {
  return container(options.id ?? 'screen', 'screen', props({ title: options.title }), children);
}

export interface StackProps {
  readonly id: string;
  readonly direction?: Direction;
  readonly gap?: Gap;
  readonly align?: Align;
}

export function stack(options: StackProps, children: readonly UiNode[] = []): UiNode {
  return container(options.id, 'stack', props({
    direction: options.direction,
    gap: options.gap,
    align: options.align,
  }), children);
}

export interface GridProps {
  readonly id: string;
  /** One to six columns; the broker rejects more. */
  readonly columns: number;
  readonly gap?: Gap;
}

export function grid(options: GridProps, children: readonly UiNode[] = []): UiNode {
  return container(options.id, 'grid', props({
    columns: options.columns,
    gap: options.gap,
  }), children);
}

export interface SectionProps {
  readonly id: string;
  readonly heading: string;
  readonly description?: string;
}

export function section(options: SectionProps, children: readonly UiNode[] = []): UiNode {
  return container(options.id, 'section', props({
    heading: options.heading,
    description: options.description,
  }), children);
}

function leaf(
  id: string,
  type: UiNodeType,
  nodeProps: Readonly<Record<string, unknown>>,
): UiNode {
  return { id: nodeId(id), type, props: nodeProps };
}

export interface TextProps {
  readonly id: string;
  readonly text: string;
  readonly tone?: Tone;
  readonly emphasis?: Emphasis;
}

export function text(options: TextProps): UiNode {
  return leaf(options.id, 'text', props({
    text: options.text,
    tone: options.tone,
    emphasis: options.emphasis,
  }));
}

export interface StatusProps {
  readonly id: string;
  readonly label: string;
  readonly state: StatusState;
  readonly detail?: string;
}

export function status(options: StatusProps): UiNode {
  return leaf(options.id, 'status', props({
    label: options.label,
    state: options.state,
    detail: options.detail,
  }));
}

export interface ButtonProps {
  readonly id: string;
  readonly label: string;
  readonly onPress?: PressHandler;
  readonly handler?: string;
  readonly variant?: ButtonVariant;
  readonly disabled?: boolean;
  readonly pending?: boolean;
}

export function button(options: ButtonProps): UiNode {
  const id = nodeId(options.id);
  return leaf(id, 'button', props({
    label: options.label,
    handler: register(id, options.handler ?? options.onPress, 'button'),
    variant: options.variant,
    disabled: options.disabled,
    pending: options.pending,
  }));
}

export interface ToggleProps {
  readonly id: string;
  readonly label: string;
  readonly value: boolean;
  readonly onChange?: ToggleHandler;
  readonly handler?: string;
  readonly disabled?: boolean;
  readonly pending?: boolean;
}

export function toggle(options: ToggleProps): UiNode {
  const id = nodeId(options.id);
  return leaf(id, 'toggle', props({
    label: options.label,
    value: options.value,
    handler: register(id, options.handler ?? options.onChange, 'toggle'),
    disabled: options.disabled,
    pending: options.pending,
  }));
}

export interface InputProps {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange?: TextHandler;
  readonly handler?: string;
  readonly inputType?: InputType;
  readonly maxLength?: number;
  readonly disabled?: boolean;
}

export function input(options: InputProps): UiNode {
  const id = nodeId(options.id);
  return leaf(id, 'input', props({
    label: options.label,
    value: options.value,
    handler: register(id, options.handler ?? options.onChange, 'input'),
    input_type: options.inputType,
    max_length: options.maxLength,
    disabled: options.disabled,
  }));
}

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export interface SelectProps {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly options: readonly SelectOption[];
  readonly onChange?: TextHandler;
  readonly handler?: string;
  readonly disabled?: boolean;
}

export function select(options: SelectProps): UiNode {
  const id = nodeId(options.id);
  return leaf(id, 'select', props({
    label: options.label,
    value: options.value,
    options: options.options.map((option) => ({ value: option.value, label: option.label })),
    handler: register(id, options.handler ?? options.onChange, 'select'),
    disabled: options.disabled,
  }));
}

export interface ProgressProps {
  readonly id: string;
  readonly label: string;
  /** Between 0 and 1 inclusive. */
  readonly value: number;
}

export function progress(options: ProgressProps): UiNode {
  return leaf(options.id, 'progress', props({
    label: options.label,
    value: options.value,
  }));
}

export interface MediaProps {
  readonly id: string;
  readonly label: string;
  /** An exact granted `media.*` handle; ABI 1 has no URL property. */
  readonly handle: string;
}

export function media(options: MediaProps): UiNode {
  return leaf(options.id, 'media', props({
    label: options.label,
    handle: options.handle,
  }));
}

/**
 * Checks the tree-wide invariants a single builder cannot see.
 *
 * These four are the ones whose violation is fatal rather than reportable: the
 * broker terminates the instance instead of answering, so catching them in the
 * Worker turns a dead component into a thrown error the guest can handle.
 */
export function checkTree(root: UiNode): UiNode {
  if (root.type !== 'screen') throw new UiError('The root node must be a screen');
  const seen = new Set<string>();
  let nodes = 0;
  let textBytes = 0;
  const stack: Array<{ node: UiNode; depth: number }> = [{ node: root, depth: 1 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop() as { node: UiNode; depth: number };
    if (depth > LIMITS.uiDepth) {
      throw new UiError(`UI tree is deeper than the ABI 1 limit of ${LIMITS.uiDepth}`);
    }
    nodes += 1;
    if (nodes > LIMITS.uiNodes) {
      throw new UiError(`UI tree has more than the ABI 1 limit of ${LIMITS.uiNodes} nodes`);
    }
    if (seen.has(node.id)) throw new UiError(`Duplicate node ID: ${node.id}`);
    seen.add(node.id);
    for (const key of ['title', 'text', 'label', 'heading', 'description', 'detail']) {
      const value = node.props[key];
      if (typeof value !== 'string') continue;
      const bytes = UTF8.encode(value).byteLength;
      if (bytes > LIMITS.textBytes) {
        throw new UiError(`${node.id}.${key} exceeds ${LIMITS.textBytes} UTF-8 bytes`);
      }
      textBytes += bytes;
    }
    if (textBytes > LIMITS.uiTextBytes) {
      throw new UiError(`Aggregate UI text exceeds ${LIMITS.uiTextBytes} UTF-8 bytes`);
    }
    for (const child of node.children ?? []) stack.push({ node: child, depth: depth + 1 });
  }
  return root;
}
