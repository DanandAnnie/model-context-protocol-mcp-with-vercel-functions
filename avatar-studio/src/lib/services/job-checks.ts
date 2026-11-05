// Following renderer jobs the studio does not get webhooks for (highlight clips, cleaned recordings): each job is asked
// about at most every few seconds while it runs, one check at a time however many pages follow it, and a finished
// job's signed links are renewed once old, waiting a few minutes between tries so a dead job does not cost a call per look.

import { getStore, type ItemKind } from "../store";

/** Finished jobs' links are signed for a limited time, so they are renewed once this old. */
export const RELINK_MS = 30 * 60 * 1000;
/** A running job is asked about at most this often. */
export const RECHECK_MS = 4_000;
/** After a check of a finished job, the next waits this long, so a dead job does not cost a call per page view. */
export const RETRY_FINISHED_MS = 5 * 60 * 1000;
/** Renderer checks one listing makes at most. */
export const MAX_CHECKS_PER_CALL = 5;
/** Jobs of one kind the scheduled background check asks about at most, across every account. */
export const BACKGROUND_JOB_CHECKS = 10;

interface Followed {
  id: string;
  status: string;
  updatedAt: string;
  checkedAt?: string;
}

/** A checker for one kind of job: `refresh` asks the renderer and stores the answer, and must never throw. */
export function jobChecker<T extends Followed>(refresh: (job: T) => Promise<T>) {
  const attempted = new Map<string, number>();
  const inFlight = new Map<string, Promise<T>>();

  function needsCheck(job: T, now: number): boolean {
    const since = now - (attempted.get(job.id) ?? 0);
    if (job.status === "processing") return since >= RECHECK_MS;
    return job.status === "completed" && now - Date.parse(job.checkedAt ?? job.updatedAt) > RELINK_MS && since >= RETRY_FINISHED_MS;
  }

  /** One check per job at a time: pages following the same job share it, and the attempt is noted whether or not it works. */
  function checkOnce(job: T, now: number): Promise<T> {
    const running = inFlight.get(job.id);
    if (running) return running;
    attempted.set(job.id, now);
    // Forgotten once old, so the map does not grow without bound.
    for (const [id, at] of attempted) if (now - at > RETRY_FINISHED_MS * 2) attempted.delete(id);
    const run = refresh(job).finally(() => inFlight.delete(job.id));
    inFlight.set(job.id, run);
    return run;
  }

  /** As `follow`, also saying how many jobs were due and asked about. */
  async function followCounted(jobs: T[], now = Date.now(), max = MAX_CHECKS_PER_CALL): Promise<{ jobs: T[]; checked: number }> {
    const due = new Set(
      jobs
        .filter((j) => needsCheck(j, now))
        .sort((a, b) => (a.checkedAt ?? a.updatedAt).localeCompare(b.checkedAt ?? b.updatedAt))
        .slice(0, max)
        .map((j) => j.id),
    );
    return { jobs: await Promise.all(jobs.map((j) => (due.has(j.id) ? checkOnce(j, now) : j))), checked: due.size };
  }

  return {
    /**
     * The jobs, those due asked about first: at most `max` per call, the least recently checked first, so a list of many
     * old links cannot hold one request open on dozens of renderer calls (the rest are asked on the next look).
     */
    follow(jobs: T[], now = Date.now(), max = MAX_CHECKS_PER_CALL): Promise<T[]> {
      return followCounted(jobs, now, max).then((r) => r.jobs);
    },
    followCounted,
    /** Forgets when jobs were last asked about (tests). */
    forget(): void {
      attempted.clear();
    },
  };
}

/**
 * The scheduled background check for one kind of job: those still being made, across every account, asked about the
 * way a listing would (the least recently asked first, at most every few seconds each), so a job nobody is watching
 * still finishes and its webhook is sent. Returns how many were asked about and how many finished or failed.
 */
export async function checkWaitingJobs<T extends Followed>(kind: ItemKind, checker: ReturnType<typeof jobChecker<T>>, max = BACKGROUND_JOB_CHECKS, now = Date.now()): Promise<{ checked: number; moved: number }> {
  const waiting = (await getStore().list<T>(kind)).filter((j) => j.status === "processing");
  const { jobs: after, checked } = await checker.followCounted(waiting, now, max);
  return { checked, moved: after.filter((j, i) => j.status !== waiting[i].status).length };
}
