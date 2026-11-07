import type { Collection } from "./services/collections";

/** A shared folder as the API shows it to its owner: its public link, counts, title, note, order, and button. */
export function collectionJson(c: Collection, origin: string) {
  return {
    id: c.id,
    folder: c.folder,
    url: `${origin.replace(/\/$/, "")}/collection/${c.id}`,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    views: c.views ?? 0,
    lastViewedAt: c.lastViewedAt ?? null,
    title: c.title ?? null,
    note: c.note ?? null,
    order: c.order ?? "newest",
    cta: c.cta ?? null,
  };
}
