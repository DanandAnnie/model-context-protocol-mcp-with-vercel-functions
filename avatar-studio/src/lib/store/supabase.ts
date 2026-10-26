import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ItemKind, Store } from "./index";

const TABLE = "studio_items";

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

  async list<T>(kind: ItemKind, ownerId?: string): Promise<T[]> {
    let query = this.client.from(TABLE).select("data").eq("kind", kind);
    if (ownerId !== undefined) query = query.eq("data->>ownerId", ownerId);
    const { data, error } = await query.order("created_at", { ascending: false });
    if (error) throw new Error(`supabase list failed: ${error.message}`);
    return (data ?? []).map((r) => r.data as T);
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
