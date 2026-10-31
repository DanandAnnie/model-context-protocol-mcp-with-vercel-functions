"use client";
import Link from "next/link";
import { Camera, Clapperboard, Languages, Layers3, LayoutTemplate, MessageSquare, Sparkles, Wand2 } from "lucide-react";
import { Insights } from "@/components/Insights";
import { VideoCard } from "@/components/VideoCard";
import { EmptyState, SectionTitle, Skeleton } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import type { Video } from "@/lib/types";

const QUICK = [
  { href: "/create", icon: Clapperboard, title: "Avatar video", body: "Script + avatar + voice. The core workflow.", accent: "bg-brand-600" },
  { href: "/agent", icon: Sparkles, title: "Video Agent", body: "Describe a video in a sentence; the agent plans the scenes and makes it.", accent: "bg-indigo-600" },
  { href: "/create?writer=1", icon: Wand2, title: "Write with AI", body: "Generate a script from a topic, then render it.", accent: "bg-violet-600" },
  { href: "/templates", icon: LayoutTemplate, title: "Start from a template", body: "Listing walkthroughs, welcomes, tips, and more.", accent: "bg-amber-500" },
  { href: "/batch", icon: Layers3, title: "Personalize at scale", body: "One script, a CSV of recipients, one video each.", accent: "bg-rose-600" },
  { href: "/avatars?new=1", icon: Camera, title: "Photo avatar", body: "Turn a portrait into a presenter.", accent: "bg-sky-600" },
  { href: "/translate", icon: Languages, title: "Translate a video", body: "Dub an existing video into another language.", accent: "bg-emerald-600" },
  { href: "/interactive", icon: MessageSquare, title: "Interactive avatar", body: "Talk to a presenter live; it answers in character.", accent: "bg-slate-800" },
];

export default function HomePage() {
  const { data, loading } = useApi<{ videos: Video[] }>("/api/videos");
  const recent = data?.videos.slice(0, 4) ?? [];

  return (
    <>
      <SectionTitle title="Home" subtitle="What do you want to make today?" />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {QUICK.map(({ href, icon: Icon, title, body, accent }) => (
          <Link key={title} href={href} className="rounded-xl border border-slate-200 bg-white p-5 transition hover:border-slate-300 hover:shadow-sm">
            <span className={`flex h-10 w-10 items-center justify-center rounded-lg text-white ${accent}`}>
              <Icon className="h-5 w-5" />
            </span>
            <h3 className="mt-4 text-sm font-semibold text-slate-900">{title}</h3>
            <p className="mt-1 text-xs text-slate-500">{body}</p>
          </Link>
        ))}
      </div>

      {data && data.videos.length > 0 && (
        <div className="mt-10">
          <h2 className="mb-4 text-lg font-semibold text-slate-900">Insights</h2>
          <Insights videos={data.videos} />
        </div>
      )}

      <div className="mt-10">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">Recent videos</h2>
          <Link href="/videos" className="text-sm font-medium text-brand-600 hover:underline">
            View all
          </Link>
        </div>
        {loading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="aspect-[16/11]" />
            ))}
          </div>
        ) : recent.length === 0 ? (
          <EmptyState
            icon={<Clapperboard className="h-8 w-8" />}
            title="No videos yet"
            body="Create your first avatar video. It takes about a minute."
            action={
              <Link href="/create" className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
                Create video
              </Link>
            }
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {recent.map((v) => (
              <VideoCard key={v.id} video={v} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
