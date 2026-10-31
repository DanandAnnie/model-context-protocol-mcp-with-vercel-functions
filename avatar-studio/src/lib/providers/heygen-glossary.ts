// The HeyGen workspace's brand glossary, shared by every account of this studio. Since October 2026 a workspace has
// one glossary (a second create is a 409), so the studio adds the rules a request needs to that one glossary rather
// than making its own: each rule scoped to the request's language, existing rules (the studio's for other requests,
// and any set in HeyGen's app) kept, and a rule for the same term and language replaced by the latest request's.
import { createHash, randomUUID } from "node:crypto";
import { HeyGenClient, type GlossaryLists } from "./heygen-client";

/** The name the studio gives the glossary it makes or adopts. */
export const STUDIO_GLOSSARY_NAME = "Avatar Studio";
/** How the studio named its glossaries when each set of terms had one (before glossaries were one per workspace). */
const LEGACY_NAME = /^Avatar Studio terms [0-9a-f]{16}$/i;
/** How long a set of rules, once in the glossary, is trusted to still be there before it is read again. */
const ENSURED_TTL_MS = 10 * 60_000;
/** Pages of 100 glossaries read when looking for the workspace's. */
const MAX_GLOSSARY_PAGES = 50;
/** Tries at a write another writer got in before (or undid). */
const UPDATE_TRIES = 3;
/** How long to wait before looking the glossary up again when another request is still making it. */
const LOOKUP_RETRY_MS = 1_000;

/**
 * What a request needs the glossary to say, in one language (a base code such as "fr"): terms translated exactly so
 * (for dubs), and terms said differently (for videos HeyGen voices).
 */
export interface GlossaryRules {
  /** The language every rule applies in; required, as a rule for all languages would reach every account's videos. */
  code: string;
  /** Terms translated exactly so (a term to keep as written is translated to itself). */
  forced?: Array<{ term: string; translation: string }>;
  /** Terms the voice says another way ("Nair" said "Nye-er"); captions keep the spelling. */
  say?: Array<{ term: string; pronunciation: string }>;
}

type Forced = NonNullable<GlossaryLists["forced_translations"]>[number];
type Said = NonNullable<GlossaryLists["terms"]>[number];
type Lang = Forced["target_language"];

/** A rule's place in its list: its term (HeyGen matches without regard to case) in its language. */
const keyOf = (term: string, lang: Lang) => `${term.trim().toLowerCase()}\0${lang?.scope === "specific" ? lang.code.toLowerCase() : "*"}`;
const forcedKey = (r: Forced) => keyOf(r.term, r.target_language);
const saidKey = (r: Said) => keyOf(r.term, r.pronunciation_language);

/** This server instance's glossary id, and the rule sets it put there lately (by digest, with when). */
let knownId: string | undefined;
const ensured = new Map<string, number>();

/** Forgets what this instance knows (tests, and a glossary HeyGen no longer has). */
export function forgetGlossary(): void {
  knownId = undefined;
  ensured.clear();
}

/** The glossary work of this instance, in order. */
let queue: Promise<unknown> = Promise.resolve();

/**
 * The workspace glossary's id with `rules` in it, or undefined when there are none. The glossary is read and, when a
 * rule is missing or says otherwise, written back whole with it changed or added (HeyGen replaces a list in full),
 * then read again to see the write held (another writer, here or in HeyGen's app, may have written over it; a
 * concurrent edit HeyGen notices is a 409): either way it is tried again. One server instance writes one at a time;
 * a set of rules once written is trusted for ten minutes, until this instance writes another. `fresh` forgets the
 * remembered id and rules, for a glossary a request was refused for naming.
 */
export function glossaryWith(client: HeyGenClient, rules: GlossaryRules, fresh = false): Promise<string | undefined> {
  const lang = { scope: "specific" as const, code: rules.code };
  const wanted: Wanted = {
    forced: (rules.forced ?? []).map(({ term, translation }) => ({ term: term.trim(), translation: translation.trim(), target_language: lang })).filter((r) => r.term && r.translation),
    said: (rules.say ?? []).map(({ term, pronunciation }) => ({ term: term.trim(), pronunciation: pronunciation.trim(), pronunciation_language: lang })).filter((r) => r.term && r.pronunciation),
  };
  // One rule per term and language, the first (as renders take a word's first rule): two would replace each other
  // in the glossary at every write, so it would never settle.
  wanted.forced = wanted.forced.filter((r, i) => wanted.forced.findIndex((q) => forcedKey(q) === forcedKey(r)) === i);
  wanted.said = wanted.said.filter((r, i) => wanted.said.findIndex((q) => saidKey(q) === saidKey(r)) === i);
  if (!wanted.forced.length && !wanted.said.length) return Promise.resolve(undefined);
  if (fresh) forgetGlossary();
  const digest = createHash("sha256")
    .update(JSON.stringify([wanted.forced.map((r) => [forcedKey(r), r.translation]).sort(), wanted.said.map((r) => [saidKey(r), r.pronunciation]).sort()]))
    .digest("hex");
  // Known and trusted: no need to wait behind another request's write.
  const at = ensured.get(digest);
  if (knownId && at && Date.now() - at < ENSURED_TTL_MS) return Promise.resolve(knownId);
  const run = queue.then(() => ensureRules(client, wanted, digest));
  queue = run.catch(() => undefined);
  return run;
}

/** The rules a request wants, as HeyGen writes them. */
interface Wanted {
  forced: Forced[];
  said: Said[];
}

async function ensureRules(client: HeyGenClient, wanted: Wanted, digest: string): Promise<string> {
  let foundAgain = false;
  for (let attempt = 1; ; attempt++) {
    const id = knownId ?? (await workspaceGlossary(client, wanted));
    knownId = id;
    let current: GlossaryLists;
    try {
      current = await client.getGlossary(id);
    } catch (err) {
      if (goneOnce(err)) continue;
      throw err;
    }
    // Only the lists that change are sent, so the others (and their rules from HeyGen's app) are not touched.
    const change: GlossaryLists = {};
    const nextForced = merged(current.forced_translations ?? [], wanted.forced, forcedKey, (a, b) => a.translation === b.translation);
    if (nextForced) change.forced_translations = nextForced;
    const nextSaid = merged(current.terms ?? [], wanted.said, saidKey, (a, b) => a.pronunciation === b.pronunciation);
    if (nextSaid) change.terms = nextSaid;
    if (!nextForced && !nextSaid) {
      ensured.set(digest, Date.now());
      return id;
    }
    if (attempt > UPDATE_TRIES) throw new Error("HeyGen's brand glossary kept changing while the studio wrote its rules to it");
    try {
      await client.updateGlossary(id, change);
    } catch (err) {
      if (goneOnce(err)) continue;
      // Another writer got in first (or a rule was repeated meanwhile): read it again and apply the rules again.
      if (/ failed: 409\b/.test(err instanceof Error ? err.message : "")) continue;
      throw err;
    }
    // Rules this instance trusted may have been replaced by this write: they are read again next time.
    ensured.clear();
    // Read again on the next turn: the write must hold (no other writer put the list back without it).
  }

  /** A glossary deleted in HeyGen since it was found: found (or made) again, once. */
  function goneOnce(err: unknown): boolean {
    if (foundAgain || !/ failed: 404\b/.test(err instanceof Error ? err.message : "")) return false;
    foundAgain = true;
    forgetGlossary();
    return true;
  }
}

/**
 * `current` with `wanted` in it: a rule for the same term and language replaced, others added at the end, and the
 * rest kept as they are (their language fields included, as HeyGen asks). Undefined when nothing would change.
 */
function merged<T>(current: T[], wanted: T[], key: (r: T) => string, same: (a: T, b: T) => boolean): T[] | undefined {
  const next = [...current];
  const at = new Map(next.map((r, i) => [key(r), i]));
  let changed = false;
  for (const rule of wanted) {
    const i = at.get(key(rule));
    if (i === undefined) {
      at.set(key(rule), next.length);
      next.push(rule);
      changed = true;
    } else if (!same(next[i], rule)) {
      next[i] = rule;
      changed = true;
    }
  }
  return changed ? next : undefined;
}

/**
 * The workspace's glossary: the studio's own by name; else one made in HeyGen's app (any but the studio's old
 * per-set ones); else one of those old ones, adopted: renamed, and its don't-translate list and forced translations,
 * which only the studio wrote and which applied in every language (the don't-translate list winning over every
 * language's forced translations), cleared; else a new one made with the first rules. A create that meets one made meanwhile (a 409) looks it up again, waiting briefly for a create in flight.
 */
async function workspaceGlossary(client: HeyGenClient, first: Wanted): Promise<string> {
  const found = await findGlossary(client);
  if (found) return found;
  try {
    // A key of its own each time: a glossary deleted since must be made anew, not replayed from an earlier create.
    const made = await client.createGlossary({ name: STUDIO_GLOSSARY_NAME, ...(first.forced.length ? { forced_translations: first.forced } : {}), ...(first.said.length ? { terms: first.said } : {}) }, randomUUID());
    const id = made.id ?? made.brand_glossary_id;
    if (id) return id;
  } catch (err) {
    if (!/ failed: 409\b/.test(err instanceof Error ? err.message : "")) throw err;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    await new Promise((r) => setTimeout(r, LOOKUP_RETRY_MS));
    const again = await findGlossary(client);
    if (again) return again;
  }
  throw new Error("HeyGen did not return the workspace's brand glossary");
}

/** The glossary to use, as `workspaceGlossary` says, through every page; the studio's old ones in order of id. */
async function findGlossary(client: HeyGenClient): Promise<string | undefined> {
  let token: string | undefined;
  let theirs: string | undefined;
  const legacy: string[] = [];
  for (let page = 0; page < MAX_GLOSSARY_PAGES; page++) {
    const { glossaries, next } = await client.listGlossaries(token);
    for (const g of glossaries) {
      const id = g.id ?? g.brand_glossary_id;
      const name = g.name?.trim() ?? "";
      if (!id) continue;
      if (name.toLowerCase() === STUDIO_GLOSSARY_NAME.toLowerCase()) return id;
      if (LEGACY_NAME.test(name)) legacy.push(id);
      else theirs ??= id;
    }
    if (!next || next === token) break;
    token = next;
  }
  if (theirs) return theirs;
  const adopt = legacy.sort((a, b) => a.localeCompare(b, "en", { numeric: true }))[0];
  if (!adopt) return undefined;
  try {
    // Its rules were written before rules had languages, so they would reach every language and account: cleared.
    await client.updateGlossary(adopt, { name: STUDIO_GLOSSARY_NAME, do_not_translate_terms: [], forced_translations: [] });
  } catch (err) {
    // Another instance adopted one first (the name is taken): the caller looks again and finds it by name.
    if (/ failed: 409\b/.test(err instanceof Error ? err.message : "")) return undefined;
    throw err;
  }
  return adopt;
}
