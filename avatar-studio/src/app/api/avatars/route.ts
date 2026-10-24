import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor, requireOwner } from "@/lib/owner";
import { createAvatar, createAvatarSchema, listAvatars } from "@/lib/services";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return json({ avatars: await listAvatars(await requireOwner()) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const owner = await requireEditor();
    const input = createAvatarSchema.parse(await readJson(req));
    return json({ avatar: await createAvatar(input, owner) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
