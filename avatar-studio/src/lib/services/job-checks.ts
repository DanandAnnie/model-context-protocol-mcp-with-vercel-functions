// Following renderer jobs the studio does not get webhooks for (highlight clips, cleaned recordings): each job is asked
// about at most every few seconds while it runs, one check at a time however many pages follow it, and a finished
// job's signed links are renewed once old, with a pause after a failed try so a dead job does not cost a call per look.

/** Finished jobs' links are signed for a limited time, so they are renewed once this old. */
export const RELINK_MS = 30 * 60 * 1000;
/** A running job is asked about at most this often. */
export const RECHECK_MS = 4_000;
/** After a check of a finished job, the next waits this long, so a dead job does not cost a call per page view. */
export const RETRY_FINISHED_MS = 5 * 60 * 1000;

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

  return {
    /** The jobs, each asked about first when it is due. */
    follow(jobs: T[], now = Date.now()): Promise<T[]> {
      return Promise.all(jobs.map((j) => (needsCheck(j, now) ? checkOnce(j, now) : j)));
    },
    /** Forgets when jobs were last asked about (tests). */
    forget(): void {
      attempted.clear();
    },
  };
}
