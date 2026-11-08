// PowerPoint decks: speaker notes and slide text, read in presentation order.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { strToU8, zipSync } from "fflate";
import { readPptx } from "../pptx-notes";

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const para = (...runs: string[]) => `<a:p><a:pPr/>${runs.map((t) => `<a:r><a:rPr lang="en-US"/><a:t>${t}</a:t></a:r>`).join("")}</a:p>`;
const shape = (type: string | null, ...paras: string[]) => `<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr>${type === null ? "" : type ? `<p:ph type="${type}"/>` : "<p:ph idx=\"1\"/>"}</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${paras.join("")}</p:txBody></p:sp>`;
const slideXml = (...sps: string[]) => `<?xml version="1.0"?><p:sld ${NS}><p:cSld><p:spTree>${sps.join("")}</p:spTree></p:cSld></p:sld>`;
const notesXml = (...sps: string[]) => `<?xml version="1.0"?><p:notes ${NS}><p:cSld><p:spTree>${sps.join("")}</p:spTree></p:cSld></p:notes>`;

/** A deck whose slides are listed in `order` (file numbers), each with its slide XML and, optionally, notes XML. */
function deck(slides: Array<{ slide: string; notes?: string }>, order = slides.map((_, i) => i + 1)): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  files["ppt/presentation.xml"] = strToU8(`<?xml version="1.0"?><p:presentation ${NS}><p:sldIdLst>${order.map((n, i) => `<p:sldId id="${256 + i}" r:id="rId${n + 10}"/>`).join("")}</p:sldIdLst></p:presentation>`);
  files["ppt/_rels/presentation.xml.rels"] = strToU8(
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides.map((_, i) => `<Relationship Id="rId${i + 11}" Type="${REL}/slide" Target="slides/slide${i + 1}.xml"/>`).join("")}<Relationship Id="rId1" Type="${REL}/hyperlink" Target="https://example.com" TargetMode="External"/></Relationships>`,
  );
  slides.forEach((s, i) => {
    files[`ppt/slides/slide${i + 1}.xml`] = strToU8(s.slide);
    if (s.notes) {
      files[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide${i + 1}.xml"/></Relationships>`);
      files[`ppt/notesSlides/notesSlide${i + 1}.xml`] = strToU8(s.notes);
    }
  });
  // A large picture the reader must not need to unpack.
  files["ppt/media/image1.png"] = new Uint8Array(200_000);
  return zipSync(files);
}

describe("readPptx", () => {
  it("reads each slide's notes (the body placeholder only) and its text, without footers or numbers", () => {
    const slides = readPptx(
      deck([
        {
          slide: slideXml(shape("title", para("Welcome aboard")), shape("", para("Meet the team"), para("Read the ", "handbook")), shape("sldNum", para("1")), shape("ftr", para("Acme Confidential"))),
          notes: notesXml(shape("sldImg"), shape("body", para("Hi everyone, I&apos;m Dana &amp; this is our first week."), para("Let&#8217;s start.")), shape("sldNum", para("1"))),
        },
        { slide: slideXml(shape("title", para("Questions?"))) },
      ]),
    );
    assert.deepEqual(slides, [
      { notes: "Hi everyone, I'm Dana & this is our first week.\nLet’s start.", text: "Welcome aboard\nMeet the team\nRead the handbook", hidden: false },
      { notes: "", text: "Questions?", hidden: false },
    ]);
  });

  it("follows the presentation's order, not the slide files' numbering", () => {
    const slides = readPptx(
      deck(
        [{ slide: slideXml(shape("title", para("File one"))) }, { slide: slideXml(shape("title", para("File two"))) }, { slide: slideXml(shape("title", para("File three"))) }],
        [3, 1, 2],
      ),
    );
    assert.deepEqual(slides.map((s) => s.text), ["File three", "File one", "File two"]);
  });

  it("marks slides hidden in the slide show", () => {
    const hiddenSlide = slideXml(shape("title", para("Backup"))).replace("<p:sld ", '<p:sld show="0" ');
    const slides = readPptx(deck([{ slide: slideXml(shape("title", para("Shown"))) }, { slide: hiddenSlide }]));
    assert.deepEqual(slides.map((s) => [s.text, s.hidden]), [["Shown", false], ["Backup", true]]);
  });

  it("joins runs split mid-word and turns line breaks into spaces", () => {
    const slides = readPptx(deck([{ slide: slideXml(shape("title", "<a:p><a:r><a:t>Quar</a:t></a:r><a:r><a:t>terly</a:t></a:r><a:br/><a:r><a:t>review</a:t></a:r></a:p>")) }]));
    assert.equal(slides[0].text, "Quarterly review");
  });

  it("reads PowerPoint's line breaks, empty runs with attributes, grouped shapes, tables, and two-version shapes once", () => {
    const br = '<a:p><a:r><a:t>First line</a:t></a:r><a:br><a:rPr lang="en-US" dirty="0"/></a:br><a:r><a:t>second line</a:t></a:r></a:p>';
    const empty = '<a:p><a:r><a:t xml:space="preserve"/></a:r><a:r><a:rPr lang="en-US"/><a:t>Hello</a:t></a:r></a:p>';
    const grouped = `<p:grpSp><p:nvGrpSpPr/><p:grpSpPr/>${shape("", para("In a group"))}</p:grpSp>`;
    const table = `<p:graphicFrame><p:nvGraphicFramePr/><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody>${para("Q3 revenue")}</a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
    const twice = `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="a14">${shape(null, para("E = mc²"))}</mc:Choice><mc:Fallback>${shape(null, para("E = mc²"))}</mc:Fallback></mc:AlternateContent>`;
    const slides = readPptx(deck([{ slide: slideXml(shape("title", br), grouped, table, twice), notes: notesXml(shape("body", empty)) }]));
    assert.deepEqual(slides[0], { notes: "Hello", text: "First line second line\nIn a group\nQ3 revenue\nE = mc²", hidden: false });
  });

  it("keeps a slide's place when its part cannot be found, and finds parts however they are named", () => {
    const files: Record<string, Uint8Array> = {
      "ppt/presentation.xml": strToU8(`<p:presentation ${NS}><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/><p:sldId id="258" r:id="rId3"/></p:sldIdLst></p:presentation>`),
      "ppt/_rels/presentation.xml.rels": strToU8(
        `<Relationships><Relationship Id="rId1" Type="${REL}/slide" Target="/ppt/slides/intro.xml"/><Relationship Id="rId2" Type="${REL}/slide" Target="slides/gone.xml"/><Relationship Id="rId3" Type="${REL}/slide" Target="slides/slide3.xml"/></Relationships>`,
      ),
      "ppt/slides/intro.xml": strToU8(slideXml(shape("title", para("Intro")))),
      "ppt/slides/slide3.xml": strToU8(slideXml(shape("title", para("Three")))),
    };
    assert.deepEqual(readPptx(zipSync(files)).map((s) => s.text), ["Intro", "", "Three"]);
  });

  it("says plainly when the file is not a .pptx deck", () => {
    assert.throws(() => readPptx(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), "secret.pptx"), /secret\.pptx is password-protected/);
    assert.equal(readPptx(deck([{ slide: slideXml(shape("title", para("Bad &#x110000;ref"))) }]))[0].text, "Bad ref");
    assert.throws(() => readPptx(new Uint8Array([1, 2, 3]), "notes.pptx"), /notes\.pptx could not be read as a PowerPoint/);
    assert.throws(() => readPptx(zipSync({ "word/document.xml": strToU8("<w:document/>") }), "letter.pptx"), /letter\.pptx is not a PowerPoint/);
    assert.throws(() => readPptx(zipSync({ "ppt/presentation.xml": strToU8(`<p:presentation ${NS}><p:sldIdLst/></p:presentation>`) }), "empty.pptx"), /empty\.pptx has no slides/);
  });
});
