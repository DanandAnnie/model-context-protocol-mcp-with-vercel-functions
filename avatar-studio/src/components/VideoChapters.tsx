"use client";
import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button, Card } from "@/components/ui";
import { captionDurationSec, chaptersText, videoChapters, youtubeReadsChapters, type Timed } from "@/lib/chapters";
import { formatTimestamp } from "@/lib/text";

/**
 * A multi-scene video's chapters, one per scene, as the share page lists them, with a copy in the form a video
 * description takes ("0:00 Welcome"), so a video posted to YouTube keeps them.
 */
export function VideoChapters({ video }: { video: Timed & { status?: string; captionCues?: Array<{ startMs: number; text: string }> } }) {
  const [copied, setCopied] = useState(false);
  const chapters = videoChapters(video);
  if (chapters.length < 2) return null;
  const text = chaptersText(chapters);
  const totalMs = captionDurationSec(video) * 1000;
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy these chapters", text);
    }
  }
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900">Chapters</h3>
        <Button variant="secondary" className="px-3 py-1.5" onClick={copy}>
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} {copied ? "Copied" : "Copy for YouTube"}
        </Button>
      </div>
      <ol className="mt-2 space-y-1 text-sm" data-testid="video-chapters">
        {chapters.map((c, i) => (
          <li key={i} className="flex gap-3">
            <span className="w-12 shrink-0 font-mono text-xs leading-5 text-slate-500">{formatTimestamp(c.startMs / 1000)}</span>
            <span className="min-w-0 text-slate-700">{c.title}</span>
          </li>
        ))}
      </ol>
      <p className="mt-2 text-xs text-slate-500">
        {video.status !== "completed"
          ? "Times are estimated until the video renders."
          : !video.durationSec
            ? "The renderer did not report the video's length, so times are estimated from the script."
            : video.captionCues?.length
              ? "Times follow the corrected captions."
              : "Times follow each scene's share of the video, as the captions do."}{" "}
        {youtubeReadsChapters(chapters, totalMs)
          ? "Paste them into a YouTube description to show them as chapters there."
          : "YouTube shows chapters only when there are at least three, each 10 seconds or longer, so it would list these as plain text."}
      </p>
    </Card>
  );
}
