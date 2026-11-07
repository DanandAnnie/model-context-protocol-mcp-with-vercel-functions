// Deleting a translation from the Video translate list. Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { ConflictError, NotFoundError, applyTranslationWebhook, createTranslations, deleteTranslation, dubProofread, getTranslation, listTranslations, translationBatchSchema } from "../services";
import { getStore } from "../store";
import { MockTranslateProvider } from "../providers/translate/mock";
import type { Translation } from "../types";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

const base = { title: "Walkthrough", sourceVideoUrl: "https://cdn.example.com/v.mp4" };

describe("deleting a translation", () => {
  it("forgets that one dub and keeps the others", async () => {
    const [de, fr] = await createTranslations(translationBatchSchema.parse({ ...base, targetLanguages: ["German", "French"] }), "owner_a");
    await deleteTranslation(de.id, "owner_a");
    assert.deepEqual((await listTranslations("owner_a")).map((t) => t.id), [fr.id]);
    await assert.rejects(getTranslation(de.id, "owner_a"), NotFoundError);
    // Deleting it again says it is not there.
    await assert.rejects(deleteTranslation(de.id, "owner_a"), NotFoundError);
  });

  it("only deletes the owner's own translations", async () => {
    const [de] = await createTranslations(translationBatchSchema.parse({ ...base, targetLanguages: ["German"] }), "owner_a");
    await assert.rejects(deleteTranslation(de.id, "owner_b"), NotFoundError);
    assert.equal((await listTranslations("owner_a")).length, 1);
  });

  it("refuses an id that is not a translation's", async () => {
    await assert.rejects(deleteTranslation("vid_123", "owner_a"), { name: "ZodError" });
    await assert.rejects(deleteTranslation("tr_../../x", "owner_a"), { name: "ZodError" });
  });

  it("stays deleted when a status check of the dub lands during the delete", async () => {
    const [de] = await createTranslations(translationBatchSchema.parse({ ...base, targetLanguages: ["German"] }), "owner_a");
    const proto = MockTranslateProvider.prototype as unknown as { getStatus: (id: string) => Promise<unknown> };
    const getStatus = proto.getStatus;
    let answer!: (v: unknown) => void;
    let asked!: () => void;
    const askedP = new Promise<void>((r) => (asked = r));
    proto.getStatus = () => {
      asked();
      return new Promise((r) => (answer = r));
    };
    try {
      const listing = listTranslations("owner_a");
      await askedP;
      // The delete lands while the provider is still being asked.
      await deleteTranslation(de.id, "owner_a");
      answer({ status: "completed", videoUrl: "https://cdn.example.com/out.mp4" });
      await listing;
      assert.equal(await getStore().get<Translation>("translation", de.id), null);
    } finally {
      proto.getStatus = getStatus;
    }
  });

  it("stays deleted when a completion webhook is handled during the delete", async () => {
    const [de] = await createTranslations(translationBatchSchema.parse({ ...base, targetLanguages: ["German"] }), "owner_a");
    const proto = MockTranslateProvider.prototype as unknown as { parseWebhook?: (body: unknown) => unknown; getStatus: (id: string) => Promise<unknown> };
    const getStatus = proto.getStatus;
    let answer!: (v: unknown) => void;
    let asked!: () => void;
    const askedP = new Promise<void>((r) => (asked = r));
    proto.parseWebhook = () => ({ providerJobId: de.providerJobId, update: { status: "completed", videoUrl: "https://cdn.example.com/out.mp4" } });
    proto.getStatus = () => {
      asked();
      return new Promise((r) => (answer = r));
    };
    try {
      const handled = applyTranslationWebhook("mock", {});
      await askedP;
      await deleteTranslation(de.id, "owner_a");
      answer({ status: "completed", videoUrl: "https://cdn.example.com/out.mp4" });
      assert.equal(await handled, null);
      assert.equal(await getStore().get<Translation>("translation", de.id), null);
      // Without a delete the same webhook completes the job.
      const [fr] = await createTranslations(translationBatchSchema.parse({ ...base, targetLanguages: ["French"] }), "owner_a");
      proto.parseWebhook = () => ({ providerJobId: fr.providerJobId, update: { status: "completed", videoUrl: "https://cdn.example.com/fr.mp4" } });
      proto.getStatus = async () => ({ status: "completed", videoUrl: "https://cdn.example.com/fr.mp4" });
      assert.equal((await applyTranslationWebhook("mock", {}))?.status, "completed");
    } finally {
      proto.getStatus = getStatus;
      delete proto.parseWebhook;
    }
  });

  it("waits for a proofread dub being started, and the start never brings a deleted job back", async () => {
    const [de] = await createTranslations(translationBatchSchema.parse({ ...base, targetLanguages: ["German"], proofread: true }), "owner_a");
    // The lines are ready to correct.
    await listTranslations("owner_a");
    const ready = await getStore().get<Translation>("translation", de.id);
    assert.equal(ready?.proofreadStage, "ready");
    const proto = MockTranslateProvider.prototype as unknown as { dubProofread: (...args: unknown[]) => Promise<unknown> };
    const dub = proto.dubProofread;
    let answer!: (v: unknown) => void;
    let asked!: () => void;
    const askedP = new Promise<void>((r) => (asked = r));
    proto.dubProofread = () => {
      asked();
      return new Promise((r) => (answer = r));
    };
    try {
      const starting = dubProofread(de.id, undefined, "owner_a");
      await askedP;
      await assert.rejects(deleteTranslation(de.id, "owner_a"), ConflictError);
      // A start that hung long enough frees the job; deleting it then is not undone by the provider's late answer.
      const claimed = (await getStore().get<Translation>("translation", de.id))!;
      await getStore().put("translation", { ...claimed, updatedAt: new Date(Date.now() - 10 * 60_000).toISOString() });
      await deleteTranslation(de.id, "owner_a");
      answer({ providerJobId: `mock_tr_${Date.now()}` });
      await assert.rejects(starting, NotFoundError);
      assert.equal(await getStore().get<Translation>("translation", de.id), null);
    } finally {
      proto.dubProofread = dub;
    }
  });
});
