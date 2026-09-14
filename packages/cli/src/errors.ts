/**
 * Deterministic CLI outcomes.
 *
 * An agent drives this tool without reading prose, so every failure maps to
 * exactly one stable exit code and one stable machine-readable kind. New kinds
 * may be added; existing codes never change meaning.
 */
export const EXIT_CODE = {
  success: 0,
  usage: 1,
  project: 2,
  artifact: 3,
  authorization: 4,
  contract: 5,
  conflict: 6,
  unknown_outcome: 7,
} as const;

export type CliFailureKind = Exclude<keyof typeof EXIT_CODE, 'success'>;

/**
 * `unknown_outcome` is reserved for a request whose effect on the control plane
 * is undetermined. The caller must reconcile with a read before acting again;
 * it must never blindly retry with a new capability.
 */
export class CliError extends Error {
  readonly kind: CliFailureKind;
  readonly exitCode: number;
  readonly remedy: string | undefined;

  constructor(kind: CliFailureKind, message: string, remedy?: string) {
    super(message);
    this.name = 'MiakappCliError';
    this.kind = kind;
    this.exitCode = EXIT_CODE[kind];
    this.remedy = remedy;
  }
}

export function usageError(message: string, remedy?: string): CliError {
  return new CliError('usage', message, remedy);
}

export function projectError(message: string, remedy?: string): CliError {
  return new CliError('project', message, remedy);
}

export function artifactError(message: string, remedy?: string): CliError {
  return new CliError('artifact', message, remedy);
}

export function authorizationError(message: string, remedy?: string): CliError {
  return new CliError('authorization', message, remedy);
}

export function contractError(message: string, remedy?: string): CliError {
  return new CliError('contract', message, remedy);
}

export function conflictError(message: string, remedy?: string): CliError {
  return new CliError('conflict', message, remedy);
}

export function unknownOutcomeError(message: string, remedy: string): CliError {
  return new CliError('unknown_outcome', message, remedy);
}
