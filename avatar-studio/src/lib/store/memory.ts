import type { ItemKind, Store } from "./index";

/**
 * In-process store. Survives hot reloads in `next dev` (held on globalThis)
 * but NOT cold starts on serverless hosts. Configure Supabase for production.
 */
export class MemoryStore implements Store {
  private data = new Map<ItemKind, Map<string, unknown>>();
  /** Which kind owns each id: the Supabase table keys every kind by id alone, so this store refuses the same id under two kinds. */
  private kindOf = new Map<string, ItemKind>();

  private bucket(kind: ItemKind): Map<string, unknown> {
    let b = this.data.get(kind);
    if (!b) {
      b = new Map();
      this.data.set(kind, b);
    }
    return b;
  }

  async list<T>(kind: ItemKind, ownerId?: string): Promise<T[]> {
    const all = [...this.bucket(kind).values()] as T[];
    if (ownerId === undefined) return all;
    return all.filter((v) => ((v as { ownerId?: string }).ownerId ?? "local") === ownerId);
  }

  async get<T>(kind: ItemKind, id: string): Promise<T | null> {
    return (this.bucket(kind).get(id) as T | undefined) ?? null;
  }

  async put<T extends { id: string }>(kind: ItemKind, item: T): Promise<T> {
    const holder = this.kindOf.get(item.id);
    if (holder && holder !== kind) {
      throw new Error(`id ${item.id} already belongs to a ${holder} record; a ${kind} record cannot reuse it (one table, one key)`);
    }
    this.kindOf.set(item.id, kind);
    this.bucket(kind).set(item.id, item);
    return item;
  }

  async remove(kind: ItemKind, id: string): Promise<void> {
    if (this.bucket(kind).delete(id)) this.kindOf.delete(id);
  }

  async findBy<T>(kind: ItemKind, field: string, value: string): Promise<T | null> {
    for (const v of this.bucket(kind).values()) {
      if ((v as Record<string, unknown>)[field] === value) return v as T;
    }
    return null;
  }
}
