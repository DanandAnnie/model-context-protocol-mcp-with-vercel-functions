import type { Collection } from "./services/collections";

/** A shared folder as the API shows it to its owner: its public link, counts, and note. */
export function collectionJson(c: Collection, origin: string) {
  return {
    id: c.id,
    folder: c.folder,
    url: `${origin.replace(/\/$/, "")}/collection/${c.id}`,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    views: c.views ?? 0,
    lastViewedAt: c.lastViewedAt ?? null,
    note: c.note ?? null,
  };
}
