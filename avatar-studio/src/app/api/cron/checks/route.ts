import { json } from "@/lib/api-utils";
import { timingSafeEqual } from "@/lib/auth";
import { config } from "@/lib/config";
import { checkTranslationsInBackground } from "@/lib/services/translations";
import { checkTwinsInBackground } from "@/lib/services/twins";
import { checkFootageInBackground } from "@/lib/services/footage";
import { checkShootsInBackground } from "@/lib/services/shoots";
import { checkCleanupsInBackground } from "@/lib/services/cleanups";
import { checkLipsyncsInBackground } from "@/lib/services/lipsyncs";
import { checkMusicJobsInBackground } from "@/lib/services/music";
import { checkInstantVoicesInBackground, checkVoiceChangesInBackground } from "@/lib/services/voice-changer";

type Counts = { checked: number; moved: number };

/** The other renderer jobs checked, by the `type` their webhook events carry, with what a failure names them. */
const JOBS: [type: string, what: string, check: () => Promise<Counts>][] = [
  ["broll", "B-roll clips", () => checkFootageInBackground()],
  ["photo_shoot", "photo shoots", () => checkShootsInBackground()],
  ["cleanup", "clean-ups", () => checkCleanupsInBackground()],
  ["lipsync", "lip syncs", () => checkLipsyncsInBackground()],
  ["music", "music mixes", () => checkMusicJobsInBackground()],
  ["voice_change", "voice recordings", () => checkVoiceChangesInBackground()],
  ["instant_voice", "instant voices", () => checkInstantVoicesInBackground()],
];

export const dynamic = "force-dynamic";
// The checks call the renderer, and the webhooks they cause are sent after the answer: room for both.
export const maxDuration = 60;

/**
 * The scheduled background check (Vercel Cron calls it with `Authorization: Bearer $CRON_SECRET`): moves on dubs,
 * proofreads, digital twins, and the other renderer jobs (B-roll clips, photo shoots, clean-ups, lip syncs, music mixes,
 * voice recordings, instant voices) nobody is watching, so their webhooks are sent without an open page. Off (404) with
 * no CRON_SECRET; any other caller is refused (401). Each kind is reported on its own, so one failing keeps the others'.
 */
export async function GET(req: Request) {
  const secret = config.cronSecret;
  if (!secret) return json({ error: "Background checks are off: set CRON_SECRET to turn them on" }, { status: 404 });
  if (!timingSafeEqual(req.headers.get("authorization") ?? "", `Bearer ${secret}`)) return json({ error: "Unauthorized" }, { status: 401 });
  const [translations, twins, ...jobs] = await Promise.allSettled([checkTranslationsInBackground(), checkTwinsInBackground(), ...JOBS.map(([, , check]) => check())]);
  const report = (r: PromiseSettledResult<Counts>, what: string) => {
    if (r.status === "fulfilled") return r.value;
    console.error(`background check of ${what} failed:`, r.reason);
    return { error: `The ${what} could not be checked` };
  };
  const body = {
    translations: report(translations, "dubs"),
    twins: report(twins, "digital twins"),
    jobs: Object.fromEntries(JOBS.map(([type, what], i) => [type, report(jobs[i], what)])),
  };
  const ok = [translations, twins, ...jobs].every((r) => r.status === "fulfilled");
  return json({ ok, ...body }, { status: ok ? 200 : 500 });
}
