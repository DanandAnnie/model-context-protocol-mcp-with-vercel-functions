import { z } from "zod";
import { createApiKey, listApiKeys } from "@/lib/api-keys";
import { errorResponse, json, readJson } from "@/lib/api-utils";
import { ValidationError } from "@/lib/errors";
import { currentUser, presentedApiKey, requireOwner } from "@/lib/owner";
import { recordActivity } from "@/lib/services";

export const dynamic = "force-dynamic";

const createSchema = z.object({ name: z.string().trim().min(1).max(60) });

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
    const [owner, user] = await Promise.all([requireOwner(), currentUser()]);
    const { name } = createSchema.parse(await readJson(req));
    try {
      const created = await createApiKey(name, owner, user.id);
      await recordActivity(owner, user, "apikey.created", { subject: name, subjectId: created.key.id });
      return json(created, { status: 201 });
    } catch (e) {
      throw new ValidationError(e instanceof Error ? e.message : "Could not create the key");
    }
  } catch (err) {
    return errorResponse(err);
  }
}
