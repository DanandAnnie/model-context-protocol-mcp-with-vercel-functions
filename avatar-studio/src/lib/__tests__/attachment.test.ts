import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attachmentDisposition } from "../attachment";

/** The name a browser saves under: `filename*` when present, decoded. */
function saved(header: string): string {
  return decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(header)![1]);
}

describe("attachmentDisposition", () => {
  it("names the file after the asset with the extension its type has", () => {
    assert.equal(attachmentDisposition("Intro take 2", "audio/wav"), `attachment; filename="Intro_take_2.wav"; filename*=UTF-8''Intro%20take%202.wav`);
    assert.equal(saved(attachmentDisposition("Logo", "image/jpeg")), "Logo.jpg");
    assert.equal(saved(attachmentDisposition("Voice-over", "audio/mpeg")), "Voice-over.mp3");
    assert.equal(saved(attachmentDisposition("Office", "image/png")), "Office.png");
  });

  it("does not double an extension the name already has", () => {
    assert.equal(saved(attachmentDisposition("intro.WAV", "audio/wav")), "intro.wav");
    assert.equal(saved(attachmentDisposition("photo.jpeg", "image/jpeg")), "photo.jpg");
    // Another extension is part of the name.
    assert.equal(saved(attachmentDisposition("notes.txt", "audio/mpeg")), "notes.txt.mp3");
  });

  it("keeps any script in filename* and gives ASCII in filename", () => {
    const header = attachmentDisposition("Café ☕ – größe", "image/png");
    assert.equal(saved(header), "Café ☕ – größe.png");
    assert.match(header, /filename="Cafe_gro_e\.png"/);
    // A decomposed name (as from macOS) saves in its composed form.
    assert.equal(saved(attachmentDisposition(`Cafe${String.fromCharCode(0x301)}`, "image/png")), "Café.png");
    // A name with no Latin letters falls back to the kind of asset.
    assert.match(attachmentDisposition("会議", "audio/wav", "clip"), /filename="clip\.wav"; filename\*=UTF-8''%E4%BC%9A%E8%AD%B0\.wav$/);
  });

  it("never lets a name break the header or reach another folder", () => {
    const header = attachmentDisposition('../..\\evil"; filename="x.exe\r\nSet-Cookie: a=b', "audio/wav");
    assert.doesNotMatch(header, /[\r\n]/);
    assert.equal((header.match(/"/g) ?? []).length, 2);
    assert.doesNotMatch(saved(header), /[/\\"]/);
    assert.doesNotMatch(header.split("UTF-8''")[1], /['()*;" ]/);
    // Dots and spaces at the ends are dropped, so the file is neither hidden nor nameless.
    assert.equal(saved(attachmentDisposition(" ...hidden. ", "image/png")), "hidden.png");
    assert.equal(saved(attachmentDisposition("...", "image/png", "picture")), "picture.png");
  });

  it("caps the name at 80 characters as a person sees them", () => {
    const s = saved(attachmentDisposition("😀".repeat(100), "image/png"));
    assert.equal(Array.from(s.slice(0, -4)).length, 80);
    assert.ok(s.endsWith(".png"));
    // A family emoji is one character of several code points joined: it is kept whole or not at all.
    const family = ["👩", "👩", "👧"].join(String.fromCharCode(0x200d));
    const cut = saved(attachmentDisposition("a".repeat(79) + family + family, "image/png"));
    assert.equal(cut, `${"a".repeat(79)}${family}.png`);
    // The ASCII stand-in is at most 60 characters and never ends in a dot or an underscore.
    assert.ok(attachmentDisposition("a".repeat(200), "image/png").includes(`filename="${"a".repeat(60)}.png"`));
    assert.match(attachmentDisposition(`${"a".repeat(59)}.b`, "image/png"), new RegExp(`filename="${"a".repeat(59)}\\.png"`));
  });

  it("drops what cannot be encoded or would disguise the name", () => {
    // Half of a UTF-16 pair is valid JSON but cannot be URL-encoded; the download must still work.
    assert.equal(saved(attachmentDisposition(`bad${String.fromCharCode(0xd800)}`, "audio/wav")), "bad.wav");
    assert.equal(saved(attachmentDisposition(`${String.fromCharCode(0xdc00)}ok`, "audio/wav")), "ok.wav");
    // A right-to-left override, a zero-width space, and C1 controls are gone; the type still decides the extension.
    const rlo = String.fromCharCode(0x202e);
    assert.equal(saved(attachmentDisposition(`x${rlo}gnp.exe`, "image/png")), "x gnp.exe.png");
    assert.equal(saved(attachmentDisposition(String.fromCharCode(0x200b), "image/png", "picture")), "picture.png");
    assert.equal(saved(attachmentDisposition(`a${String.fromCharCode(0x85)}b`, "image/png")), "a b.png");
    // Characters Windows refuses in a file name.
    assert.equal(saved(attachmentDisposition("Q1: <draft>|final?*", "image/png")), "Q1 draft final.png");
  });

  it("trims loose ends before checking the extension", () => {
    assert.equal(saved(attachmentDisposition("intro.wav.", "audio/wav")), "intro.wav");
    assert.equal(saved(attachmentDisposition("intro .wav", "audio/wav")), "intro.wav");
  });
});
