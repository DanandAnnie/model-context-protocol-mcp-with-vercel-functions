import type { Metadata } from "next";
import Link from "next/link";
import { Sparkles } from "lucide-react";

export const metadata: Metadata = { title: "Not available · Avatar Studio", robots: { index: false, follow: false } };

/**
 * What a visitor sees for a link that answers not found: most often a shared video or folder whose link has expired,
 * been switched off, or not gone live yet, so the page says so in plain words rather than a bare "404". It names no
 * reason in particular, as a link that never existed must look the same as one that stopped.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 py-16 text-slate-100">
      <div className="max-w-md text-center" data-testid="not-found">
        <span className="mx-auto mb-6 flex h-10 w-10 items-center justify-center rounded-lg bg-brand-600 text-white" aria-hidden>
          <Sparkles className="h-5 w-5" />
        </span>
        <h1 className="text-xl font-semibold">This link isn&apos;t available</h1>
        <p className="mt-3 text-sm text-slate-300">
          The person who shared it may have set it to expire, switched it off, or not made it live yet. If you were expecting a video here, ask them
          for a new link.
        </p>
        <p className="mt-6 text-sm">
          <Link href="/" className="font-medium text-brand-300 underline underline-offset-2 hover:text-brand-200">
            Go to Avatar Studio
          </Link>
        </p>
      </div>
    </main>
  );
}
