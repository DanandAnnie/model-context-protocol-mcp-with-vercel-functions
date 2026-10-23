import type { ScriptAction, ScriptProvider } from "../types";

/** Template-based script writer used when no LLM key is configured. */
export class MockScriptProvider implements ScriptProvider {
  readonly name = "mock";
  async generate({ topic, tone, lengthSec, audience }: { topic: string; tone: string; lengthSec: number; audience?: string }) {
    const who = audience ? ` for ${audience}` : "";
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
}
