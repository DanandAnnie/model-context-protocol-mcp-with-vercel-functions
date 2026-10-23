"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useMobileNav } from "@/components/MobileNav";
import { WorkspaceSwitcher } from "@/components/WorkspaceSwitcher";
import { Clapperboard, Home, Languages, Layers3, LayoutTemplate, LogOut, Mic2, Palette, Settings, Users, Video, Sparkles, X } from "lucide-react";
import { useApi } from "@/hooks/useApi";
import type { ProviderStatus } from "@/lib/types";

const NAV = [
  { href: "/home", label: "Home", icon: Home },
  { href: "/create", label: "Create video", icon: Clapperboard },
  { href: "/videos", label: "My videos", icon: Video },
  { href: "/templates", label: "Templates", icon: LayoutTemplate },
  { href: "/batch", label: "Personalize", icon: Layers3 },
  { href: "/avatars", label: "Avatars", icon: Users },
  { href: "/voices", label: "Voices", icon: Mic2 },
  { href: "/translate", label: "Video translate", icon: Languages },
  { href: "/brand", label: "Brand kit", icon: Palette },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { data: status } = useApi<ProviderStatus>("/api/status");

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }
  const { open, setOpen } = useMobileNav();

  // Close the drawer on navigation.
  useEffect(() => setOpen(false), [pathname, setOpen]);

  return (
    <>
      {open && <div className="fixed inset-0 z-40 bg-slate-900/40 lg:hidden" onClick={() => setOpen(false)} />}
    <aside
      className={`fixed inset-y-0 left-0 z-50 flex h-full w-64 shrink-0 flex-col border-r border-slate-200 bg-white transition-transform lg:static lg:translate-x-0 ${
        open ? "translate-x-0" : "-translate-x-full"
      }`}
    >
      <button type="button" aria-label="Close menu" onClick={() => setOpen(false)} className="absolute right-3 top-4 rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 lg:hidden">
        <X className="h-5 w-5" />
      </button>
      <Link href="/home" className="flex items-center gap-2 px-5 py-5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-white">
          <Sparkles className="h-4 w-4" />
        </span>
        <span className="text-base font-semibold tracking-tight">Avatar Studio</span>
      </Link>

      <WorkspaceSwitcher />
      <div className="px-3">
        <Link
          href="/create"
          className="mb-4 flex w-full items-center justify-center gap-2 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-700"
        >
          <Clapperboard className="h-4 w-4" /> Create video
        </Link>
      </div>

      <nav className="flex-1 space-y-0.5 px-3">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
                active ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              }`}
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-slate-200 p-4">
        <div className="rounded-lg bg-slate-50 p-3 text-xs">
          <div className="flex items-center gap-2 font-medium text-slate-700">
            <span className={`h-2 w-2 rounded-full ${status?.mode === "live" ? "bg-emerald-500" : "bg-amber-400"}`} />
            {status ? (status.mode === "live" ? "Live providers" : "Demo mode") : "Checking…"}
          </div>
          <p className="mt-1 text-slate-500">
            {status?.mode === "live"
              ? `Rendering with ${status.avatar}; voices via ${status.tts}.`
              : "No API keys set. Renders are simulated."}
          </p>
          <Link href="/settings" className="mt-2 inline-block font-medium text-brand-600 hover:underline">
            Configure providers
          </Link>
        </div>
        {status?.authEnabled && (
          <button onClick={signOut} className="mt-2 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-100">
            <LogOut className="h-3.5 w-3.5" /> Sign out
          </button>
        )}
      </div>
    </aside>
    </>
  );
}
