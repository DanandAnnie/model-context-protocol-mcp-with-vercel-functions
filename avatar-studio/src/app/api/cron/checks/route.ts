import { json } from "@/lib/api-utils";
import { timingSafeEqual } from "@/lib/auth";
import { config } from "@/lib/config";
import { checkTranslationsInBackground } from "@/lib/services/translations";
import { checkTwinsInBackground } from "@/lib/services/twins";

export const dynamic = "force-dynamic";
// The checks call the renderer, and the webhooks they cause are sent after the answer: room for both.
export const maxDuration = 60;

/**
 * The scheduled background check (Vercel Cron calls it with `Authorization: Bearer $CRON_SECRET`): moves on dubs,
 * proofreads, and digital twins nobody is watching, so their webhooks are sent without an open page. Off (404) with no
 * CRON_SECRET; any other caller is refused (401). Each kind is reported on its own, so one failing keeps the other's.
 */
export async function GET(req: Request) {
  const secret = config.cronSecret;
  if (!secret) return json({ error: "Background checks are off: set CRON_SECRET to turn them on" }, { status: 404 });
  if (!timingSafeEqual(req.headers.get("authorization") ?? "", `Bearer ${secret}`)) return json({ error: "Unauthorized" }, { status: 401 });
  const [translations, twins] = await Promise.allSettled([checkTranslationsInBackground(), checkTwinsInBackground()]);
  const report = (r: PromiseSettledResult<{ checked: number; moved: number }>, what: string) => {
    if (r.status === "fulfilled") return r.value;
    console.error(`background check of ${what} failed:`, r.reason);
    return { error: `The ${what} could not be checked` };
  };
  const body = { translations: report(translations, "dubs"), twins: report(twins, "digital twins") };
  const ok = translations.status === "fulfilled" && twins.status === "fulfilled";
  return json({ ok, ...body }, { status: ok ? 200 : 500 });
}
