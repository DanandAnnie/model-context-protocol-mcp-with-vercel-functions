"use client";
import { Card, SectionTitle } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { formatSeconds } from "@/lib/client";
import type { ProviderStatus, Video } from "@/lib/types";

const ROWS: Array<{ key: keyof Omit<ProviderStatus, "mode" | "authEnabled">; label: string; env: string; options: string }> = [
  { key: "avatar", label: "Avatar rendering", env: "AVATAR_PROVIDER + HEYGEN_API_KEY / DID_API_KEY", options: "heygen, did, mock" },
  { key: "tts", label: "Voices / text-to-speech", env: "TTS_PROVIDER + ELEVENLABS_API_KEY / HEYGEN_API_KEY", options: "elevenlabs, heygen, mock" },
  { key: "script", label: "AI script writer", env: "SCRIPT_PROVIDER + ANTHROPIC_API_KEY", options: "anthropic, mock" },
  { key: "translate", label: "Video translation", env: "HEYGEN_API_KEY", options: "heygen, mock" },
  { key: "persistence", label: "Storage", env: "SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY", options: "supabase, memory" },
];

function summarize(videos: Video[]) {
  return {
    total: videos.length,
    completed: videos.filter((v) => v.status === "completed").length,
    processing: videos.filter((v) => v.status === "processing" || v.status === "queued").length,
    failed: videos.filter((v) => v.status === "failed").length,
    seconds: videos.reduce((n, v) => n + (v.status === "completed" ? v.durationSec ?? 0 : 0), 0),
  };
}

export default function SettingsPage() {
  const { data } = useApi<ProviderStatus>("/api/status");
  const { data: videoData } = useApi<{ videos: Video[] }>("/api/videos");
  const usage = summarize(videoData?.videos ?? []);
  return (
    <>
      <SectionTitle title="Settings" subtitle="Providers are configured with environment variables on the server, never from the browser." />
      <Card className="mb-6 grid grid-cols-2 divide-x divide-slate-100 sm:grid-cols-5">
        {[
          ["Videos", String(usage.total)],
          ["Completed", String(usage.completed)],
          ["Processing", String(usage.processing)],
          ["Failed", String(usage.failed)],
          ["Rendered", formatSeconds(usage.seconds)],
        ].map(([label, value]) => (
          <div key={label} className="px-5 py-4">
            <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
            <div className="mt-1 text-xl font-semibold text-slate-900">{videoData ? value : "…"}</div>
          </div>
        ))}
      </Card>
      <Card className="divide-y divide-slate-100">
        {ROWS.map((r) => {
          const value = data?.[r.key] ?? "…";
          const live = value !== "mock" && value !== "memory" && value !== "…";
          return (
            <div key={r.key} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
              <div>
                <div className="text-sm font-medium text-slate-900">{r.label}</div>
                <div className="mt-0.5 text-xs text-slate-500">
                  <code className="rounded bg-slate-100 px-1 py-0.5">{r.env}</code> · options: {r.options}
                </div>
              </div>
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${live ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>
                {value}
              </span>
            </div>
          );
        })}
      </Card>
      <Card className="mt-6 flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <div>
          <div className="text-sm font-medium text-slate-900">Access</div>
          <div className="mt-0.5 text-xs text-slate-500">
            <code className="rounded bg-slate-100 px-1 py-0.5">STUDIO_PASSWORD</code> · when set, every page except the landing page, login, and share pages requires sign-in
          </div>
        </div>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${data?.authEnabled ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>
          {data ? (data.authEnabled ? "password required" : "open") : "…"}
        </span>
      </Card>
      <Card className="mt-6 p-5 text-sm text-slate-600">
        <h3 className="mb-2 font-semibold text-slate-900">How to go live</h3>
        <ol className="list-decimal space-y-1 pl-5">
          <li>Copy <code className="rounded bg-slate-100 px-1">.env.example</code> to <code className="rounded bg-slate-100 px-1">.env.local</code> and add the keys you have.</li>
          <li>Set <code className="rounded bg-slate-100 px-1">AVATAR_PROVIDER</code> to <code className="rounded bg-slate-100 px-1">heygen</code> or <code className="rounded bg-slate-100 px-1">did</code>.</li>
          <li>Run <code className="rounded bg-slate-100 px-1">supabase/schema.sql</code> and set the Supabase variables so videos persist across deploys.</li>
          <li>Set <code className="rounded bg-slate-100 px-1">APP_URL</code> to your public URL so provider webhooks reach <code className="rounded bg-slate-100 px-1">/api/webhooks/&lt;provider&gt;</code>.</li>
        </ol>
      </Card>
    </>
  );
}
