import Link from "next/link";

export const metadata = { title: "Consent (demo)" };

/**
 * The demo renderer's stand-in for HeyGen's consent page. With HeyGen, the person in the footage opens their link and
 * records a short statement on camera; in demo mode nothing is recorded and consent counts as given a few seconds later.
 */
export default function DemoConsentPage() {
  return (
    <main className="mx-auto max-w-lg px-4 py-16 text-slate-800">
      <h1 className="text-xl font-semibold">Consent for a digital twin (demo)</h1>
      <p className="mt-3 text-sm leading-6">
        With the HeyGen renderer, this link opens HeyGen&apos;s consent page, where the person in the footage records a short statement on camera agreeing to be made
        into a digital twin. HeyGen reviews it, usually within a few minutes, before the twin can be used.
      </p>
      <p className="mt-3 text-sm leading-6">In demo mode nothing is recorded: consent counts as given a few seconds after the link was made.</p>
      <Link href="/avatars" className="mt-6 inline-block text-sm font-medium text-brand-700 hover:underline">
        Back to the avatars
      </Link>
    </main>
  );
}
