import { MobileBar, MobileNavProvider } from "@/components/MobileNav";
import { QuickFind } from "@/components/QuickFind";
import { Sidebar } from "@/components/Sidebar";

export default function StudioLayout({ children }: { children: React.ReactNode }) {
  return (
    <MobileNavProvider>
      <div className="flex h-screen overflow-hidden bg-slate-50">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">
          <MobileBar />
          <div className="mx-auto max-w-6xl px-4 pb-8 pt-6 sm:px-8 lg:pt-8">{children}</div>
        </main>
      </div>
      <QuickFind />
    </MobileNavProvider>
  );
}
