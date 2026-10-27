import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ItemKind, Store } from "./index";

const TABLE = "studio_items";
/** Rows asked for per request when listing: PostgREST's default most rows per answer. */
const LIST_PAGE = 1000;

/**
 * Single-table JSON store. See supabase/schema.sql.
 * Uses the service-role key server-side only; never expose it to the browser.
 */
export class SupabaseStore implements Store {
  readonly durable = true;
  private client: SupabaseClient;

  constructor(url: string, serviceRoleKey: string, fetchImpl: typeof fetch = fetch) {
    this.client = createClient(url, serviceRoleKey, { auth: { persistSession: false }, global: { fetch: fetchImpl } });
  }

  /**
   * Every row of a kind (of one owner when given), newest first. PostgREST answers at most a page of rows (1,000 by
   * default), so the list is read page by page until a short page, ordered by id after the time so no row is skipped or
   * read twice between pages.
   */
  async list<T>(kind: ItemKind, ownerId?: string): Promise<T[]> {
    const out: T[] = [];
    for (let from = 0; ; from += LIST_PAGE) {
      let query = this.client.from(TABLE).select("data").eq("kind", kind);
      if (ownerId !== undefined) query = query.eq("data->>ownerId", ownerId);
      const { data, error } = await query
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, from + LIST_PAGE - 1);
      if (error) throw new Error(`supabase list failed: ${error.message}`);
      const rows = data ?? [];
      for (const r of rows) out.push(r.data as T);
      if (rows.length < LIST_PAGE) return out;
    }
  }

  async get<T>(kind: ItemKind, id: string): Promise<T | null> {
    const { data, error } = await this.client
      .from(TABLE)
      .select("data")
      .eq("kind", kind)
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`supabase get failed: ${error.message}`);
    return (data?.data as T | undefined) ?? null;
  }

  async put<T extends { id: string }>(kind: ItemKind, item: T): Promise<T> {
    const { error } = await this.client
      .from(TABLE)
      .upsert({ id: item.id, kind, data: item, updated_at: new Date().toISOString() });
    if (error) throw new Error(`supabase put failed: ${error.message}`);
    return item;
  }

  async insert<T extends { id: string }>(kind: ItemKind, item: T): Promise<boolean> {
    // ON CONFLICT DO NOTHING: only a row actually inserted comes back.
    const { data, error } = await this.client
      .from(TABLE)
      .upsert({ id: item.id, kind, data: item, updated_at: new Date().toISOString() }, { onConflict: "id", ignoreDuplicates: true })
      .select("id");
    if (error) throw new Error(`supabase insert failed: ${error.message}`);
    return (data ?? []).length > 0;
  }

  async putIf<T extends { id: string }>(kind: ItemKind, item: T, field: string, expected: string): Promise<boolean> {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) throw new Error(`invalid field name: ${field}`);
    // One conditional UPDATE: Postgres applies it to the row only while the stored field still matches.
    const { data, error } = await this.client
      .from(TABLE)
      .update({ data: item, updated_at: new Date().toISOString() })
      .eq("kind", kind)
      .eq("id", item.id)
      .eq(`data->>${field}`, expected)
      .select("id");
    if (error) throw new Error(`supabase putIf failed: ${error.message}`);
    return (data ?? []).length > 0;
  }

  async remove(kind: ItemKind, id: string): Promise<void> {
    const { error } = await this.client.from(TABLE).delete().eq("kind", kind).eq("id", id);
    if (error) throw new Error(`supabase remove failed: ${error.message}`);
  }

  async findBy<T>(kind: ItemKind, field: string, value: string): Promise<T | null> {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) throw new Error(`invalid field name: ${field}`);
    const { data, error } = await this.client
      .from(TABLE)
      .select("data")
      .eq("kind", kind)
      .eq(`data->>${field}`, value)
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`supabase findBy failed: ${error.message}`);
    return (data?.data as T | undefined) ?? null;
  }
}
