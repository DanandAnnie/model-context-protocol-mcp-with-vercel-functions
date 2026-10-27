// What a share page shows below its title once a viewer may watch: the player, the button and download
// link, the description, and the transcript. It is built on the server, and reaches the browser either in
// the page (an open link) or in the answer to the email gate (a gated one), so a gated page's source holds
// none of it until an email is given.
import { captionsBurnedIn } from "./captions";
import { isDarkHex, posterUrl } from "./client";
import { languageCode } from "./language";
import { stripPauses } from "./pauses";
import { publicLogoSrc } from "./brand-logo";
import { transcriptsFor } from "./services/videos";
import { videoChapters, type Chapter } from "./chapters";
import type { AspectRatio, BrandKit, CaptionStyle, Video, WatermarkCorner } from "./types";

export interface ShareBody {
  videoId: string;
  status: Video["status"];
  aspect: AspectRatio;
  /** Set once the video has rendered. */
  player?: {
    src: string;
    poster?: string;
    captions: boolean;
    captionStyle?: CaptionStyle;
    trackDefault: boolean;
    tracks: Array<{ language: string; code?: string }>;
  };
  watermark?: { corner: WatermarkCorner; src: string };
  cta?: { label: string; url: string; background: string; dark: boolean };
  /** The file to download, when the owner allows it. */
  download?: string;
  description?: string;
  /** The caption lines per language once rendered; until then the script is shown as text. */
  transcripts?: Array<{ language?: string; code?: string; cues: Array<{ startMs: number; endMs: number; text: string }> }>;
  /** One per scene of a rendered video of two scenes or more, for jumping to a scene. */
  chapters?: Chapter[];
  script?: string;
}

/** A video's file is a WebM when HeyGen rendered it transparent or its address says so (a signed link's query aside). */
export function isWebm(video: { videoUrl?: string; transparent?: true; provider?: string }): boolean {
  if (video.transparent && video.provider === "heygen") return true;
  if (!video.videoUrl) return false;
  try {
    return new URL(video.videoUrl, "http://local").pathname.toLowerCase().endsWith(".webm");
  } catch {
    return false;
  }
}

export function shareBodyFor(video: Video, brand: BrandKit | null): ShareBody {
  const rendered = video.status === "completed" && !!video.videoUrl;
  const background = brand?.accentColor ?? brand?.primaryColor ?? "#4f46e5";
  const logoSrc = publicLogoSrc(brand, `/api/videos/${encodeURIComponent(video.id)}/logo`);
  return {
    videoId: video.id,
    status: video.status,
    aspect: video.aspect,
    ...(rendered && {
      player: {
        src: video.videoUrl!,
        poster: posterUrl(video),
        captions: !!video.captions,
        captionStyle: video.captionStyle,
        trackDefault: !captionsBurnedIn(video),
        tracks: Object.keys(video.subtitles ?? {}).map((language) => ({ language, code: languageCode(language) })),
      },
    }),
    ...(rendered && logoSrc && brand?.watermark && { watermark: { corner: brand.watermark, src: logoSrc } }),
    ...(video.shareCta && { cta: { label: video.shareCta.label, url: video.shareCta.url, background, dark: isDarkHex(background) } }),
    ...(rendered && video.shareDownload && { download: video.videoUrl }),
    ...(video.description && { description: video.description }),
    ...(rendered && video.scenes && video.scenes.length > 1 && { chapters: videoChapters(video) }),
    // A cinematic shot has no script, so nothing to read along with.
    ...(video.cinematic
      ? {}
      : rendered
      ? { transcripts: transcriptsFor(video).map((t) => ({ ...t, ...(t.language ? { code: languageCode(t.language) } : {}) })) }
      : { script: stripPauses(video.script).replace(/\n\s*\n\s*(?:\n\s*)+/g, "\n\n").trim() }),
  };
}
