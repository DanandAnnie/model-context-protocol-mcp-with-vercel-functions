export class NotFoundError extends Error {}
export class ValidationError extends Error {}
export class UnauthorizedError extends Error {}
/** Signed in, but not allowed to do this (HTTP 403). */
export class ForbiddenError extends Error {}
/** A usage allowance was exhausted (HTTP 429). */
export class LimitError extends Error {}
/** The item is in a state that does not allow the action (HTTP 409). */
export class ConflictError extends Error {}
