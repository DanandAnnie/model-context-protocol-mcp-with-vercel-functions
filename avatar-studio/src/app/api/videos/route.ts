import { errorResponse, json, readJson } from "@/lib/api-utils";
import { recordRequestActivity } from "@/lib/activity-request";
import { requireOwner } from "@/lib/owner";
import { createVideo, queryVideos, videoQuerySchema, videoRequestSchema } from "@/lib/services";

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
    if (video.status === "failed") return json({ video, error: video.error ?? "The render could not be started" }, { status: 502 });
    await recordRequestActivity(owner, "video.created", { subject: video.title, subjectId: video.id });
    return json({ video }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
