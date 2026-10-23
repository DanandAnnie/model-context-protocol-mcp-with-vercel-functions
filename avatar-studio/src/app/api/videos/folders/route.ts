import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireOwner } from "@/lib/owner";
import { folderRenameSchema, renameFolder } from "@/lib/services";

export const dynamic = "force-dynamic";

/** Renames a library folder, or removes it (empty `to`) leaving its videos unfiled. */
export async function POST(req: Request) {
  try {
    const owner = await requireOwner();
    return json(await renameFolder(folderRenameSchema.parse(await readJson(req)), owner));
  } catch (err) {
    return errorResponse(err);
  }
}
