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
const docx = (body: string, styles?: string) =>
  zipSync({
    "word/document.xml": strToU8(`<?xml version="1.0"?><w:document ${NS}><w:body>${body}<w:sectPr/></w:body></w:document>`),
    ...(styles ? { "word/styles.xml": strToU8(`<w:styles ${NS}>${styles}</w:styles>`) } : {}),
    "word/media/image1.png": new Uint8Array(100_000),
  });

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

  it("reads tracked changes as the document now stands: deleted and moved-away text, and old formatting, are gone", () => {
    // A deleted paragraph mark and a deleted row are self-closing markers; neither may swallow the text after it.
    const markedMark = `<w:p><w:pPr><w:rPr><w:del w:id="1" w:author="A" w:date="2026-01-01T00:00:00Z"/></w:rPr></w:pPr>${run("One.")}</w:p>`;
    const table = `<w:tbl><w:tr><w:trPr><w:del w:id="2" w:author="A"/></w:trPr><w:tc>${p("Row")}</w:tc></w:tr></w:tbl>`;
    const deletion = `<w:p>${run("Four ")}<w:del w:id="3" w:author="A"><w:r><w:delText>gone </w:delText></w:r></w:del>${run("five.")}</w:p>`;
    const movedFrom = `<w:p>${run("Start. ")}<w:moveFromRangeStart w:id="4" w:name="m"/><w:moveFrom w:id="5" w:author="A"><w:r><w:t>Moved sentence.</w:t></w:r></w:moveFrom><w:moveFromRangeEnd w:id="4"/></w:p>`;
    const movedTo = `<w:p>${run("End. ")}<w:moveTo w:id="6" w:author="A"><w:r><w:t>Moved sentence.</w:t></w:r></w:moveTo></w:p>`;
    // A heading turned into body text keeps its old style only in the change record.
    const unheaded = `<w:p><w:pPr><w:pPrChange w:id="7" w:author="A"><w:pPr><w:pStyle w:val="Heading1"/></w:pPr></w:pPrChange></w:pPr>${run("Now body text.")}</w:p>`;
    const doc = readDocx(docx(markedMark + p("Two.") + table + deletion + movedFrom + movedTo + unheaded));
    assert.equal(doc.text, "One.\n\nTwo.\n\nRow\n\nFour five.\n\nStart.\n\nEnd. Moved sentence.\n\nNow body text.");
  });

  it("knows headings by their built-in names in any language, through the styles they are based on", () => {
    const style = (id: string, name: string, extra = "") => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>${extra}</w:style>`;
    const styles = style("Titel", "Title") + style("berschrift1", "heading 1") + style("MeinKapitel", "Mein Kapitel", '<w:basedOn w:val="berschrift1"/>') + style("Gliederung", "Gliederung", '<w:pPr><w:outlineLvl w:val="1"/></w:pPr>');
    const doc = readDocx(docx(p("Mein Titel", "Titel") + p("Hallo.") + p("Die Küche", "berschrift1") + p("Neu.") + p("Garten", "MeinKapitel") + p("Grün.") + p("Keller", "Gliederung") + p("Kühl."), styles));
    assert.equal(doc.title, "Mein Titel");
    assert.deepEqual(scenesFromText(doc.text, { markdown: false }).scenes, ["Hallo.", "Neu.", "Grün.", "Kühl."]);
  });

  it("leaves out empty content controls' placeholder text, tables of contents, hidden text, and ruby readings", () => {
    const placeholder = `<w:sdt><w:sdtPr><w:showingPlcHdr/></w:sdtPr><w:sdtContent>${p("Click or tap here to enter text.")}</w:sdtContent></w:sdt>`;
    const filled = `<w:sdt><w:sdtPr><w:alias w:val="Name"/></w:sdtPr><w:sdtContent>${p("Typed into a control.")}</w:sdtContent></w:sdt>`;
    const toc = `<w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val="Table of Contents"/></w:docPartObj></w:sdtPr><w:sdtContent>${p("Contents", "TOCHeading")}${p("The kitchen 1", "TOC1")}</w:sdtContent></w:sdt>`;
    const hidden = `<w:p>${run("Read this. ")}<w:r><w:rPr><w:vanish/></w:rPr><w:t>Director note: do not read.</w:t></w:r></w:p>`;
    const ruby = `<w:p><w:r><w:ruby><w:rt><w:r><w:t>かんじ</w:t></w:r></w:rt><w:rubyBase><w:r><w:t>漢字</w:t></w:r></w:rubyBase></w:ruby></w:r>${run("です。")}</w:p>`;
    const sym = `<w:p>${run("Price")}<w:r><w:sym w:font="Symbol" w:char="F0AE"/></w:r>${run("up")}</w:p>`;
    const doc = readDocx(docx(toc + p("My video", "Title") + placeholder + filled + hidden + ruby + sym));
    assert.equal(doc.title, "My video", "a table of contents before the title does not count as text");
    assert.equal(doc.text, "Typed into a control.\n\nRead this.\n\n漢字です。\n\nPrice up");
  });

  it("keeps a table inside a cell within its row", () => {
    const cell = (t: string) => `<w:tc>${p(t)}</w:tc>`;
    const nested = `<w:tc>${p("A2")}<w:tbl><w:tr>${cell("inner1")}${cell("inner2")}</w:tr><w:tr>${cell("inner3")}${cell("inner4")}</w:tr></w:tbl></w:tc>`;
    const table = `<w:tbl><w:tr>${cell("A1")}${nested}</w:tr><w:tr>${cell("B1")}${cell("B2")}</w:tr></w:tbl>`;
    assert.equal(readDocx(docx(table)).text, "A1, A2 inner1, inner2; inner3, inner4\nB1, B2");
  });

  it("says plainly when the file is not a .docx document", () => {
    assert.throws(() => readDocx(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), "old.doc"), /old\.doc is password-protected or a Word 97–2003 file/);
    assert.throws(() => readDocx(new Uint8Array([1, 2, 3]), "notes.docx"), /notes\.docx could not be read as a Word/);
    assert.throws(() => readDocx(zipSync({ "ppt/presentation.xml": strToU8("<p/>") }), "deck.docx"), /deck\.docx is not a Word/);
  });
});
