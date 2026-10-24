import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireOwner, userOrOwner } from "@/lib/owner";
import { createVideo, queryVideos, recordActivity, videoQuerySchema, videoRequestSchema } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  try {
    const owner = await requireOwner();
    const query = videoQuerySchema.parse(Object.fromEntries(new URL(req.url).searchParams));
    return json(await queryVideos(owner, query));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const owner = await requireOwner();
    const input = videoRequestSchema.parse(await readJson(req));
    const video = await createVideo(input, owner);
    await recordActivity(owner, await userOrOwner(owner), "video.created", { subject: video.title, subjectId: video.id });
    if (video.status === "failed") return json({ video, error: video.error ?? "The render could not be started" }, { status: 502 });
    return json({ video }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
