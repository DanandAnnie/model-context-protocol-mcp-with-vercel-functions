import { json } from "@/lib/api-utils";
import { providerStatus } from "@/lib/providers";

export const dynamic = "force-dynamic";

export async function GET() {
  return json(providerStatus());
}
