import { json } from "@/lib/api-utils";
import { UnauthorizedError } from "@/lib/errors";
import { requireOwner } from "@/lib/owner";
import { providerStatus } from "@/lib/providers";
import { rendersThisMonth } from "@/lib/services";

export const dynamic = "force-dynamic";

export async function GET() {
  const status = providerStatus();
  try {
    const owner = await requireOwner();
    return json({ ...status, usage: { rendersThisMonth: await rendersThisMonth(owner) } });
  } catch (err) {
    if (err instanceof UnauthorizedError) return json(status);
    throw err;
  }
}
