import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Sparkles } from "lucide-react";
import {
  NotFoundError,
  PUBLIC_ACCESS,
  getBrandKit,
  getVideo,
} from "@/lib/services";
import { LOCAL_OWNER } from "@/lib/owner";
import { config } from "@/lib/config";
import { formatSeconds, isDarkHex, posterUrl } from "@/lib/client";
import { languageCode } from "@/lib/language";
import { excerpt } from "@/lib/text";
import { stripPauses } from "@/lib/pauses";
import { dimensionsFor, type WatermarkCorner } from "@/lib/types";
import { ViewBeacon } from "@/components/ViewBeacon";
import { ShareCta } from "@/components/ShareCta";
import { ShareUnlock } from "@/components/ShareUnlock";
import { SharePlayer } from "@/components/SharePlayer";
import { captionsBurnedIn } from "@/lib/captions";
import { shareCookieName, shareGateCookieName, shareUnlocked } from "@/lib/share-lock";
import { ShareLeadGate } from "@/components/ShareLeadGate";

export const dynamic = "force-dynamic";

/** Link previews (Slack, LinkedIn, iMessage): title, script excerpt, thumbnail, and the video itself once rendered. */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  let video;
  try {
    video = await getVideo(id, PUBLIC_ACCESS, false);
  } catch (err) {
    if (err instanceof NotFoundError)
      return {
        title: "Video not found",
        robots: { index: false, follow: false },
      };
    throw err;
  }
  const brand = await getBrandKit(video.ownerId ?? LOCAL_OWNER);
  const siteName = brand?.name || "Avatar Studio";
  const base = config.appUrl.replace(/\/$/, "");
  // A protected link previews with its title only: no excerpt, thumbnail, or video for the unfurler.
  if (video.shareLocked) {
    const description = "This video is password protected.";
    return {
      title: `${video.title} · ${siteName}`,
      description,
      robots: { index: false, follow: false },
      openGraph: {
        title: video.title,
        description,
        url: `${base}/share/${video.id}`,
        siteName,
        type: "website",
      },
      twitter: { card: "summary", title: video.title, description },
    };
  }
  // A gated link previews without the video or the script, which would let the preview stand in for the form.
  const gate = !!video.shareGate;
  const description = excerpt(video.description ?? "") || (gate ? "" : excerpt(stripPauses(video.script))) || `A video from ${siteName}`;
  const ready = video.status === "completed" && !!video.videoUrl && !gate;
  const poster = posterUrl(video, base);
  const images = poster
    ? [{ url: poster, alt: video.title }]
    : undefined;
  const { width, height } = dimensionsFor(video.aspect, video.resolution);
  return {
    title: `${video.title} · ${siteName}`,
    description,
    openGraph: {
      title: video.title,
      description,
      url: `${base}/share/${video.id}`,
      siteName,
      type: ready ? "video.other" : "website",
      images,
      videos:
        ready && video.videoUrl
          ? [{ url: video.videoUrl, type: video.videoUrl.endsWith(".webm") ? "video/webm" : "video/mp4", width, height }]
          : undefined,
    },
    twitter: {
      card: images ? "summary_large_image" : "summary",
      title: video.title,
      description,
      images: images?.map((i) => i.url),
    },
  };
}

/** Public, sidebar-free player page for sharing a finished video. `?autoplay=1` starts it muted and `?loop=1` repeats it (for embeds). */
export default async function SharePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ autoplay?: string; loop?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const autoplay = query.autoplay === "1";
  const loop = query.loop === "1";
  let video;
  try {
    video = await getVideo(id, PUBLIC_ACCESS);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }

  const brand = await getBrandKit(video.ownerId ?? LOCAL_OWNER);
  const accent = brand?.accentColor ?? brand?.primaryColor;
  const ctaBackground = accent ?? "#4f46e5";
  const jar = await cookies();
  const unlocked = await shareUnlocked(video, jar.get(shareCookieName(video.id))?.value);
  // The email gate comes after the password: a viewer who has not given an email yet sees the form, not the player.
  const gated = unlocked && !!video.shareGate && !jar.get(shareGateCookieName(video.id));
  const watching = unlocked && !gated;

  const frame =
    video.aspect === "9:16"
      ? "aspect-[9/16] max-w-[420px]"
      : video.aspect === "1:1"
        ? "aspect-square max-w-[640px]"
        : "aspect-video";

  // An uploaded logo (a data URL of up to a few megabytes) is served by its own cacheable route, so the
  // header and the player watermark share one short URL instead of carrying the image in the page.
  const logoSrc = brand?.logoUrl
    ? brand.logoUrl.startsWith("data:")
      ? `/api/videos/${encodeURIComponent(video.id)}/logo?v=${encodeURIComponent(brand.updatedAt)}`
      : brand.logoUrl
    : undefined;
  const watermark = logoSrc && brand?.watermark && video.status === "completed" && video.videoUrl ? brand.watermark : undefined;

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      {watching && video.status === "completed" && (
        <ViewBeacon videoId={video.id} />
      )}
      {accent && (
        <div className="h-1.5" style={{ background: accent }} aria-hidden />
      )}
      <header className="mx-auto flex max-w-4xl items-center justify-between px-6 py-5">
        {brand && (brand.name || brand.logoUrl) ? (
          <div
            className="flex items-center gap-3 text-sm font-medium text-slate-200"
            data-testid="share-brand"
          >
            {logoSrc && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={logoSrc}
                alt={brand.name ? `${brand.name} logo` : "Logo"}
                className="h-8 max-w-[140px] object-contain"
              />
            )}
            {brand.name && <span>{brand.name}</span>}
          </div>
        ) : (
          <Link
            href="/"
            className="flex items-center gap-2 text-sm font-medium text-slate-300 hover:text-white"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-600 text-white">
              <Sparkles className="h-3.5 w-3.5" />
            </span>
            Avatar Studio
          </Link>
        )}
        {video.durationSec != null && (
          <span className="text-xs text-slate-400">
            {formatSeconds(video.durationSec)}
          </span>
        )}
      </header>
      <section className="mx-auto max-w-4xl px-6 pb-16">
        <h1 className="mb-4 text-xl font-semibold">{video.title}</h1>
        {!unlocked ? (
          <ShareUnlock videoId={video.id} />
        ) : (
          // The gate shows the player itself once the email is in, so an embed whose browser drops
          // third-party cookies still plays; the cookie only spares a returning viewer the form.
          <ShareLeadGate videoId={video.id} brandName={brand?.name} open={!gated}>
          {gated && video.status === "completed" && <ViewBeacon videoId={video.id} />}
            <div
              className={`relative mx-auto w-full overflow-hidden rounded-xl bg-black ${frame}`}
            >
              {watermark && logoSrc && <Watermark corner={watermark} src={logoSrc} captioned={!!video.captions} />}
              {video.status === "completed" && video.videoUrl ? (
                <SharePlayer videoId={video.id} src={video.videoUrl} poster={posterUrl(video)} captions={!!video.captions} captionSize={video.captionStyle?.size} captionLook={video.captionStyle?.look} trackDefault={!captionsBurnedIn(video)} autoplay={autoplay} loop={loop} tracks={Object.keys(video.subtitles ?? {}).map((language) => ({ language, code: languageCode(language) }))} />
              ) : (
                <div className="flex h-full w-full items-center justify-center p-10 text-center text-sm text-slate-400">
                  {video.status === "failed"
                    ? "This video could not be rendered."
                    : "This video is still rendering. Check back in a minute."}
                </div>
              )}
            </div>
            {(video.shareCta ||
              (video.shareDownload &&
                video.status === "completed" &&
                video.videoUrl)) && (
              <p className="mt-4 flex flex-wrap items-center gap-3">
                {video.shareCta && (
                  <ShareCta
                    videoId={video.id}
                    label={video.shareCta.label}
                    url={video.shareCta.url}
                    background={ctaBackground}
                    dark={isDarkHex(ctaBackground)}
                  />
                )}
                {video.shareDownload &&
                  video.status === "completed" &&
                  video.videoUrl && (
                    <a
                      href={video.videoUrl}
                      download
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-100 hover:bg-slate-700"
                    >
                      Download video
                    </a>
                  )}
              </p>
            )}
            {video.description && (
              <p className="mt-6 whitespace-pre-wrap text-base leading-relaxed text-slate-100" data-testid="share-description">
                {video.description}
              </p>
            )}
            <p className="mt-6 whitespace-pre-wrap text-sm leading-relaxed text-slate-300">
              {stripPauses(video.script)}
            </p>
          </ShareLeadGate>
        )}
        {brand && (brand.name || brand.logoUrl) && (
          <p className="mt-10 text-xs text-slate-500">
            Made with{" "}
            <Link href="/" className="underline hover:text-slate-300">
              Avatar Studio
            </Link>
          </p>
        )}
      </section>
    </main>
  );
}

/**
 * Where the logo sits, in shares of the frame so it keeps its place on a small embed. A bottom corner
 * clears the native controls (at least 2.75rem), and on a captioned video it rises above the caption
 * band, which runs about a fifth of the way up.
 */
function watermarkPlace(corner: WatermarkCorner, captioned: boolean): string {
  const side = corner.endsWith("left") ? "left-[3%] object-left" : "right-[3%] object-right";
  if (corner.startsWith("top")) return `${side} top-[4%] object-top`;
  return `${side} object-bottom ${captioned ? "bottom-[max(2.75rem,24%)]" : "bottom-[max(2.75rem,12%)]"}`;
}

/**
 * The brand logo over the player, as a watermark: decorative (the header names the brand), and clicks
 * pass through to the player. It belongs to the page, not the video file, so it is not shown when the
 * player goes fullscreen or picture-in-picture.
 */
function Watermark({ corner, src, captioned }: { corner: WatermarkCorner; src: string; captioned: boolean }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      aria-hidden
      className={`pointer-events-none absolute z-10 h-[9%] max-h-12 w-[18%] object-contain opacity-80 drop-shadow ${watermarkPlace(corner, captioned)}`}
      data-testid="share-watermark"
      data-corner={corner}
    />
  );
}
