import { errorResponse, json, readJson } from "@/lib/api-utils";
import { recordRequestActivity } from "@/lib/activity-request";
import { requireEditor } from "@/lib/owner";
import { describeReplaced } from "@/lib/presenters";
import { getAvatar, listVoices, replaceUses, replaceUsesSchema } from "@/lib/services";

export const dynamic = "force-dynamic";

/**
 * Switches every interactive presenter, saved template (and its scenes), the brand kit's default, and (for a voice)
 * every photo avatar's default voice from one presenter or voice to another. Editors only; videos are not changed.
 * A replace that changed something is recorded in the activity feed, with both names.
 */
export async function POST(req: Request) {
  try {
    const owner = await requireEditor();
    const input = replaceUsesSchema.parse(await readJson(req));
    const replaced = await replaceUses(input, owner);
    if (describeReplaced(replaced)) {
      // A name that cannot be found (the old one deleted already, say) is left out: the feed then says "a deleted presenter".
      const nameOf = async (id: string): Promise<string | undefined> => {
        try {
          return input.kind === "avatar" ? (await getAvatar(id, owner)).name : (await listVoices(owner)).find((v) => v.id === id)?.name;
        } catch {
          return undefined;
        }
      };
      const [from, to] = await Promise.all([nameOf(input.from), nameOf(input.to)]);
      await recordRequestActivity(owner, "usage.replaced", { subject: from, subjectId: input.from, replacement: to, replaced: { kind: input.kind, ...replaced } });
    }
    return json({ replaced });
  } catch (err) {
    return errorResponse(err);
  }
}
