// Script writing, revision, and interactive chat. Used by API routes only.
import { z } from "zod";
import { getScriptProvider } from "../providers";
import { LOCAL_OWNER } from "../owner-id";
import { ValidationError } from "../errors";
import { fetchPageText } from "../webpage";
import type { FetchLike } from "../safe-fetch";
import { getAvatar } from "./avatars";

export const scriptSchema = z
  .object({
    topic: z.string().trim().max(500).default(""),
    /** A public web page to write from; the topic defaults to its title. */
    url: z.string().trim().url().max(2000).optional(),
    tone: z.enum(["friendly", "professional", "formal", "energetic", "calm"]).default("friendly"),
    lengthSec: z.number().int().min(10).max(300).default(45),
    language: z.string().trim().min(2).max(40).default("English"),
    audience: z.string().trim().max(120).optional(),
  })
  .refine((v) => v.topic.length >= 3 || !!v.url, { path: ["topic"], message: "Give a topic or a page URL" });

export async function generateScript(input: z.infer<typeof scriptSchema>, fetchImpl?: FetchLike): Promise<string> {
  if (input.url) {
    let page: { title: string; text: string };
    try {
      page = await fetchPageText(input.url, fetchImpl);
    } catch (err) {
      throw new ValidationError(err instanceof Error ? err.message : "The page could not be read");
    }
    const topic = input.topic.length >= 3 ? input.topic : page.title || "this page";
    return getScriptProvider().generate({ ...input, topic, source: page.text });
  }
  return getScriptProvider().generate(input);
}

export const reviseSchema = z.object({
  script: z.string().trim().min(1).max(5000),
  action: z.enum(["shorten", "expand", "tone", "translate", "polish"]),
  tone: z.enum(["friendly", "professional", "formal", "energetic", "calm"]).optional(),
  language: z.string().trim().min(2).max(40).optional(),
});

export async function reviseScript(input: z.infer<typeof reviseSchema>): Promise<string> {
  return getScriptProvider().revise(input);
}

export const chatSchema = z.object({
  avatarId: z.string().min(1),
  instructions: z.string().trim().max(2000).default(""),
  language: z.string().trim().min(2).max(40).default("English"),
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(2000) })).min(1).max(40),
});

/** One reply from the interactive avatar; the last message must come from the visitor. */
export async function chatWithAvatar(input: z.infer<typeof chatSchema>, ownerId: string = LOCAL_OWNER): Promise<string> {
  if (input.messages[input.messages.length - 1].role !== "user") throw new ValidationError("The last message must be from the visitor");
  const avatar = await getAvatar(input.avatarId, ownerId);
  return getScriptProvider().chat({ persona: { name: avatar.name, instructions: input.instructions, language: input.language }, messages: input.messages });
}
