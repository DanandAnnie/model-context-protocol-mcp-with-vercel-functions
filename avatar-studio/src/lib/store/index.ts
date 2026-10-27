// Persistence abstraction. Supabase when configured, in-memory otherwise.
import { config } from "../config";
import { MemoryStore } from "./memory";
import { SupabaseStore } from "./supabase";

export type ItemKind = "video" | "avatar" | "translation" | "brand" | "apikey" | "notify" | "workspace" | "invite" | "membership" | "plan" | "agent" | "conversation" | "voice" | "prefs" | "template" | "sharelock" | "cover" | "comment" | "activity" | "clip" | "clipaudio" | "videolead" | "usage" | "backdrop" | "backdropdata" | "portrait" | "highlight" | "cleanup" | "lipsync" | "lookpack" | "madelook";

export interface Store {
  /** True when every instance of the app reads the same data (a missing record is then really gone). */
  readonly durable?: boolean;
  /** All items of a kind, optionally only those whose `ownerId` matches. */
  list<T>(kind: ItemKind, ownerId?: string): Promise<T[]>;
  get<T>(kind: ItemKind, id: string): Promise<T | null>;
  put<T extends { id: string }>(kind: ItemKind, item: T): Promise<T>;
  /**
   * Writes `item` only while the stored record's top-level `field` still equals `expected`, in one step (so two
   * requests that read the same record cannot both win); false when it no longer does or the record is gone.
   */
  putIf<T extends { id: string }>(kind: ItemKind, item: T, field: string, expected: string): Promise<boolean>;
  /** Writes `item` only when no record has its id yet, in one step; false when one already does. */
  insert<T extends { id: string }>(kind: ItemKind, item: T): Promise<boolean>;
  remove(kind: ItemKind, id: string): Promise<void>;
  /** Find the first item whose top-level `field` equals `value` (used for webhook lookups by provider job id). */
  findBy<T>(kind: ItemKind, field: string, value: string): Promise<T | null>;
}

declare global {
  // eslint-disable-next-line no-var
  var __avatarStudioStore: Store | undefined;
}

export function getStore(): Store {
  if (globalThis.__avatarStudioStore) return globalThis.__avatarStudioStore;
  const store =
    config.supabaseUrl && config.supabaseServiceRoleKey
      ? new SupabaseStore(config.supabaseUrl, config.supabaseServiceRoleKey)
      : new MemoryStore();
  globalThis.__avatarStudioStore = store;
  return store;
}

export function persistenceKind(): "memory" | "supabase" {
  return config.supabaseUrl && config.supabaseServiceRoleKey ? "supabase" : "memory";
}
