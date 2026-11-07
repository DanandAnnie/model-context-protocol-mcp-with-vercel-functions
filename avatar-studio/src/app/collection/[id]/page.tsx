import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { Lock, Play, Sparkles } from "lucide-react";
import { NotFoundError, collectionPage, getBrandKit } from "@/lib/services";
import { formatSeconds, isDarkHex } from "@/lib/client";
import { publicLogoSrc } from "@/lib/brand-logo";
import { CollectionViewBeacon } from "@/components/CollectionViewBeacon";

export const dynamic = "force-dynamic";

// One read per request: the metadata and the page share it.
const load = cache(async (id: string) => {
  try {
    return await collectionPage(id);
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
});

/** The page's heading (its title, else the folder's name) under the brand's; kept out of search results, as the link is meant for the people it is sent to. */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const page = await load(id);
  if (!page) return { title: "Not found", robots: { index: false, follow: false } };
  const brand = await getBrandKit(page.collection.ownerId);
  const siteName = brand?.name || "Avatar Studio";
  const heading = page.collection.title || page.collection.folder;
  const count = page.total === 1 ? "1 video" : `${page.total} videos`;
  // The owner's note says what the page is better than a count, where there is one.
  const description = page.collection.note ? Array.from(page.collection.note.replace(/\s+/g, " ")).slice(0, 200).join("") : `${count} from ${siteName}`;
  return {
    title: `${heading} · ${siteName}`,
    description,
    robots: { index: false, follow: false },
    openGraph: { title: heading, description, siteName, type: "website" },
  };
}

/**
 * A shared folder's public page: its heading (the owner's title, else the folder's name) and a card for each of its videos whose share link can be sent now,
 * in the order its owner chose (newest first unless set), each opening that video's own share page (which asks for a password or an email where its owner set
 * one). Not found once the owner stops sharing the folder.
 */
export default async function CollectionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await load(id);
  if (!page) notFound();
  const { collection, videos, total } = page;
  const brand = await getBrandKit(collection.ownerId);
  const accent = brand?.accentColor ?? brand?.primaryColor;
  // An uploaded logo is served by a video's logo route, so the page needs one of the folder's videos to show it.
  const logoSrc = videos[0] ? publicLogoSrc(brand, `/api/videos/${encodeURIComponent(videos[0].id)}/logo`) : brand?.logoUrl?.startsWith("data:") ? undefined : brand?.logoUrl;
  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <CollectionViewBeacon collectionId={collection.id} />
      {accent && <div className="h-1.5" style={{ background: accent }} aria-hidden />}
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
        {brand && (brand.name || logoSrc) ? (
          <div className="flex items-center gap-3 text-sm font-medium text-slate-200" data-testid="collection-brand">
            {logoSrc && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoSrc} alt={brand.name ? `${brand.name} logo` : "Logo"} className="h-8 max-w-[140px] object-contain" />
            )}
            {brand.name && <span>{brand.name}</span>}
          </div>
        ) : (
          <Link href="/" className="flex items-center gap-2 text-sm font-medium text-slate-300 hover:text-white">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-600 text-white">
              <Sparkles className="h-3.5 w-3.5" />
            </span>
            Avatar Studio
          </Link>
        )}
      </header>
      <section className="mx-auto max-w-5xl px-6 pb-16">
        <h1 className="text-xl font-semibold" data-testid="collection-title">{collection.title || collection.folder}</h1>
        {collection.note && (
          <p className="mt-2 max-w-2xl whitespace-pre-line text-sm text-slate-300" data-testid="collection-note">
            {collection.note}
          </p>
        )}
        <p className="mt-1 text-sm text-slate-400" data-testid="collection-count">
          {total === 0
            ? "No videos to watch here yet."
            : total > videos.length
              ? collection.order === "oldest"
                ? `The oldest ${videos.length} of ${total} videos`
                : collection.order === "title"
                  ? `The first ${videos.length} of ${total} videos, by title`
                  : `The newest ${videos.length} of ${total} videos`
              : total === 1
                ? "1 video"
                : `${total} videos`}
        </p>
        {collection.cta && (
          // The owner's button, in the brand's colour as on a video's share page; it opens in a new tab.
          <div className="mt-4">
            <a
              href={collection.cta.url}
              target="_blank"
              rel="noreferrer noopener"
              data-testid="collection-cta"
              className="inline-flex max-w-full items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-semibold shadow-sm [overflow-wrap:anywhere] hover:opacity-90"
              style={{ background: accent ?? "#4f46e5", color: isDarkHex(accent ?? "#4f46e5") ? "#fff" : "#0f172a" }}
            >
              {collection.cta.label}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </div>
        )}
        {videos.length > 0 && (
          <ul className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3" data-testid="collection-videos">
            {videos.map((v) => (
              <li key={v.id}>
                <a href={`/share/${v.id}`} className="group block rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400" data-testid="collection-video">
                  <div className="relative aspect-video overflow-hidden rounded-xl bg-slate-800">
                    {v.poster ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={v.poster} alt="" className="h-full w-full object-cover transition group-hover:opacity-90" loading="lazy" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-slate-500">
                        {v.locked ? <Lock className="h-8 w-8" aria-hidden /> : <Play className="h-8 w-8" aria-hidden />}
                      </div>
                    )}
                    {v.durationSec != null && (
                      <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-xs text-white">{formatSeconds(v.durationSec)}</span>
                    )}
                  </div>
                  <p className="mt-2 text-sm font-medium text-slate-100 group-hover:underline">{v.title}</p>
                  {v.locked && <p className="text-xs text-slate-400">Password protected</p>}
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
