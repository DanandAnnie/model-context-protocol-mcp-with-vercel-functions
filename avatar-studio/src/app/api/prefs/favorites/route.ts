import { errorResponse, json, readJson } from "@/lib/api-utils";
import { favoriteSchema, toggleFavorite } from "@/lib/notifications";
import { requireOwner } from "@/lib/owner";

export const dynamic = "force-dynamic";

/** Star or unstar an avatar or voice: `{ kind: "avatar" | "voice", id, on }` → the owner's preferences. */
export async function POST(req: Request) {
  try {
    const owner = await requireOwner();
    return json({ prefs: await toggleFavorite(favoriteSchema.parse(await readJson(req)), owner) });
  } catch (err) {
    return errorResponse(err);
  }
}
