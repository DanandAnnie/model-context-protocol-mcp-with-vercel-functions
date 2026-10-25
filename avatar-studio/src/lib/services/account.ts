// Account data export and deletion. Used by API routes only.
import { nowIso } from "../ids";
import { getTtsProvider } from "../providers";
import { getStore } from "../store";
import { LOCAL_OWNER } from "../owner-id";

const OWNER_KINDS = ["video", "avatar", "translation", "brand", "apikey", "notify", "prefs", "plan", "agent", "conversation", "voice", "template", "sharelock", "cover", "comment", "activity", "clip", "clipaudio"] as const;
/**
 * Cover and clip-audio rows hold bytes; the export describes each cover from its video (`cover.mimeType`, `cover.bytes`)
 * and each audio clip from its `clip` row (name, type, size, length) instead of loading them.
 */
const EXPORT_KINDS = OWNER_KINDS.filter((k) => k !== "cover" && k !== "clipaudio") as Exclude<(typeof OWNER_KINDS)[number], "cover" | "clipaudio">[];

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

/** Deletes everything stored under an owner id (cloned voices are removed at the provider too). Returns counts per kind. */
export async function deleteOwnerData(ownerId: string = LOCAL_OWNER): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const tts = getTtsProvider();
  for (const kind of OWNER_KINDS) {
    const items = await getStore().list<{ id: string; provider?: string }>(kind, ownerId);
    for (const item of items) {
      if (kind === "voice" && item.provider === tts.name) await tts.deleteVoice?.(item.id).catch(() => {});
      await getStore().remove(kind, item.id);
    }
    counts[kind] = items.length;
  }
  return counts;
}
