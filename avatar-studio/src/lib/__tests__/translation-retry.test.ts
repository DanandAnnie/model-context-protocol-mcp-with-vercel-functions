// Trying a failed dub again from the Video translate list. Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { getStore } from "../store";
import { MockTranslateProvider } from "../providers/translate/mock";
import { ConflictError, NotFoundError, deleteTranslation, listTranslations, retryTranslation } from "../services";
import type { Translation } from "../types";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

const at = "2026-01-01T00:00:00.000Z";
const failedJob = (id: string, extra: Partial<Translation> = {}): Translation => ({
  id,
  ownerId: "owner_a",
  title: "Tour (German)",
  sourceVideoUrl: "https://cdn.example.com/tour.mp4",
  targetLanguage: "German",
  audioOnly: true,
  speakers: 2,
  quality: "precision",
  removeMusic: true,
  enhanceSpeech: true,
  glossary: ["Acme Homes"],
  forcedTranslations: [{ term: "open house", translation: "Tag der offenen Tür" }],
  status: "failed",
  error: "The provider was busy",
  provider: "mock",
  createdAt: at,
  updatedAt: at,
  ...extra,
});

type Proto = { createTranslation: (...args: unknown[]) => Promise<{ providerJobId: string }> };

describe("trying a failed dub again", () => {
  it("starts a new dub with the same source, language, options, and brand rules, in place of the failed one", async () => {
    await getStore().put("translation", failedJob("tr_failed1"));
    const proto = MockTranslateProvider.prototype as unknown as Proto;
    const create = proto.createTranslation;
    const sent: unknown[] = [];
    proto.createTranslation = async (req: unknown) => {
      sent.push(req);
      return create.call(new MockTranslateProvider());
    };
    try {
      const next = await retryTranslation("tr_failed1", "owner_a");
      assert.notEqual(next.id, "tr_failed1");
      assert.equal(next.status, "processing");
      assert.equal(next.error, undefined);
      assert.deepEqual(
        [next.title, next.sourceVideoUrl, next.targetLanguage, next.audioOnly, next.speakers, next.quality, next.removeMusic, next.enhanceSpeech],
        ["Tour (German)", "https://cdn.example.com/tour.mp4", "German", true, 2, "precision", true, true],
      );
      assert.deepEqual(next.glossary, ["Acme Homes"]);
      assert.deepEqual(next.forcedTranslations, [{ term: "open house", translation: "Tag der offenen Tür" }]);
      // The provider is asked with the failed one's settings and brand rules, and nothing of the failed attempt carries over.
      assert.deepEqual(sent[0], {
        title: "Tour (German)",
        sourceVideoUrl: "https://cdn.example.com/tour.mp4",
        targetLanguage: "German",
        audioOnly: true,
        speakers: 2,
        quality: "precision",
        removeMusic: true,
        enhanceSpeech: true,
        glossary: ["Acme Homes"],
        forcedTranslations: [{ term: "open house", translation: "Tag der offenen Tür" }],
      });
      for (const field of ["retriedAt", "error", "proofreadCues", "providerProofreadId", "proofreadStage"] as const) assert.equal(next[field], undefined, field);
      assert.deepEqual((await listTranslations("owner_a")).map((t) => t.id), [next.id]);
    } finally {
      proto.createTranslation = create;
    }
  });

  it("returns the new outcome when the provider refuses again, still in place of the old one", async () => {
    await getStore().put("translation", failedJob("tr_failed2"));
    const proto = MockTranslateProvider.prototype as unknown as Proto;
    const create = proto.createTranslation;
    proto.createTranslation = async () => {
      throw new Error("Still busy");
    };
    try {
      const next = await retryTranslation("tr_failed2", "owner_a");
      assert.deepEqual([next.status, next.error], ["failed", "Still busy"]);
      assert.deepEqual((await listTranslations("owner_a")).map((t) => t.id), [next.id]);
      // And that one can be tried again in turn.
      proto.createTranslation = create;
      assert.equal((await retryTranslation(next.id, "owner_a")).status, "processing");
    } finally {
      proto.createTranslation = create;
    }
  });

  it("starts one dub when two tries arrive at once", async () => {
    await getStore().put("translation", failedJob("tr_failed3"));
    const proto = MockTranslateProvider.prototype as unknown as Proto;
    const create = proto.createTranslation;
    let calls = 0;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let asked!: () => void;
    const askedP = new Promise<void>((r) => (asked = r));
    proto.createTranslation = async () => {
      calls++;
      asked();
      await held;
      return { providerJobId: `mock_tr_${Date.now()}` };
    };
    try {
      const first = retryTranslation("tr_failed3", "owner_a");
      // The first has claimed the failed job by the time it asks the provider.
      await askedP;
      // Nor can it be deleted meanwhile: the new attempt takes its place.
      await assert.rejects(deleteTranslation("tr_failed3", "owner_a"), ConflictError);
      await assert.rejects(retryTranslation("tr_failed3", "owner_a"), ConflictError);
      release();
      await first;
      assert.equal(calls, 1);
      assert.equal((await listTranslations("owner_a")).length, 1);
    } finally {
      proto.createTranslation = create;
    }
  });

  it("opens a failed proofread dub's corrected lines again rather than translating them afresh", async () => {
    const cues = [
      { startMs: 0, endMs: 2000, text: "Hallo, korrigiert." },
      { startMs: 2000, endMs: 4000, text: "Zweite Zeile." },
    ];
    await getStore().put(
      "translation",
      failedJob("tr_proof", { proofread: true, providerProofreadId: "mock_pr_1", proofreadCues: cues, providerJobId: "mock_tr_1", dubStartedAt: at, error: "The dub failed at the provider" }),
    );
    const proto = MockTranslateProvider.prototype as unknown as Proto & { createProofread: (...a: unknown[]) => Promise<unknown> };
    const create = proto.createTranslation;
    const proof = proto.createProofread;
    let started = 0;
    proto.createTranslation = proto.createProofread = async () => {
      started++;
      throw new Error("not expected");
    };
    try {
      const again = await retryTranslation("tr_proof", "owner_a");
      assert.equal(started, 0, "nothing new is started");
      assert.equal(again.id, "tr_proof");
      assert.deepEqual([again.status, again.proofreadStage, again.error, again.providerJobId, again.dubStartedAt], ["processing", "ready", undefined, undefined, undefined]);
      assert.deepEqual(again.proofreadCues, cues);
      assert.equal(again.providerProofreadId, "mock_pr_1");
    } finally {
      proto.createTranslation = create;
      proto.createProofread = proof;
    }
  });

  it("keeps a failed job that changed while it was tried again, and stands by the new attempt if the old one cannot go", async () => {
    await getStore().put("translation", failedJob("tr_late", { providerJobId: "mock_tr_late" }));
    const proto = MockTranslateProvider.prototype as unknown as Proto;
    const create = proto.createTranslation;
    proto.createTranslation = async () => {
      // A late callback says the provider finished the job after all.
      const current = (await getStore().get<Translation>("translation", "tr_late"))!;
      await getStore().put("translation", { ...current, status: "completed", videoUrl: "https://cdn.example.com/late.mp4", updatedAt: new Date(Date.parse(current.updatedAt) + 1000).toISOString() });
      return { providerJobId: `mock_tr_${Date.now()}` };
    };
    try {
      const next = await retryTranslation("tr_late", "owner_a");
      assert.equal((await getStore().get<Translation>("translation", "tr_late"))?.status, "completed");
      assert.ok(await getStore().get<Translation>("translation", next.id));
    } finally {
      proto.createTranslation = create;
    }
    await getStore().put("translation", failedJob("tr_stuck"));
    const store = getStore() as unknown as { remove: (...a: unknown[]) => Promise<void> };
    const remove = store.remove.bind(store);
    store.remove = async () => {
      throw new Error("store down");
    };
    try {
      assert.equal((await retryTranslation("tr_stuck", "owner_a")).status, "processing");
    } finally {
      store.remove = remove;
    }
  });

  it("frees a claim that never finished after two minutes", async () => {
    await getStore().put("translation", failedJob("tr_failed4", { retriedAt: new Date(Date.now() - 30_000).toISOString() }));
    await assert.rejects(retryTranslation("tr_failed4", "owner_a"), ConflictError);
    await getStore().put("translation", failedJob("tr_failed4", { retriedAt: new Date(Date.now() - 3 * 60_000).toISOString() }));
    assert.equal((await retryTranslation("tr_failed4", "owner_a")).status, "processing");
  });

  it("only tries again a failed dub of the owner's own", async () => {
    await getStore().put("translation", failedJob("tr_running", { status: "processing", error: undefined, providerJobId: `mock_tr_${Date.now()}` }));
    await assert.rejects(retryTranslation("tr_running", "owner_a"), ConflictError);
    await getStore().put("translation", failedJob("tr_theirs"));
    await assert.rejects(retryTranslation("tr_theirs", "owner_b"), NotFoundError);
    await assert.rejects(retryTranslation("tr_missing", "owner_a"), NotFoundError);
    await assert.rejects(retryTranslation("vid_123", "owner_a"), { name: "ZodError" });
  });
});
