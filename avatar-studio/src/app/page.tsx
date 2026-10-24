import Link from "next/link";
import { ArrowRight, Clapperboard, Languages, Mic2, Sparkles, Users, Wand2 } from "lucide-react";

const FEATURES = [
  { icon: Users, title: "Avatars", body: "Pick from a library of presenters or create a photo avatar from a single portrait." },
  { icon: Mic2, title: "Voices", body: "Dozens of natural voices across languages. Preview any voice before you render." },
  { icon: Wand2, title: "AI script writer", body: "Describe the topic, tone, and length. Get a camera-ready script in seconds." },
  { icon: Clapperboard, title: "Video generator", body: "Script in, finished talking-head video out. 16:9, 9:16, or square." },
  { icon: Languages, title: "Video translate", body: "Dub an existing video into a new language with matched lip movement." },
  { icon: Sparkles, title: "Bring your own engine", body: "Runs on HeyGen, D-ID, and ElevenLabs APIs, or in demo mode with no keys." },
];

export default function Landing() {
  return (
    <main className="min-h-screen bg-white">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-white">
            <Sparkles className="h-4 w-4" />
          </span>
          <span className="text-base font-semibold tracking-tight">Avatar Studio</span>
        </div>
        <Link href="/home" className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700">
          Open studio
        </Link>
      </header>

      <section className="mx-auto max-w-6xl px-6 pb-20 pt-16 text-center">
        <span className="inline-block rounded-full bg-brand-50 px-3 py-1 text-xs font-medium text-brand-700">AI video generation</span>
        <h1 className="mx-auto mt-5 max-w-3xl text-5xl font-semibold tracking-tight text-slate-900">
          Turn a script into a presenter-led video in minutes
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-lg text-slate-600">
          No camera, no studio, no editing. Choose an avatar and a voice, paste or generate a script, and render a finished video
          you can share or translate into other languages.
        </p>
        <div className="mt-8 flex items-center justify-center gap-3">
          <Link href="/create" className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-5 py-3 text-sm font-medium text-white hover:bg-brand-700">
            Create a video <ArrowRight className="h-4 w-4" />
          </Link>
          <Link href="/avatars" className="rounded-lg border border-slate-200 px-5 py-3 text-sm font-medium text-slate-800 hover:bg-slate-50">
            Browse avatars
          </Link>
        </div>
      </section>

      <section className="border-t border-slate-100 bg-slate-50">
        <div className="mx-auto grid max-w-6xl gap-6 px-6 py-16 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <div key={title} className="rounded-xl border border-slate-200 bg-white p-6">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
                <Icon className="h-5 w-5" />
              </span>
              <h3 className="mt-4 text-base font-semibold text-slate-900">{title}</h3>
              <p className="mt-1.5 text-sm text-slate-600">{body}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="mx-auto max-w-6xl px-6 py-8 text-xs text-slate-500">Avatar Studio. Self-hosted AI video, powered by the rendering provider you configure.</footer>
    </main>
  );
}
