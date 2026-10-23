import { errorResponse, json } from "@/lib/api-utils";
import { listVoices } from "@/lib/services";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return json({ voices: await listVoices() });
  } catch (err) {
    return errorResponse(err);
  }
}
