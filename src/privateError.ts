/** Errors crossing the private API boundary must never include upstream data. */
export class PrivateError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}
