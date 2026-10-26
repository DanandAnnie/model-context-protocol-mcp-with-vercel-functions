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
import { formatSeconds, posterUrl } from "@/lib/client";
import { excerpt } from "@/lib/text";
import { publicLogoSrc } from "@/lib/brand-logo";
import { stripPauses } from "@/lib/pauses";
import { dimensionsFor } from "@/lib/types";
import { ShareUnlock } from "@/components/ShareUnlock";
import { shareCookieName, shareGateCookieName, shareGatePassed, shareUnlocked } from "@/lib/share-lock";
import { ShareLeadGate } from "@/components/ShareLeadGate";
import { ShareWatch } from "@/components/ShareWatch";
import { shareBodyFor } from "@/lib/share-body";

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
  // A gated link previews with its title and cover only: the video, description, and script would let the preview stand in for the form.
  const gate = !!video.shareGate;
  const description = (gate ? "" : excerpt(video.description ?? "") || excerpt(stripPauses(video.script))) || `A video from ${siteName}`;
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
  const jar = await cookies();
  const unlocked = await shareUnlocked(video, jar.get(shareCookieName(video.id))?.value);
  // The email gate comes after the password: a viewer who has not given an email yet sees the form, not the player.
  const gated = unlocked && !shareGatePassed(video, jar.get(shareGateCookieName(video.id))?.value);

  // An uploaded logo (a data URL of up to a few megabytes) is served by its own cacheable route, so the
  // header and the player watermark share one short URL instead of carrying the image in the page.
  const logoSrc = publicLogoSrc(brand, `/api/videos/${encodeURIComponent(video.id)}/logo`);

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
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
          // A gated page carries only the form: the player, button, download link, and transcript come back in
          // the gate's answer once an email is in, so the page source holds none of them, and an embed whose
          // browser drops third-party cookies still plays without a reload. The cookie spares a returning viewer the form.
          gated ? (
            <ShareLeadGate videoId={video.id} brandName={brand?.name} autoplay={autoplay} loop={loop} />
          ) : (
            <ShareWatch body={shareBodyFor(video, brand)} autoplay={autoplay} loop={loop} />
          )
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
