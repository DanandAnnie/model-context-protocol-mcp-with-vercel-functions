import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCsv, toCsv } from "../csv";

describe("toCsv", () => {
  it("quotes every cell, escapes quotes, and neutralises formulas", () => {
    const out = toCsv(["email", "note"], [{ email: "a@example.com", note: 'Says "hi", twice' }, { email: "=HYPERLINK(\"x\")", note: undefined }]);
    assert.equal(out, '\uFEFF"email","note"\r\n"a@example.com","Says ""hi"", twice"\r\n"\'=HYPERLINK(""x"")",""\r\n');
  });

  it("round-trips through the parser", () => {
    const rows = [{ name: "Smith, Jo", when: "2026-10-23T10:00:00.000Z" }, { name: "-dash first", when: "" }];
    const back = parseCsv(toCsv(["name", "when"], rows));
    assert.deepEqual(back.columns, ["name", "when"]);
    assert.deepEqual(back.rows, [rows[0], { name: "'-dash first", when: "" }]);
  });
});
