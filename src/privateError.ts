/**
 * Fixed public error representation for protected API operations.
 * @packageDocumentation
 */

/** Errors crossing the private API boundary must never include upstream data. */
export class PrivateError extends Error {
  /** Initialize this error or state owner with the supplied context. */
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}
