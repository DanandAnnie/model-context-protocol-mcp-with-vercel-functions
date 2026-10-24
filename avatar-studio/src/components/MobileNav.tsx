"use client";
import Link from "next/link";
import { createContext, useContext, useState, type ReactNode } from "react";
import { Menu, Sparkles } from "lucide-react";

const Ctx = createContext<{ open: boolean; setOpen: (v: boolean) => void }>({ open: false, setOpen: () => {} });

/** Shares the drawer state between the sticky mobile bar (inside the scroll area) and the sidebar. */
export function MobileNavProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <Ctx.Provider value={{ open, setOpen }}>{children}</Ctx.Provider>;
}

export function useMobileNav() {
  return useContext(Ctx);
}

/** Top bar on small screens. Sticky inside the scroll container, so content scrolls under it instead of behind a floating button. */
export function MobileBar() {
  const { setOpen } = useMobileNav();
  return (
    <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-slate-200 bg-white/95 px-3 py-2 backdrop-blur lg:hidden">
      <button type="button" aria-label="Open menu" onClick={() => setOpen(true)} className="rounded-lg p-2 text-slate-700 hover:bg-slate-100">
        <Menu className="h-5 w-5" />
      </button>
      <Link href="/home" className="flex items-center gap-2 text-sm font-semibold tracking-tight text-slate-900">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-brand-600 text-white">
          <Sparkles className="h-3.5 w-3.5" />
        </span>
        Avatar Studio
      </Link>
    </header>
  );
}
