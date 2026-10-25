// Account data export and deletion. Used by API routes only.
import { nowIso } from "../ids";
import { getTtsProvider } from "../providers";
import { getStore } from "../store";
import { LOCAL_OWNER } from "../owner-id";
import { getPlan } from "../billing";
import { ValidationError } from "../errors";

const OWNER_KINDS = ["video", "avatar", "translation", "brand", "apikey", "notify", "prefs", "plan", "agent", "conversation", "voice", "template", "sharelock", "cover", "comment", "activity", "clip", "videolead"] as const;
/**
 * Cover rows hold image bytes; the export describes each cover from its video (`cover.mimeType`, `cover.bytes`) instead
 * of loading them. Clip audio is never listed (each `clip` row names its own `clipaudio_<id>` row), so the export and
 * the deletion below never pull audio bytes.
 */
const EXPORT_KINDS = OWNER_KINDS.filter((k) => k !== "cover") as Exclude<(typeof OWNER_KINDS)[number], "cover">[];

/** Everything stored under an owner id, for a data export. Secrets (key hashes, webhook secret) and cover image bytes are left out. */
export type OwnerExport = { ownerId: string; exportedAt: string } & Record<(typeof EXPORT_KINDS)[number], Record<string, unknown>[]>;

export async function exportOwnerData(ownerId: string = LOCAL_OWNER): Promise<OwnerExport> {
  const out = {} as Record<(typeof EXPORT_KINDS)[number], Record<string, unknown>[]>;
  for (const kind of EXPORT_KINDS) {
    const items = await getStore().list<Record<string, unknown>>(kind, ownerId);
    out[kind] = items.map((item) => {
      const copy = { ...item };
      if (kind === "apikey") delete copy.hash;
      if (kind === "notify") delete copy.secret;
      if (kind === "clip") delete copy.providerAssetIds;
      if (kind === "sharelock") {
        delete copy.hash;
        delete copy.salt;
      }
      return copy;
    });
  }
  return { ownerId, exportedAt: nowIso(), ...out };
}

/**
 * Deletes everything stored under an owner id (cloned voices are removed at the provider too). Returns counts per kind.
 * A Stripe subscription that is still renewing is refused first: deleting its plan row would leave the owner billed
 * with no way to reach the billing portal. Each kind is listed until it comes back empty, because a store may cap
 * one listing (Supabase returns at most 1,000 rows), and a failed provider voice delete stops the run with the row
 * kept so a retry can find the clone again.
 */
export async function deleteOwnerData(ownerId: string = LOCAL_OWNER): Promise<Record<string, number>> {
  const plan = await getPlan(ownerId);
  if (plan.plan === "pro" && plan.provider === "stripe" && !plan.endsAt) {
    throw new ValidationError("Cancel the Pro plan first (Settings, Manage subscription); it keeps billing otherwise");
  }
  const counts: Record<string, number> = {};
  const tts = getTtsProvider();
  for (const kind of OWNER_KINDS) {
    const removed = new Set<string>();
    for (;;) {
      const items = await getStore().list<{ id: string; provider?: string }>(kind, ownerId);
      if (items.length === 0) break;
      // A row that is still listed after being removed would loop forever; stop and report it instead.
      if (items.every((item) => removed.has(item.id))) throw new Error(`Could not delete ${kind} records; try again`);
      for (const item of items) {
        if (kind === "voice" && item.provider === tts.name) await tts.deleteVoice?.(item.id);
        // The clip's audio sits in its own row, removed by id so it is never loaded.
        if (kind === "clip") await getStore().remove("clipaudio", `clipaudio_${item.id}`);
        await getStore().remove(kind, item.id);
        removed.add(item.id);
      }
    }
    counts[kind] = removed.size;
  }
  return counts;
}
