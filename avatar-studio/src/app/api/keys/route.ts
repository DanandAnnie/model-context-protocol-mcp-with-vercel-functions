import { z } from "zod";
import { KEY_LIFETIMES, createApiKey, listApiKeys, type KeyLifetime } from "@/lib/api-keys";
import { errorResponse, json, readJson } from "@/lib/api-utils";
import { ValidationError } from "@/lib/errors";
import { API_KEY_ACCESS } from "@/lib/types";
import { currentUser, presentedApiKey, requireEditor, requireOwner } from "@/lib/owner";
import { recordActivity } from "@/lib/services";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().trim().min(1).max(60),
  /** Days until the key stops working: 30, 90, or 365; left out, it never expires. */
  expiresInDays: z
    .number()
    .int()
    .refine((n): n is KeyLifetime => (KEY_LIFETIMES as readonly number[]).includes(n), { message: `expiresInDays must be ${KEY_LIFETIMES.join(", ")}, or left out for a key that never expires` })
    .optional(),
  /** "read" for a key that may only list and fetch; left out, the key has full access. */
  access: z.enum(API_KEY_ACCESS, { error: `access must be ${API_KEY_ACCESS.join(" or ")}, or left out for full access` }).optional(),
});

export async function GET() {
  try {
    return json({ keys: await listApiKeys(await requireOwner()) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Creates a key. Only a signed-in session may mint keys, never another key. */
export async function POST(req: Request) {
  try {
    if (await presentedApiKey()) return json({ error: "Sign in to create API keys" }, { status: 403 });
    const [owner, user] = await Promise.all([requireEditor(), currentUser()]);
    const { name, expiresInDays, access } = createSchema.parse(await readJson(req));
    try {
      const created = await createApiKey(name, owner, user.id, expiresInDays as KeyLifetime | undefined, access);
      await recordActivity(owner, user, "apikey.created", { subject: name, subjectId: created.key.id });
      return json(created, { status: 201 });
    } catch (e) {
      throw new ValidationError(e instanceof Error ? e.message : "Could not create the key");
    }
  } catch (err) {
    return errorResponse(err);
  }
}
