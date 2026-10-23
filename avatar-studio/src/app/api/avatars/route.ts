import { errorResponse, json, readJson } from "@/lib/api-utils";
import { createAvatar, createAvatarSchema, listAvatars } from "@/lib/services";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return json({ avatars: await listAvatars() });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const input = createAvatarSchema.parse(await readJson(req));
    return json({ avatar: await createAvatar(input) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
