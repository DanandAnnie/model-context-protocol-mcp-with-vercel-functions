// Video translations and provider webhooks. Used by API routes only.
import { z } from "zod";
import { newId, nowIso } from "../ids";
import { getTranslateProvider, getTranslateProviderByName } from "../providers";
import { getStore } from "../store";
import type { Translation } from "../types";
import { LOCAL_OWNER } from "../owner-id";
import { owned, stripUndefined } from "./shared";

export const translationRequestSchema = z.object({
  title: z.string().trim().min(1).max(120),
  sourceVideoUrl: z.string().url(),
  targetLanguage: z.string().trim().min(2).max(40),
});

export async function createTranslation(req: z.infer<typeof translationRequestSchema>, ownerId: string = LOCAL_OWNER): Promise<Translation> {
  const provider = getTranslateProvider();
  const base: Translation = {
    ...req,
    id: newId("tr"),
    ownerId,
    status: "queued",
    provider: provider.name,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  try {
    const { providerJobId } = await provider.createTranslation(req);
    base.providerJobId = providerJobId;
    base.status = "processing";
  } catch (err) {
    base.status = "failed";
    base.error = err instanceof Error ? err.message : String(err);
  }
  return getStore().put("translation", base);
}

export async function listTranslations(ownerId: string = LOCAL_OWNER): Promise<Translation[]> {
  const items = await getStore().list<Translation>("translation", ownerId);
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return items;
}

export async function getTranslation(id: string, ownerId: string = LOCAL_OWNER): Promise<Translation> {
  const item = owned(await getStore().get<Translation>("translation", id), ownerId, `Translation ${id}`);
  if (!item.providerJobId || (item.status !== "processing" && item.status !== "queued")) return item;
  try {
    const update = await getTranslateProviderByName(item.provider).getStatus(item.providerJobId);
    const next: Translation = { ...item, ...stripUndefined(update), updatedAt: nowIso() };
    if (next.status !== item.status) await getStore().put("translation", next);
    return next;
  } catch (err) {
    console.error(`translation refresh failed for ${id}:`, err);
    return item;
  }
}

export function supportedLanguages(): string[] {
  return getTranslateProvider().supportedLanguages();
}
