// Records an activity event for the current request. The person is resolved here, inside the
// best-effort boundary, so neither the lookup nor the write can fail a request whose work is done.
import { userOrOwner } from "./owner";
import { recordActivity, type ActivityDetails } from "./services/activity";
import type { ActivityEvent, ActivityKind } from "./types";

export async function recordRequestActivity(owner: string, kind: ActivityKind, details: ActivityDetails = {}): Promise<ActivityEvent | null> {
  try {
    return await recordActivity(owner, await userOrOwner(owner), kind, details);
  } catch (err) {
    console.error(`activity ${kind} for ${owner} not recorded:`, err);
    return null;
  }
}
