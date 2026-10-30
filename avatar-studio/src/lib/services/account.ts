// Account data export and deletion. Used by API routes only.
import { nowIso } from "../ids";
import { getTtsProvider } from "../providers";
import { getStore } from "../store";
import { LOCAL_OWNER } from "../owner-id";
import { assertNoRenewingPlan } from "../billing";
import { ConflictError } from "../errors";
import { madeLooksOf, rememberMadeLooks } from "./avatars";
import { dropTwinVoice } from "./twins";
import type { InstantVoice, MusicJob, TwinJob, VoiceChange } from "../types";
import { dropMusicRender } from "./music";
import { dropInstantVoice, wordsRowId } from "./voice-changer";

const OWNER_KINDS = ["video", "avatar", "translation", "brand", "apikey", "notify", "prefs", "plan", "agent", "conversation", "voice", "template", "sharelock", "cover", "comment", "activity", "clip", "videolead", "backdrop", "portrait", "highlight", "cleanup", "lipsync", "lookpack", "twin", "music", "instantvoice", "voicechange", "footage", "shoot"] as const;
/**
 * Cover rows hold image bytes; the export describes each cover from its video (`cover.mimeType`, `cover.bytes`) instead
 * of loading them. Clip audio is never listed (each `clip` row names its own `clipaudio_<id>` row), so the export and
 * the deletion below never pull audio bytes; a spoken text's word times (`voicewords_<id>`) are left out the same way.
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
      if (kind === "clip" || kind === "backdrop") delete copy.providerAssetIds;
      if (kind === "translation") delete copy.proofreadToken;
      // A drawn portrait's picture is in the photo avatar made from it; the job keeps only what it was.
      if (kind === "portrait") delete copy.imageUrl;
      // The renderer and its job id never leave the server, in the export as on the page.
      if (kind === "highlight" || kind === "cleanup" || kind === "lipsync" || kind === "music") {
        delete copy.provider;
        delete copy.providerJobId;
        delete copy.askedTitle;
      }
      // The renderer, the voice there, and the upload sent to it stay on the server.
      if (kind === "instantvoice" || kind === "voicechange") {
        delete copy.provider;
        delete copy.providerVoiceId;
        delete copy.providerAudio;
      }
      if (kind === "footage") {
        delete copy.provider;
        delete copy.providerJobId;
        delete copy.imageDigest;
        delete copy.askedTitle;
      }
      if (kind === "shoot") {
        delete copy.provider;
        delete copy.providerJobId;
        delete copy.pictureDigest;
        delete copy.askedTitle;
      }
      if (kind === "lookpack") {
        delete copy.provider;
        delete copy.lookIds;
        delete copy.referenceDigest;
      }
      // The twin's picture is in the photo avatar it became; the renderer's look, character, and voice stay on the
      // server, and the consent link is the person's to record with, not part of the account's data.
      if (kind === "twin") {
        delete copy.provider;
        delete copy.lookId;
        delete copy.groupId;
        delete copy.voiceId;
        delete copy.imageUrl;
        delete copy.consentUrl;
      }
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
 * Kinds in deletion order: keys first so no script keeps writing while the rest goes, then voices (cloned and instant),
 * whose provider call is the step most likely to fail, so a failure stops the run before anything else is lost.
 */
const DELETE_ORDER = ["apikey", "voice", "instantvoice", ...OWNER_KINDS.filter((k) => k !== "apikey" && k !== "voice" && k !== "instantvoice")] as const;

/**
 * Deletes everything stored under an owner id (cloned voices are removed at the provider too). Returns counts per kind.
 * A Stripe subscription that can still bill is refused first (400). Each kind is listed until it comes back empty,
 * because a store may cap one listing (Supabase returns at most 1,000 rows). A voice the provider fails to delete
 * stops the run with its row kept, so the clone's id is never lost and a retry (after fixing the provider key, say)
 * finishes the job; the provider treats a voice it no longer has as deleted.
 */
export async function deleteOwnerData(ownerId: string = LOCAL_OWNER, opts: { billingChecked?: boolean } = {}): Promise<Record<string, number>> {
  // A workspace delete checks billing itself, before it revokes the keys, so it is not asked twice.
  if (!opts.billingChecked) await assertNoRenewingPlan(ownerId);
  const counts: Record<string, number> = {};
  const tts = getTtsProvider();
  let clonesRemoved = 0;
  for (const kind of DELETE_ORDER) {
    const removed = new Set<string>();
    for (;;) {
      const items = await getStore().list<{ id: string; provider?: string }>(kind, ownerId);
      if (items.length === 0) break;
      // A row that is still listed after being removed would loop forever; stop and report it instead.
      if (items.every((item) => removed.has(item.id))) throw new Error(`Could not delete ${kind} records; try again`);
      for (const item of items) {
        if (kind === "voice" && item.provider === tts.name && !removed.has(item.id)) {
          await tts.deleteVoice?.(item.id).catch((err: unknown) => {
            console.error(err);
            const status = (err as { status?: number }).status;
            throw new ConflictError(
              `The voice provider would not delete the cloned voice "${(item as { name?: string }).name ?? item.id}"${status ? ` (${status})` : ""}. Any API keys${clonesRemoved ? ` and ${clonesRemoved} other cloned voice(s) at the provider` : ""} were already removed; videos and the rest were kept. Try again once the provider answers (check its API key if this repeats).`,
            );
          });
          clonesRemoved += 1;
        }
        // The clip's audio sits in its own row, removed by id so it is never loaded.
        if (kind === "clip") await getStore().remove("clipaudio", `clipaudio_${item.id}`);
        if (kind === "backdrop") await getStore().remove("backdropdata", `backdropdata_${item.id}`);
        if (kind === "voicechange" && (item as VoiceChange).timed) await getStore().remove("voicewords", wordsRowId(item.id));
        // Looks made at the renderer stay there; they stay the studio's, never offered to other accounts. A twin's
        // voice that never became the account's (those went with the voices) is deleted there.
        await rememberMadeLooks(madeLooksOf(kind, item));
        if (kind === "twin") await dropTwinVoice(item as TwinJob);
        // A mix is a full copy of the account's footage at the renderer.
        if (kind === "music") await dropMusicRender(item as MusicJob);
        // An instant voice is a real person's voice in the renderer's shared account: deleted there, or the account is kept.
        if (kind === "instantvoice") await dropInstantVoice(item as InstantVoice);
        await getStore().remove(kind, item.id);
        removed.add(item.id);
      }
    }
    counts[kind] = removed.size;
  }
  return counts;
}
