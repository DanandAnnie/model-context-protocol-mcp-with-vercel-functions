// Word documents as scripts: paragraphs in order, headings as scene breaks, the title as the video's title.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { strToU8, zipSync } from "fflate";
import { readDocx } from "../docx-text";
import { scenesFromText } from "../script-import";

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const run = (t: string) => `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${t}</w:t></w:r>`;
const p = (text: string, style?: string) => `<w:p w:rsidR="00A1"><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}<w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>${run(text)}</w:p>`;
const docx = (body: string) => zipSync({ "word/document.xml": strToU8(`<?xml version="1.0"?><w:document ${NS}><w:body>${body}<w:sectPr/></w:body></w:document>`), "word/media/image1.png": new Uint8Array(100_000) });

describe("readDocx", () => {
  it("reads paragraphs in order, takes the title, and turns later headings into scene breaks", () => {
    const doc = readDocx(
      docx(
        p("Welcome to Maple Street", "Title") +
          p("Hi, I&apos;m Dana &amp; I&#8217;ll show you around.") +
          // Empty paragraphs, as Word writes them, with and without attributes, swallow nothing after them.
          '<w:p/><w:p w14:paraId="1A2B3C4D" w:rsidR="00B2"/>' +
          p("The kitchen", "Heading1") +
          p("It was redone last spring.") +
          p("The garden", "Heading2") +
          p("South facing."),
      ),
      "tour.docx",
    );
    assert.equal(doc.title, "Welcome to Maple Street");
    assert.equal(doc.text, "Hi, I'm Dana & I’ll show you around.\n\n---\n\nIt was redone last spring.\n\n---\n\nSouth facing.");
    const scenes = scenesFromText(doc.text, { markdown: false });
    assert.deepEqual(scenes.scenes, ["Hi, I'm Dana & I’ll show you around.", "It was redone last spring.", "South facing."]);
  });

  it("joins split runs, reads tabs and breaks as spaces, skips deletions, empty runs, and text boxes' second copies", () => {
    const para = `<w:p><w:r><w:t>Quar</w:t></w:r><w:r><w:t xml:space="preserve"/></w:r><w:r><w:t>terly</w:t><w:tab/><w:t>review</w:t><w:br/><w:t>now</w:t></w:r><w:del w:id="1"><w:r><w:delText>old words</w:delText></w:r></w:del><w:r><w:noBreakHyphen/><w:t>ish</w:t></w:r></w:p>`;
    const box = `<w:p><w:r><mc:AlternateContent xmlns:mc="m"><mc:Choice><w:drawing><w:txbxContent>${p("In a box")}</w:txbxContent></w:drawing></mc:Choice><mc:Fallback><w:pict><w:txbxContent>${p("In a box")}</w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent></w:r>${run("Around the box")}</w:p>`;
    assert.equal(readDocx(docx(para + box)).text, "Quarterly review now-ish\n\nAround the box");
  });

  it("reads a table one row per line, its cells joined by commas", () => {
    const cell = (t: string) => `<w:tc><w:tcPr/>${p(t)}</w:tc>`;
    const table = `<w:tbl><w:tblPr/><w:tr>${cell("Room")}${cell("Size")}</w:tr><w:tr>${cell("Kitchen")}${cell("12 m²")}</w:tr></w:tbl>`;
    assert.equal(readDocx(docx(p("Before") + table + p("After"))).text, "Before\n\nRoom, Size\nKitchen, 12 m²\n\nAfter");
  });

  it("treats an outline level as a heading and a heading after text as a break, not the title", () => {
    const outlined = `<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr>${run("Part two")}</w:p>`;
    const doc = readDocx(docx(p("Opening line.") + p("Part one", "Heading1") + p("First.") + outlined + p("Second.")));
    assert.equal(doc.title, undefined);
    assert.equal(doc.text, "Opening line.\n\n---\n\nFirst.\n\n---\n\nSecond.");
  });

  it("says plainly when the file is not a .docx document", () => {
    assert.throws(() => readDocx(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), "old.doc"), /old\.doc is password-protected or a Word 97–2003 file/);
    assert.throws(() => readDocx(new Uint8Array([1, 2, 3]), "notes.docx"), /notes\.docx could not be read as a Word/);
    assert.throws(() => readDocx(zipSync({ "ppt/presentation.xml": strToU8("<p/>") }), "deck.docx"), /deck\.docx is not a Word/);
  });
});
