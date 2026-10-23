import { z } from "zod";
import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireOwner } from "@/lib/owner";
import { clientIp } from "@/lib/rate-limit";
import { getAvatar } from "@/lib/services";
import { openLiveSession } from "@/lib/streaming";

export const dynamic = "force-dynamic";

/** Owner's interactive page: open a live video session for a presenter. `{ available: false }` in demo mode. */
export async function POST(req: Request) {
  try {
    const owner = await requireOwner();
    const { avatarId, voiceId } = z.object({ avatarId: z.string().min(1), voiceId: z.string().optional() }).parse(await readJson(req));
    await getAvatar(avatarId, owner);
    const session = await openLiveSession({ avatarId, voiceId, scope: `owner:${owner}`, clientKey: `${owner}:${clientIp(req)}` });
    return json(session ? { available: true, ...session } : { available: false });
  } catch (err) {
    return errorResponse(err);
  }
}
