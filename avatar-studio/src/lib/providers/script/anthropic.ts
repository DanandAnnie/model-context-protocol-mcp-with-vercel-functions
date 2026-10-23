import Anthropic from "@anthropic-ai/sdk";
import type { ScriptAction, ScriptProvider } from "../types";

const SYSTEM = `You write spoken scripts for short AI avatar videos. Rules:
- Output only the words the presenter says. No headings, stage directions, markdown, or quotes.
- Write for the ear: short sentences, contractions, one idea per sentence.
- Open with a hook in the first sentence; close with one clear call to action.
- Match the requested tone, language, audience, and target length (about 2.5 words per second).`;

export class AnthropicScriptProvider implements ScriptProvider {
  readonly name = "anthropic";
  private client: Anthropic;
  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async revise(input: { script: string; action: ScriptAction; tone?: string; language?: string }) {
    const instruction: Record<ScriptAction, string> = {
      shorten: "Cut this script to roughly half its length. Keep the hook and the call to action.",
      expand: "Expand this script to roughly 1.5x its length with one concrete example or detail. Keep the same voice.",
      tone: `Rewrite this script in a ${input.tone ?? "friendly"} tone without changing its meaning or length.`,
      translate: `Translate this script into ${input.language ?? "English"}. Keep it natural for a spoken presenter; do not add commentary.`,
      polish: "Tighten the wording for spoken delivery: shorter sentences, contractions, no filler. Keep meaning and length.",
    };
    return this.complete(`${instruction[input.action]}\n\nScript:\n${input.script}`);
  }

  async generate(input: { topic: string; tone: string; lengthSec: number; language: string; audience?: string }) {
    const words = Math.round(input.lengthSec * 2.5);
    const prompt = [
      `Topic: ${input.topic}`,
      `Tone: ${input.tone}`,
      `Language: ${input.language}`,
      input.audience ? `Audience: ${input.audience}` : null,
      `Target length: about ${words} words (${input.lengthSec} seconds spoken).`,
    ]
      .filter(Boolean)
      .join("\n");

    return this.complete(prompt);
  }

  private async complete(prompt: string): Promise<string> {
    const response = await this.client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      system: SYSTEM,
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [{ role: "user", content: prompt }],
    });

    if (response.stop_reason === "refusal") {
      throw new Error("The script writer declined this request. Try rephrasing the topic.");
    }
    if (response.stop_reason === "max_tokens") {
      throw new Error("The script writer ran out of room. Try a shorter target length.");
    }
    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!text) throw new Error("Script writer returned no text.");
    return text;
  }
}
