import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { rateLimitPair } from "@/lib/rate-limit";
import { LimitError, startTwinUpload, twinKeySchema, twinUploadRequestSchema } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Uploads an account may begin per hour, and every account together; counted per server instance, as the other limits are. */
const PER_OWNER = 20;
const PER_INSTANCE = 80;
const WINDOW_MS = 60 * 60 * 1000;

/**
 * Begin uploading a twin's footage: `{ fileName, contentType, sizeBytes }` → `{ upload: { token, url, headers, expiresAt } }`.
 * The browser PUTs the file to `url` with `headers`, then starts the twin with `{ upload: token }`.
 */
export async function POST(req: Request) {
  try {
    const owner = await requireEditor();
    const input = twinUploadRequestSchema.parse(await readJson(req));
    const header = req.headers.get("idempotency-key");
    const key = header ? twinKeySchema.parse(header) : undefined;
    const admit = () => {
      const limit = rateLimitPair(`twinupload:${owner}`, PER_OWNER, "twinupload:*", PER_INSTANCE, WINDOW_MS);
      if (!limit.allowed) throw new LimitError(`Too many uploads for now; try again in ${Math.ceil(limit.retryAfterSec / 60)} minutes`);
    };
    return json({ upload: await startTwinUpload(input, owner, { key, admit }) });
  } catch (err) {
    return errorResponse(err);
  }
}
