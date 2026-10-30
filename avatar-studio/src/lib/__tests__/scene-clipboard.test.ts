// A scene copied in one video and pasted into another.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { copiedScene, parseCopiedScene } from "../scene-clipboard";
import type { Scene } from "../types";

const scene: Scene = {
  script: "Welcome in.",
  background: { type: "image", value: "/api/backdrops/bd_1", fit: "contain" },
  hidePresenter: true,
  avatarId: "av_1",
  layout: { scale: 1.2, x: 0.1, y: 0, framing: "closeUp" },
  voiceId: "voice_2",
  speed: 1.1,
  overlay: { text: "Open house" },
  avatarName: "Anna",
  voiceName: "Ray",
  audioName: "Intro",
  audioSeconds: 4,
};
const copy = (sc: Record<string, unknown>) => JSON.stringify({ space: "ws_1", scene: sc });

describe("scene clipboard", () => {
  it("keeps a scene as the editor has it, without the names a made video fills in", () => {
    const made = copiedScene("ws_1", scene);
    assert.equal(made.space, "ws_1");
    for (const k of ["avatarName", "voiceName", "audioName", "audioSeconds"] as const) assert.equal(made.scene[k], undefined);
    // A scene without the presenter keeps the presenter and framing it had, for when it is shown again.
    assert.deepEqual(parseCopiedScene(JSON.stringify(made))!.scene, {
      script: "Welcome in.",
      background: { type: "image", value: "/api/backdrops/bd_1", fit: "contain" },
      hidePresenter: true,
      avatarId: "av_1",
      layout: { scale: 1.2, x: 0.1, y: 0, framing: "closeUp" },
      voiceId: "voice_2",
      speed: 1.1,
      overlay: { text: "Open house" },
    });
  });

  it("reads nothing from no copy, broken JSON, or something that is not a scene", () => {
    assert.equal(parseCopiedScene(null), null);
    assert.equal(parseCopiedScene("{"), null);
    assert.equal(parseCopiedScene("[]"), null);
    assert.equal(parseCopiedScene(JSON.stringify({ space: "", scene: { script: "", background: { type: "color", value: "#fff" } } })), null);
    assert.equal(parseCopiedScene(copy({ script: 3, background: { type: "color", value: "#fff" } })), null);
    assert.equal(parseCopiedScene(copy({ script: "", background: { type: "gif", value: "x" } })), null);
    assert.equal(parseCopiedScene(copy({ script: "x".repeat(5001), background: { type: "color", value: "#fff" } })), null);
  });

  it("pastes a picture or clip only from the web or the account's own", () => {
    for (const value of ["https://example.com/a.jpg", "/api/backdrops/bd_9", "/api/footage/ft_1/clip"]) {
      assert.equal(parseCopiedScene(copy({ script: "", background: { type: "video", value } }))!.scene.background.value, value);
    }
    for (const value of ["javascript:alert(1)", "file:///etc/passwd", "/api/videos/1", "x".repeat(2001)]) {
      assert.equal(parseCopiedScene(copy({ script: "", background: { type: "image", value } })), null, value);
    }
  });

  it("drops what the server would refuse or a scene does not hold", () => {
    const raw = copy({ script: "Hi.", background: { type: "color", value: "#000000", fit: "contain" }, hidePresenter: true, avatarId: "", voiceId: 7, audioId: "a".repeat(65), speed: 3, layout: [1], overlay: "big", extra: "<b>" });
    assert.deepEqual(parseCopiedScene(raw)!.scene, { script: "Hi.", background: { type: "color", value: "#000000" } });
    assert.equal(parseCopiedScene(copy({ script: "Hi.", background: { type: "color", value: "#000" }, speed: 0.5 }))!.scene.speed, 0.5);
    // A video background can stand in for the presenter as a picture can.
    assert.equal(parseCopiedScene(copy({ script: "", background: { type: "video", value: "https://x.test/a.mp4" }, hidePresenter: true }))!.scene.hidePresenter, true);
  });
});
