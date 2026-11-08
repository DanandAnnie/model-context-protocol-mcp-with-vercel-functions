// The account's HeyGen brand kit, which HeyGen's Video Agent dresses its directed videos in. Used by API routes, the
// directed-video start, and account deletion only.
import { createHash } from "node:crypto";
import { z } from "zod";
import { newId, nowIso } from "../ids";
import { getStore } from "../store";
import { getAvatarProvider, getAvatarProviderByName } from "../providers";
import { LOCAL_OWNER } from "../owner-id";
import { ValidationError } from "../errors";
import type { AgentBrandKit, Video } from "../types";
import { getBrandKit } from "./brand";
import { stripUndefined } from "./shared";

export const agentBrandSchema = z.object({ url: z.string().trim().min(1, "Enter the website's address").max(2000) });

/** How soon a kit HeyGen is still reading is asked about again, so a page polling it does not ask on every call. */
const RECHECK_MS = 2_000;
/** How long HeyGen may read a page before the kit is taken as stopped early (an import usually settles in two minutes). */
export const AGENT_KIT_LOADING_LIMIT_MS = 15 * 60_000;
/**
 * How long a kit the account stopped using is kept at the renderer before it may be deleted: a directed video that
 * read it just before has started (and is stored, naming it) well within this.
 */
export const AGENT_KIT_GRACE_MS = 10 * 60_000;
/** How often a kit still named by a video is looked at again, from the Brand page's reads. */
const RESWEEP_MS = 60 * 60_000;
/** Imports of one page within this window are one import at the renderer, so a retried or timed-out call makes no second kit. */
const IMPORT_WINDOW_MS = 10 * 60_000;

/** Whether the renderer can import a brand kit for its Video Agent. */
export function agentBrandAvailable(): boolean {
  const provider = getAvatarProvider();
  return !!(provider.startDirected && provider.importBrandKit && provider.brandKitDetails);
}

async function kitsOf(ownerId: string): Promise<AgentBrandKit[]> {
  return (await getStore().list<AgentBrandKit>("agentbrand", ownerId)).filter((k) => k.ownerId === ownerId);
}

/** The account's kit in use, made by the renderer in use (one another renderer made is none here). */
function currentOf(kits: AgentBrandKit[]): AgentBrandKit | undefined {
  const renderer = getAvatarProvider().name;
  return kits.find((k) => k.current && k.provider === renderer);
}

/**
 * The page to import, as HeyGen is sent it: an address without a scheme is taken as https, a fragment is dropped, and
 * only a public-looking http(s) address is taken (HeyGen reads the page itself, not the studio).
 */
export function agentBrandUrl(raw: string): string {
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new ValidationError("Enter a website address like https://example.com");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ValidationError("Enter a website address like https://example.com");
  if (url.username || url.password) throw new ValidationError("Enter the website's address without a user name or password");
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || host.startsWith("[") || /^\d+(?:\.\d+){3}$/.test(host) || /\.(?:local|localhost|internal)$/.test(host)) {
    throw new ValidationError("Enter a public website address like https://example.com");
  }
  url.hash = "";
  return url.toString();
}

/**
 * The account's HeyGen brand kit, or null when none is in use. While HeyGen is still reading the page, it is asked
 * again (at most every two seconds) and what it has read so far is kept; trouble asking leaves the kit as it was, and a
 * kit still reading after fifteen minutes is taken as stopped early. Kits the account no longer uses are deleted at the
 * renderer here too, once their grace has passed.
 */
export async function getAgentBrand(ownerId: string = LOCAL_OWNER): Promise<AgentBrandKit | null> {
  const kits = await kitsOf(ownerId);
  if (kits.some((k) => due(k))) await sweep(ownerId).catch((err) => console.error(`brand kit sweep failed for ${ownerId}:`, err));
  const kit = currentOf(kits);
  if (!kit) return null;
  if (kit.status !== "loading" || Date.now() - Date.parse(kit.checkedAt) < RECHECK_MS) return kit;
  const provider = getAvatarProvider();
  let details;
  try {
    details = provider.brandKitDetails ? await provider.brandKitDetails(kit.kitId) : undefined;
  } catch {
    details = undefined;
  }
  const at = nowIso();
  const late = Date.now() - Date.parse(kit.createdAt) > AGENT_KIT_LOADING_LIMIT_MS;
  let next: AgentBrandKit;
  if (details === null) {
    next = { ...kit, status: "error", missing: true, error: "HeyGen no longer has this brand kit; import it again", checkedAt: at, updatedAt: at };
  } else if (details) {
    const status = details.status === "loading" && late ? "error" : details.status;
    next = stripUndefined({
      ...kit,
      status,
      name: details.name ?? kit.name,
      colors: details.colors.length ? details.colors : undefined,
      logoUrl: details.logoUrl,
      fonts: details.fonts.length ? details.fonts : undefined,
      error: status === "error" ? "HeyGen stopped reading the page early; its Video Agent uses what it found" : undefined,
      checkedAt: at,
      updatedAt: at,
    });
  } else if (late) {
    next = { ...kit, status: "error", error: "HeyGen did not say it finished reading the page; its Video Agent uses what it found", checkedAt: at, updatedAt: at };
  } else {
    return kit;
  }
  // Only over the row as it was read, so a kit removed or replaced meanwhile is not brought back.
  return (await getStore().putIf("agentbrand", next, "updatedAt", kit.updatedAt)) ? next : (currentOf(await kitsOf(ownerId)) ?? null);
}

/**
 * Imports the page as the account's HeyGen brand kit, in place of the one it had: HeyGen reads it in the background
 * (the kit is used from now on, while it does), named for the Brand page's brand, else the site. The same page asked
 * again within ten minutes, with the same kit in use, is the same import at HeyGen (its idempotency key), so a call
 * retried after one that timed out makes no second kit; once the kit in use has changed, an import is a new one.
 */
export async function importAgentBrand(input: z.infer<typeof agentBrandSchema>, ownerId: string = LOCAL_OWNER): Promise<AgentBrandKit> {
  const provider = getAvatarProvider();
  if (!agentBrandAvailable() || !provider.importBrandKit) throw new ValidationError(`HeyGen brand kits are not available with the ${provider.name} renderer`);
  const url = agentBrandUrl(input.url);
  const name = ((await getBrandKit(ownerId))?.name || new URL(url).hostname.replace(/^www\./i, "")).slice(0, 80);
  const before = currentOf(await kitsOf(ownerId));
  const key = `kitimport_${createHash("sha256").update(`${ownerId}\n${url}\n${Math.floor(Date.now() / IMPORT_WINDOW_MS)}\n${before?.id ?? "-"}`).digest("hex").slice(0, 32)}`;
  const { kitId } = await provider.importBrandKit({ url, name }, key);
  const kits = await kitsOf(ownerId);
  const same = currentOf(kits);
  if (same?.kitId === kitId && !same.missing) return same;
  const at = nowIso();
  const kit: AgentBrandKit = { id: newId("agentbrand"), ownerId, current: true, provider: provider.name, url, kitId, status: "loading", name, checkedAt: at, createdAt: at, updatedAt: at };
  // The kit HeyGen gave back for this key may be one the account used before: that row is let go of, not deleted there.
  for (const old of kits) if (old.kitId === kitId && old.provider === provider.name) await getStore().remove("agentbrand", old.id);
  await retire(ownerId);
  await getStore().put("agentbrand", kit);
  await sweep(ownerId);
  return kit;
}

/** Stops using the account's HeyGen brand kit; the renderer's copy is deleted once no video of the account names it. */
export async function removeAgentBrand(ownerId: string = LOCAL_OWNER): Promise<void> {
  await retire(ownerId);
  await sweep(ownerId);
}

/** The kit a directed video starting now is dressed in, if any: never one the renderer no longer has, or another renderer's. */
export async function agentKitFor(ownerId: string): Promise<{ kitId: string; name: string } | null> {
  const kit = currentOf(await kitsOf(ownerId));
  if (!kit || kit.missing) return null;
  return { kitId: kit.kitId, name: kit.name || new URL(kit.url).hostname };
}

async function retire(ownerId: string): Promise<void> {
  const at = nowIso();
  for (const kit of await kitsOf(ownerId)) {
    if (!kit.current) continue;
    const { current: _current, ...rest } = kit;
    await getStore().put("agentbrand", { ...rest, retiredAt: at, updatedAt: at });
  }
}

/** Whether a kit no longer used may be looked at for deletion: past its grace, and not looked at in the last hour. */
function due(kit: AgentBrandKit, now = Date.now()): boolean {
  if (kit.current) return false;
  if (now - Date.parse(kit.retiredAt ?? kit.updatedAt) < AGENT_KIT_GRACE_MS) return false;
  return !kit.sweptAt || now - Date.parse(kit.sweptAt) >= RESWEEP_MS;
}

/**
 * Deletes at the renderer the kits the account no longer uses, once their grace has passed, that none of its videos
 * (in the trash too) names, since a video's HeyGen session goes on using its kit for answers and scene edits; never a
 * kit a kit in use shares. Best effort: one that cannot be deleted now is tried again later.
 */
async function sweep(ownerId: string): Promise<void> {
  const kits = await kitsOf(ownerId);
  const unused = kits.filter((k) => due(k));
  if (!unused.length) return;
  const inUse = new Set(kits.filter((k) => k.current).map((k) => `${k.provider}:${k.kitId}`));
  const named = new Set((await getStore().list<Video>("video", ownerId)).map((v) => v.directed?.brandKitId).filter(Boolean));
  for (const kit of unused) {
    if (inUse.has(`${kit.provider}:${kit.kitId}`)) {
      await getStore().remove("agentbrand", kit.id);
    } else if (named.has(kit.kitId) || !(await dropAgentBrand(kit))) {
      await getStore().putIf("agentbrand", { ...kit, sweptAt: nowIso() }, "updatedAt", kit.updatedAt);
    } else {
      await getStore().remove("agentbrand", kit.id);
    }
  }
}

/** Deletes a kit at the renderer that made it (as the account is deleted, or once unused); whether it is gone there. */
export async function dropAgentBrand(kit: AgentBrandKit): Promise<boolean> {
  if (kit.missing) return true;
  try {
    await getAvatarProviderByName(kit.provider).deleteBrandKit?.(kit.kitId);
    return true;
  } catch (err) {
    console.error(`brand kit ${kit.id} was not deleted at the renderer:`, err);
    return false;
  }
}
