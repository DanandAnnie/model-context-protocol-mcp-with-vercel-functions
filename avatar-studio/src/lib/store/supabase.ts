import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ItemKind, Store } from "./index";

const TABLE = "studio_items";

/**
 * Single-table JSON store. See supabase/schema.sql.
 * Uses the service-role key server-side only; never expose it to the browser.
 */
export class SupabaseStore implements Store {
  private client: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.client = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  }

  async list<T>(kind: ItemKind): Promise<T[]> {
    const { data, error } = await this.client
      .from(TABLE)
      .select("data")
      .eq("kind", kind)
      .order("created_at", { ascending: false });
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

  async remove(kind: ItemKind, id: string): Promise<void> {
    const { error } = await this.client.from(TABLE).delete().eq("kind", kind).eq("id", id);
    if (error) throw new Error(`supabase remove failed: ${error.message}`);
  }

  async find<T>(kind: ItemKind, predicate: (item: T) => boolean): Promise<T | null> {
    const all = await this.list<T>(kind);
    return all.find(predicate) ?? null;
  }
}
