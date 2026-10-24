// Account data export and deletion. Used by API routes only.
import { nowIso } from "../ids";
import { getTtsProvider } from "../providers";
import { getStore } from "../store";
import { LOCAL_OWNER } from "../owner-id";

const OWNER_KINDS = ["video", "avatar", "translation", "brand", "apikey", "notify", "prefs", "plan", "agent", "conversation", "voice", "template", "sharelock", "cover", "comment", "activity"] as const;
/** Cover rows hold the image bytes; the export describes each cover from its video (`cover.mimeType`, `cover.bytes`) instead of loading them. */
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
