/** Exit codes. Every non-zero exit prints one line on stderr; stdout stays clean. */
export const EXIT = {
  ok: 0,
  /** `gate`: the edit or document is blocked. */
  blocked: 1,
  /** Bad arguments, unknown command, or a command that is not implemented yet. */
  usage: 2,
  /** Unknown file or document session. */
  notFound: 3,
  /** The daemon could not be reached or started. */
  unreachable: 4,
  /** The daemon rejected the request. */
  failure: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: ExitCode,
  ) {
    super(message);
  }
}

export const usageError = (message: string) => new CliError(message, EXIT.usage);

/** Network-level failure talking to the daemon (refused, reset, timed out). Retryable. */
export class UnreachableError extends CliError {
  constructor(message: string) {
    super(message, EXIT.unreachable);
  }
}

/** The daemon answered with a non-2xx status. */
export class ApiRequestError extends CliError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message, status === 404 ? EXIT.notFound : EXIT.failure);
  }
}
