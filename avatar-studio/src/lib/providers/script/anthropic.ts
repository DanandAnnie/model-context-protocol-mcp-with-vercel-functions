import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage, ChatPersona, ScriptAction, ScriptProvider } from "../types";

const SYSTEM = `You write spoken scripts for short AI avatar videos. Rules:
- Output only the words the presenter says. No headings, stage directions, markdown, or quotes.
- Write for the ear: short sentences, contractions, one idea per sentence.
- Open with a hook in the first sentence; close with one clear call to action.
- Match the requested tone, language, audience, and target length (about 2.5 words per second).`;

/**
 * The Messages API wants the first turn from the user and one turn per side in sequence. A transcript
 * that opens with the presenter's greeting gets a short visitor turn in front, and neighbouring turns
 * from one side are joined, so the conversation is sent as the API expects it.
 */
export function conversationFor(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) out[out.length - 1] = { role: m.role, content: `${last.content}\n\n${m.content}` };
    else out.push({ role: m.role, content: m.content });
  }
  if (out[0]?.role === "assistant") out.unshift({ role: "user", content: "(The visitor has just opened the page.)" });
  return out;
}

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
    // Pauses reach the model as [[P1]]-style tokens; asking for them back keeps a pause where it belongs.
    const keep = /\[\[P\d+\]\]/.test(input.script) ? " Tokens like [[P1]] mark pauses: keep each one, unchanged, at the matching point in the text." : "";
    return this.complete(`${instruction[input.action]}${keep}\n\nScript:\n${input.script}`);
  }

  async generate(input: { topic: string; tone: string; lengthSec: number; language: string; audience?: string; source?: string }) {
    const words = Math.round(input.lengthSec * 2.5);
    const prompt = [
      `Topic: ${input.topic}`,
      `Tone: ${input.tone}`,
      `Language: ${input.language}`,
      input.audience ? `Audience: ${input.audience}` : null,
      `Target length: about ${words} words (${input.lengthSec} seconds spoken).`,
      input.source ? `\nSource material (use only facts from it; do not invent details):\n"""\n${input.source}\n"""` : null,
    ]
      .filter(Boolean)
      .join("\n");

    return this.complete(prompt);
  }

  async chat({ persona, messages }: { persona: ChatPersona; messages: ChatMessage[] }) {
    messages = conversationFor(messages);
    const system = `You are ${persona.name}, a presenter speaking live to a visitor through an interactive avatar. Reply in ${persona.language}.
Rules: answer in one to three short spoken sentences; no markdown, lists, or stage directions; stay in character; if you do not know, say so briefly and offer what you can.
Background and instructions from the owner, followed by any reference page they named:
${persona.instructions || "(none provided: be a friendly, helpful presenter)"}`;
    // A reply cut off at the token cap is still a usable spoken answer; the writer paths keep throwing.
    return this.complete(messages, system, 400, true);
  }

  private async complete(prompt: string | ChatMessage[], system: string = SYSTEM, maxTokens = 16000, allowTruncation = false): Promise<string> {
    const response = await this.client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: maxTokens,
      system,
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: typeof prompt === "string" ? [{ role: "user", content: prompt }] : prompt.map((m) => ({ role: m.role, content: m.content })),
    });

    if (response.stop_reason === "refusal") {
      throw new Error("The script writer declined this request. Try rephrasing the topic.");
    }
    if (response.stop_reason === "max_tokens" && !allowTruncation) {
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
