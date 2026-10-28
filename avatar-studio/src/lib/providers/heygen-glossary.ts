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

/** What a request needs the glossary to say: terms translated exactly so, in one language (a base code such as "fr"). */
export interface GlossaryRules {
  /** The language every rule applies in; required, as a rule for all languages would reach every account's dubs. */
  code: string;
  /** Terms translated exactly so (a term to keep as written is translated to itself). */
  forced: Array<{ term: string; translation: string }>;
}

type Forced = NonNullable<GlossaryLists["forced_translations"]>[number];

/** A rule's place in its list: its term (HeyGen matches without regard to case) in its language. */
const keyOf = (r: Forced) => `${r.term.trim().toLowerCase()}\0${r.target_language?.scope === "specific" ? r.target_language.code.toLowerCase() : "*"}`;

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
  const forced: Forced[] = rules.forced
    .map(({ term, translation }) => ({ term: term.trim(), translation: translation.trim(), target_language: { scope: "specific" as const, code: rules.code } }))
    .filter((r) => r.term && r.translation);
  if (!forced.length) return Promise.resolve(undefined);
  if (fresh) forgetGlossary();
  const digest = createHash("sha256").update(JSON.stringify(forced.map((r) => [keyOf(r), r.translation]).sort())).digest("hex");
  // Known and trusted: no need to wait behind another request's write.
  const at = ensured.get(digest);
  if (knownId && at && Date.now() - at < ENSURED_TTL_MS) return Promise.resolve(knownId);
  const run = queue.then(() => ensureRules(client, forced, digest));
  queue = run.catch(() => undefined);
  return run;
}

async function ensureRules(client: HeyGenClient, forced: Forced[], digest: string): Promise<string> {
  let foundAgain = false;
  for (let attempt = 1; ; attempt++) {
    const id = knownId ?? (await workspaceGlossary(client, forced));
    knownId = id;
    let current: GlossaryLists;
    try {
      current = await client.getGlossary(id);
    } catch (err) {
      if (goneOnce(err)) continue;
      throw err;
    }
    const next = merged(current.forced_translations ?? [], forced);
    if (!next) {
      ensured.set(digest, Date.now());
      return id;
    }
    if (attempt > UPDATE_TRIES) throw new Error("HeyGen's brand glossary kept changing while the studio wrote this dub's terms to it");
    try {
      await client.updateGlossary(id, { forced_translations: next });
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
function merged(current: Forced[], wanted: Forced[]): Forced[] | undefined {
  const next = [...current];
  const at = new Map(next.map((r, i) => [keyOf(r), i]));
  let changed = false;
  for (const rule of wanted) {
    const i = at.get(keyOf(rule));
    if (i === undefined) {
      at.set(keyOf(rule), next.length);
      next.push(rule);
      changed = true;
    } else if (next[i].translation !== rule.translation) {
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
async function workspaceGlossary(client: HeyGenClient, first: Forced[]): Promise<string> {
  const found = await findGlossary(client);
  if (found) return found;
  try {
    // A key of its own each time: a glossary deleted since must be made anew, not replayed from an earlier create.
    const made = await client.createGlossary({ name: STUDIO_GLOSSARY_NAME, forced_translations: first }, randomUUID());
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
