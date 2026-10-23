import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { languageCode, languageTag } from "../language";

describe("languageTag", () => {
  it("passes tags through with normalised casing", () => {
    assert.equal(languageTag("en-US"), "en-US");
    assert.equal(languageTag("EN-us"), "en-US");
    assert.equal(languageTag("pt-BR"), "pt-BR");
    assert.equal(languageTag("zh-Hant-TW"), "zh-Hant-TW");
    assert.equal(languageTag(" en "), "en");
  });

  it("maps provider display names to codes", () => {
    assert.equal(languageTag("English"), "en");
    assert.equal(languageTag("spanish"), "es");
    assert.equal(languageTag("Spanish (Mexico)"), "es");
    assert.equal(languageTag("Portuguese"), "pt");
    assert.equal(languageTag("Chinese"), "zh");
    assert.equal(languageTag("Mandarin"), "zh");
    assert.equal(languageTag("Japanese"), "ja");
    assert.equal(languageTag("Filipino"), "fil");
  });

  it("gives up on unknown values and blanks", () => {
    assert.equal(languageTag("Klingon"), undefined);
    assert.equal(languageTag(""), undefined);
    assert.equal(languageTag(undefined), undefined);
    assert.equal(languageTag(null), undefined);
  });

  it("exposes the bare language code", () => {
    assert.equal(languageCode("en-GB"), "en");
    assert.equal(languageCode("German"), "de");
    assert.equal(languageCode("nope"), undefined);
  });
});
