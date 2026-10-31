// Documents attached to the Video Agent, read to the words the planner writes from.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { strToU8, zipSync } from "fflate";
import { documentText, fitDocumentText } from "../document-text";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const wp = (t: string, style?: string) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t>${t}</w:t></w:r></w:p>`;

describe("fitDocumentText", () => {
  it("collapses spacing and cuts a long text at a word", () => {
    assert.deepEqual(fitDocumentText("One  \t two\r\n\r\n\r\n\nthree"), { text: "One two\n\nthree", truncated: false });
    const long = fitDocumentText("alpha beta gamma delta", 13);
    assert.deepEqual(long, { text: "alpha beta", truncated: true });
    // A cut that falls just at a word's end keeps that word; one that would split an emoji does not.
    assert.deepEqual(fitDocumentText("alphabet beta gamma", 13), { text: "alphabet beta", truncated: true });
    assert.deepEqual(fitDocumentText(`aaaaaaaaa😀${"b".repeat(20)}`, 10), { text: "aaaaaaaaa", truncated: true });
  });
});

describe("documentText", () => {
  it("reads a Word document with its title and without scene breaks", async () => {
    const bytes = zipSync({ "word/document.xml": strToU8(`<w:document ${W}><w:body>${wp("Refund policy", "Title")}${wp("Thirty days.")}${wp("Cards", "Heading1")}${wp("Back in five days.")}</w:body></w:document>`) });
    assert.deepEqual(await documentText(new File([bytes], "policy.docx")), { text: "Refund policy\n\nThirty days.\n\nBack in five days.", truncated: false });
  });

  it("reads a PowerPoint deck's slides and notes, hidden slides left out", async () => {
    const ns = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    const sp = (type: string, t: string) => `<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr><p:ph type="${type}"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp>`;
    const bytes = zipSync({
      "ppt/presentation.xml": strToU8(`<p:presentation ${ns}><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>`),
      "ppt/_rels/presentation.xml.rels": strToU8(`<Relationships><Relationship Id="rId1" Type="${rel}/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="${rel}/slide" Target="slides/slide2.xml"/></Relationships>`),
      "ppt/slides/slide1.xml": strToU8(`<p:sld ${ns}><p:cSld><p:spTree>${sp("title", "Q3 results")}</p:spTree></p:cSld></p:sld>`),
      "ppt/slides/_rels/slide1.xml.rels": strToU8(`<Relationships><Relationship Id="rId1" Type="${rel}/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`),
      "ppt/notesSlides/notesSlide1.xml": strToU8(`<p:notes ${ns}><p:cSld><p:spTree>${sp("body", "Revenue grew 12 percent.")}</p:spTree></p:cSld></p:notes>`),
      "ppt/slides/slide2.xml": strToU8(`<p:sld ${ns} show="0"><p:cSld><p:spTree>${sp("title", "Backup")}</p:spTree></p:cSld></p:sld>`),
    });
    assert.deepEqual(await documentText(new File([bytes], "q3.pptx")), { text: "Q3 results\nRevenue grew 12 percent.", truncated: false });
  });

  it("tells formats by their first bytes, and refuses files that are not documents", async () => {
    const ns = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
    const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    const deck = zipSync({
      "ppt/presentation.xml": strToU8(`<p:presentation ${ns}><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`),
      "ppt/_rels/presentation.xml.rels": strToU8(`<Relationships><Relationship Id="rId1" Type="${rel}/slide" Target="slides/slide1.xml"/></Relationships>`),
      "ppt/slides/slide1.xml": strToU8(`<p:sld ${ns}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Renamed deck</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`),
    });
    assert.equal((await documentText(new File([deck], "deck.docx"))).text, "Renamed deck", "a deck named .docx is read as a deck");
    await assert.rejects(documentText(new File([zipSync({ "photo.jpg": new Uint8Array(10) })], "photos.zip")), /photos\.zip is not a Word or PowerPoint file/);
    const compound = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    await assert.rejects(documentText(new File([compound], "old.ppt")), /old\.ppt is password-protected or a PowerPoint 97–2003 file/);
    await assert.rejects(documentText(new File([compound], "budget.xls")), /budget\.xls is a spreadsheet/);
    await assert.rejects(documentText(new File([new Uint8Array(20)], "photo.png", { type: "image/png" })), /photo\.png is a picture or recording/);
    await assert.rejects(documentText(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2, 3])], "notes.txt")), /notes\.txt is not a text file/);
    // Windows-1251 Cyrillic can start with the bytes of an Office file's signature, but not all four of them.
    const cyrillic = new Uint8Array([0xd0, 0xcf, 0xd6, 0x20, 0xe8, 0x20, 0xf6, 0xe5, 0xf0, 0xea, 0xee, 0xe2, 0xfc]);
    assert.equal((await documentText(new File([cyrillic], "notes.txt"), "ru")).text, "РПЦ и церковь");
  });

  it("reads only the start of a huge text file, still as UTF-8", async () => {
    // One leading byte puts the 48,800-byte cut through the middle of a two-byte letter.
    const big = `a${"Привет мир. ".repeat(20_000)}`;
    const read = await documentText(new File([big], "big.txt"));
    assert.equal(read.truncated, true);
    assert.ok(read.text.startsWith("aПривет мир. Привет"), "still read as UTF-8, not as another encoding");
    assert.ok(read.text.length <= 12_000);
  });

  it("reads text in the browser's legacy code page when it is not UTF-8, and refuses an empty or huge file", async () => {
    assert.equal((await documentText(new File([new Uint8Array([0x43, 0x61, 0x66, 0xe9])], "notes.txt"), "fr")).text, "Café");
    await assert.rejects(documentText(new File(["   \n  "], "empty.md")), /No text found in empty\.md/);
    await assert.rejects(documentText(Object.defineProperty(new File(["x"], "huge.txt"), "size", { value: 60_000_000 })), /huge\.txt is larger than 50 MB/);
  });
});
