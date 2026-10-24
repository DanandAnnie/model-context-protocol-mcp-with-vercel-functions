import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { ConflictError, ForbiddenError, LimitError, NotFoundError, UnauthorizedError, ValidationError } from "./errors";

export function json<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export function errorResponse(err: unknown) {
  if (err instanceof ZodError) {
    return NextResponse.json({ error: "Invalid request", issues: err.issues }, { status: 400 });
  }
  if (err instanceof ValidationError) return NextResponse.json({ error: err.message }, { status: 400 });
  if (err instanceof UnauthorizedError) return NextResponse.json({ error: err.message }, { status: 401 });
  if (err instanceof ForbiddenError) return NextResponse.json({ error: err.message }, { status: 403 });
  if (err instanceof LimitError) return NextResponse.json({ error: err.message }, { status: 429 });
  if (err instanceof ConflictError) return NextResponse.json({ error: err.message }, { status: 409 });
  if (err instanceof NotFoundError) return NextResponse.json({ error: err.message }, { status: 404 });
  console.error(err);
  const message = err instanceof Error ? err.message : "Unexpected error";
  return NextResponse.json({ error: message }, { status: 500 });
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new ValidationError("Request body must be JSON");
  }
}
