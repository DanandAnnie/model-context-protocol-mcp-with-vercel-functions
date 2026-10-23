import { errorResponse, json, readJson } from "@/lib/api-utils";
import { createVideo, listVideos, videoRequestSchema } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    return json({ videos: await listVideos() });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const input = videoRequestSchema.parse(await readJson(req));
    const video = await createVideo(input);
    if (video.status === "failed") return json({ video, error: video.error ?? "The render could not be started" }, { status: 502 });
    return json({ video }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
