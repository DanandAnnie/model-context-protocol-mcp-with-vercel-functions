import Anthropic from "@anthropic-ai/sdk";
import type { ScriptProvider } from "../types";

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

    const response = await this.client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 2048,
      system: SYSTEM,
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [{ role: "user", content: prompt }],
    });

    if (response.stop_reason === "refusal") {
      throw new Error("The script writer declined this request. Try rephrasing the topic.");
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
