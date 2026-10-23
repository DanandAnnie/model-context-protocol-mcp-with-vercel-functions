"use client";
import { Card, SectionTitle } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import type { ProviderStatus } from "@/lib/types";

const ROWS: Array<{ key: keyof Omit<ProviderStatus, "mode">; label: string; env: string; options: string }> = [
  { key: "avatar", label: "Avatar rendering", env: "AVATAR_PROVIDER + HEYGEN_API_KEY / DID_API_KEY", options: "heygen, did, mock" },
  { key: "tts", label: "Voices / text-to-speech", env: "TTS_PROVIDER + ELEVENLABS_API_KEY / HEYGEN_API_KEY", options: "elevenlabs, heygen, mock" },
  { key: "script", label: "AI script writer", env: "SCRIPT_PROVIDER + ANTHROPIC_API_KEY", options: "anthropic, mock" },
  { key: "translate", label: "Video translation", env: "HEYGEN_API_KEY", options: "heygen, mock" },
  { key: "persistence", label: "Storage", env: "SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY", options: "supabase, memory" },
];

export default function SettingsPage() {
  const { data } = useApi<ProviderStatus>("/api/status");
  return (
    <>
      <SectionTitle title="Settings" subtitle="Providers are configured with environment variables on the server, never from the browser." />
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
