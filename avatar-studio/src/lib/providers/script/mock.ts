import { graphemes } from "../../text";
import { splitKnowledge, type ChatMessage, type ChatPersona, type ScriptAction, type ScriptProvider, type VideoPlan } from "../types";

/** Template-based script writer used when no LLM key is configured. */
export class MockScriptProvider implements ScriptProvider {
  readonly name = "mock";
  async generate({ topic, tone, lengthSec, audience, source }: { topic: string; tone: string; lengthSec: number; audience?: string; source?: string }) {
    const who = audience ? ` for ${audience}` : "";
    if (source) {
      // Demo: open with the topic, then read the first sentences of the page, then close.
      const sentences = source.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/).filter((x) => x.length > 20);
      const take = Math.max(1, Math.min(sentences.length, Math.round(lengthSec / 15)));
      return [`Here's what you need to know about ${topic}.`, ...sentences.slice(0, take), "Want the details? The full page is linked below."].join(" ");
    }
    const sentences = [
      `Hi there! Today I want to talk about ${topic}${who}.`,
      `Here is the short version: ${topic} matters because it changes how you get results day to day.`,
      `First, understand the problem you are solving. Second, pick one clear action. Third, measure what happens.`,
      `If you take one thing away, let it be this: start small and stay consistent.`,
      `Thanks for watching. If this was useful, share it with someone who needs it.`,
    ];
    const target = Math.max(2, Math.min(sentences.length, Math.round(lengthSec / 12)));
    const body = sentences.slice(0, target).join(" ");
    return tone === "formal" ? body.replace("Hi there!", "Hello.") : body;
  }

  async describe({ script }: { title: string; script: string }) {
    // Demo: the script's opening sentences, as many as fit a short description.
    const sentences = script.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/).filter(Boolean);
    const picked: string[] = [];
    for (const sentence of sentences) {
      if (picked.length && [...picked, sentence].join(" ").length > 220) break;
      picked.push(sentence);
    }
    return picked.join(" ");
  }

  async titles({ script }: { title: string; script: string }) {
    // Demo: the script's first three sentences, each a title of at most 60 characters cut at a word.
    const sentences = script.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/).filter(Boolean);
    return sentences.slice(0, 3).map((sentence) => {
      if (sentence.length <= 60) return sentence;
      let cut = "";
      for (const ch of graphemes(sentence)) {
        if (cut.length + ch.length > 59) break;
        cut += ch;
      }
      // At a word when the next character starts one, so a whole word is kept when it fits exactly.
      const atWord = /\s/.test(sentence[cut.length] ?? " ") ? cut : cut.replace(/\s+\S*$/, "");
      return `${(atWord || cut).trimEnd()}…`;
    });
  }

  async revise({ script, action, tone, language }: { script: string; action: ScriptAction; tone?: string; language?: string }) {
    const sentences = script.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/).filter(Boolean);
    switch (action) {
      case "shorten":
        return sentences.slice(0, Math.max(1, Math.ceil(sentences.length / 2))).join(" ");
      case "expand":
        return [...sentences, "Here is one more thing to keep in mind: small, consistent steps add up faster than you expect.", "Thanks for watching."].join(" ");
      case "tone":
        return tone === "formal" || tone === "professional"
          ? script.replace(/\bHi there!?/gi, "Hello.").replace(/\bThanks\b/g, "Thank you")
          : tone === "energetic"
            ? script.replace(/\.(\s|$)/g, "!$1")
            : script;
      case "translate":
        return `[${language ?? "Translated"}] ${script}`;
      case "polish":
      default:
        return sentences.map((s) => s[0].toUpperCase() + s.slice(1)).join(" ");
    }
  }

  /**
   * A demo plan from the prompt alone: a hook, a scene per point (from the page when one was read), and a call to
   * action, about 15 seconds each; portrait when the prompt names a social format.
   */
  async plan({ prompt, lengthSec, source }: { prompt: string; lengthSec: number; language: string; source?: string }): Promise<VideoPlan> {
    const first = prompt.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s|\n/)[0].replace(/[.!?]+$/, "");
    // "Make a 30-second video about our new app" is about "our new app".
    const about = /\b(?:about|on|explaining|for|introducing)\s+(.+)$/i.exec(first)?.[1] ?? first;
    const topic = about.length > 60 ? `${about.slice(0, 60).replace(/\s+\S*$/, "")}…` : about;
    const title = topic.charAt(0).toUpperCase() + topic.slice(1);
    const count = Math.max(3, Math.min(6, Math.round(lengthSec / 15)));
    // The lines naming each source (a document and a page together) say where facts come from; they are not spoken.
    const points = source
      ? source.replace(/^From the (?:attached document ".*"|web page \S+):$/gm, "").replace(/\s+/g, " ").split(/(?<=[.!?])\s+/).filter((s) => s.length > 20)
      : [
          `Here's why ${topic} matters: it changes how you get results day to day.`,
          "First, understand the problem you're solving. Then pick one clear action and measure what happens.",
          "Start small, stay consistent, and the results add up faster than you'd expect.",
          "And you don't have to do it alone. The right tools make every step easier.",
        ];
    const body = points.slice(0, count - 2).map((script) => ({ script, framing: "full" as const }));
    return {
      title,
      orientation: /\b(tiktok|reels?|shorts?|stories|story|vertical|portrait|instagram)\b/i.test(prompt) ? "portrait" : "landscape",
      scenes: [
        { script: `Hi there! Let's talk about ${topic}.`, framing: "closeUp" },
        ...body,
        { script: "Thanks for watching. If this was useful, share it with someone who needs it.", framing: "closeUp" },
      ],
    };
  }

  /** Canned but context-aware replies so the interactive demo feels alive without an LLM key. */
  async chat({ persona, messages }: { persona: ChatPersona; messages: ChatMessage[] }) {
    const last = [...messages].reverse().find((m) => m.role === "user")?.content.trim() ?? "";
    const turn = messages.filter((m) => m.role === "user").length;
    // The owner's own text comes first; a knowledge page, when one was read, follows the marker line.
    const { own, reference } = splitKnowledge(persona.instructions);
    // First sentence of the instructions. A "You represent the X" lead-in becomes "I'm with the X";
    // anything else is treated as the subject the visitor can ask about.
    const first = own.split(/[.\n]/)[0]?.trim() ?? "";
    const represents = /^you (represent|work for|are part of)\s+/i.exec(first);
    const topic = represents ? first.slice(represents[0].length).trim() : first;
    const intro = represents ? `I'm with ${topic}.` : topic ? `Ask me anything about ${topic.toLowerCase()}.` : "What can I help you with today?";
    if (/^(hi|hello|hey)\b/i.test(last)) return `Hi, I'm ${persona.name}. ${intro}`;
    // A question that shares a word of five letters or more with the page is answered from the page.
    if (reference) {
      const words = last.toLowerCase().match(/[a-z][a-z'-]{4,}/g) ?? [];
      const sentences = reference.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
      const hit = sentences.find((s) => words.some((w) => s.toLowerCase().includes(w)));
      if (hit) return `From the page: ${hit.length > 220 ? `${hit.slice(0, 219)}…` : hit}`;
    }
    if (/\b(price|cost|how much)\b/i.test(last)) return `Good question. Pricing depends on what you need, so tell me a little more and I'll point you to the right option.`;
    if (/\b(thanks|thank you)\b/i.test(last)) return `You're welcome. Is there anything else I can help with?`;
    if (/\?$/.test(last)) return `Here's the short answer: it depends on what you're looking for, and I'm happy to walk you through the options. Want me to go deeper?`;
    return turn === 1 ? `Thanks for stopping by. I'm ${persona.name}, and I'm here to help. What would you like to know?` : `Got it. Tell me a bit more and I'll give you a clear next step.`;
  }
}
