// The Interactive page's Shared presenters list: how it can be sorted and what its search looks through.

export type AgentSort = "newest" | "oldest" | "name" | "conversations" | "visited";

export const AGENT_SORTS: ReadonlyArray<{ value: AgentSort; label: string }> = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "name", label: "Name A–Z" },
  { value: "conversations", label: "Most conversations" },
  { value: "visited", label: "Latest visit" },
];

/** Where this browser keeps the Shared presenters sort. */
export const AGENT_SORT_KEY = "avatar-studio:presenters-sort";

/** A sort remembered by this browser (or typed anywhere): one of the sorts, or newest first for anything else. */
export function agentSortFrom(value: string | null | undefined): AgentSort {
  return AGENT_SORTS.some((o) => o.value === value) ? (value as AgentSort) : "newest";
}

export type RankableAgent = { id: string; name: string; createdAt: string; conversations: number; lastVisitAt?: string };

/**
 * Each shared presenter's place in `sort` order, by id. Times go by when it was shared (ISO times, which order as text),
 * so an edit never moves it. Names compare as the person's language reads them (`locale`, the browser's by default),
 * digits by value and case and accents breaking ties only. Most conversations and latest visit put the busiest and the
 * most recently visited first, a presenter never visited after every visited one. Anything equal goes newest first, then
 * by id, so the order is the same on every render.
 */
export function rankAgents(agents: ReadonlyArray<RankableAgent>, sort: AgentSort, locale?: string): Map<string, number> {
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
  const text = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const newest = (a: RankableAgent, b: RankableAgent) => text(b.createdAt, a.createdAt) || text(a.id, b.id);
  const by: Record<AgentSort, (a: RankableAgent, b: RankableAgent) => number> = {
    newest,
    oldest: (a, b) => text(a.createdAt, b.createdAt) || text(a.id, b.id),
    name: (a, b) => collator.compare(a.name, b.name) || newest(a, b),
    conversations: (a, b) => b.conversations - a.conversations || newest(a, b),
    visited: (a, b) => (a.lastVisitAt && b.lastVisitAt ? text(b.lastVisitAt, a.lastVisitAt) : a.lastVisitAt ? -1 : b.lastVisitAt ? 1 : 0) || newest(a, b),
  };
  return new Map([...agents].sort(by[sort]).map((a, i) => [a.id, i]));
}

/** Whether `list` is already in `sort` order, i.e. sorting again would change nothing. */
export function agentsInSortOrder(list: ReadonlyArray<RankableAgent>, sort: AgentSort, locale?: string): boolean {
  const rank = rankAgents(list, sort, locale);
  return list.every((a, i) => rank.get(a.id) === i);
}

/** What the search looks through for a shared presenter: its name, the presenter it shows, its opening line, and the site it knows. */
export function agentSearchTexts(agent: { name: string; avatarName?: string; greeting?: string; knowledgeUrl?: string }): string[] {
  let host = "";
  try {
    host = agent.knowledgeUrl ? new URL(agent.knowledgeUrl).hostname : "";
  } catch {
    // A link that does not parse is searched as written.
    host = agent.knowledgeUrl ?? "";
  }
  return [agent.name, agent.avatarName ?? "", agent.greeting ?? "", host].filter(Boolean);
}
