export class NotFoundError extends Error {}
export class ValidationError extends Error {}
export class UnauthorizedError extends Error {}
/** A usage allowance was exhausted (HTTP 429). */
export class LimitError extends Error {}
