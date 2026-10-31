// One scene's presenter, voice, and pace given to the other scenes.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { castEverywhere, castParts, partsPhrase, scenesPhrase } from "../scene-cast";
import type { Scene } from "../types";

const bg = { type: "color" as const, value: "#fff" };
const picture = { type: "image" as const, value: "https://x.test/a.jpg" };
const sc = (over: Partial<Scene> = {}): Scene => ({ script: "Hello there.", background: bg, ...over });
const cast = (s: Scene) => [s.avatarId, s.voiceId, s.speed];

describe("scene cast", () => {
  it("gives a scene's presenter, voice, and pace to the others", () => {
    const scenes = [sc({ avatarId: "av_2", voiceId: "v_2", speed: 1.1 }), sc(), sc({ avatarId: "av_3" })];
    const out = castEverywhere(scenes, 0);
    assert.deepEqual(out.changed, [1, 2]);
    assert.deepEqual(out.parts, ["presenter", "voice", "pace"]);
    assert.equal(out.own, true);
    for (const s of out.scenes) assert.deepEqual(cast(s), ["av_2", "v_2", 1.1]);
    assert.equal(out.scenes[0], scenes[0]);
  });

  it("names only what changed, and keeps the scenes that already match as they were", () => {
    const scenes = [sc({ voiceId: "v_2" }), sc({ voiceId: "v_2" }), sc()];
    const out = castEverywhere(scenes, 0);
    assert.deepEqual(out.changed, [2]);
    assert.deepEqual(out.parts, ["voice"]);
    assert.equal(out.scenes[1], scenes[1]);
  });

  it("gives the video's back by clearing the others' choices, stored as nothing", () => {
    const scenes = [sc(), sc({ avatarId: "av_3", voiceId: "v_3", speed: 0.9 }), sc({ voiceId: "v_4" })];
    const out = castEverywhere(scenes, 0);
    assert.deepEqual(out.changed, [1, 2]);
    assert.equal(out.own, false);
    assert.deepEqual(Object.keys(out.scenes[1]).sort(), ["background", "script"]);
    assert.deepEqual(Object.keys(out.scenes[2]).sort(), ["background", "script"]);
  });

  it("leaves a clip scene its audio, and keeps the presenter for a scene without one", () => {
    const clip = sc({ audioId: "clip_1", avatarId: "av_9" });
    const silent = sc({ script: "[pause 3s]", voiceId: "v_9", speed: 0.8 });
    const hidden = sc({ hidePresenter: true, background: picture, avatarId: "av_8" });
    const out = castEverywhere([sc({ avatarId: "av_2", voiceId: "v_2", speed: 1.25 }), clip, silent, hidden], 0);
    assert.deepEqual(cast(out.scenes[1]), ["av_2", undefined, undefined]);
    // A silent hold takes the voice and pace too, for when it is given words.
    assert.deepEqual(cast(out.scenes[2]), ["av_2", "v_2", 1.25]);
    // A scene without the presenter keeps it for when it is shown again.
    assert.deepEqual(cast(out.scenes[3]), ["av_2", "v_2", 1.25]);
  });

  it("gives only what the scene shows or speaks", () => {
    assert.deepEqual(castParts(sc({ audioId: "clip_1" })), ["presenter"]);
    assert.deepEqual(castParts(sc({ hidePresenter: true, background: picture })), ["voice", "pace"]);
    // A silent hold's voice and a clip's pace are never heard, so they are not given.
    assert.deepEqual(castParts(sc({ script: "[pause 2s]" })), ["presenter"]);
    const fromSilent = castEverywhere([sc({ script: "[pause 2s]", voiceId: "v_1", speed: 0.8 }), sc({ voiceId: "v_7" })], 0);
    assert.deepEqual(fromSilent.changed, []);
    const fromHidden = castEverywhere([sc({ hidePresenter: true, background: picture, avatarId: "av_1", voiceId: "v_1" }), sc({ avatarId: "av_7" })], 0);
    assert.deepEqual(cast(fromHidden.scenes[1]), ["av_7", "v_1", undefined]);
    assert.deepEqual(castEverywhere([sc()], 4).changed, []);
  });

  it("names the parts and the scenes as a sentence does", () => {
    assert.equal(partsPhrase(["presenter", "voice", "pace"]), "presenter, voice, and pace");
    assert.equal(partsPhrase(["voice", "pace"]), "voice and pace");
    assert.equal(scenesPhrase([1]), "Scene 2");
    assert.equal(scenesPhrase([1, 3]), "Scenes 2 and 4");
    assert.equal(scenesPhrase([0, 1, 4]), "Scenes 1, 2, and 5");
  });
});
