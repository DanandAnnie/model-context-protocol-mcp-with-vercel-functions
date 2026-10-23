// Resolves concrete providers from configuration. Falls back to demo
// implementations whenever a key is missing so the app always boots.
import { config } from "../config";
import type { ProviderStatus } from "../types";
import { persistenceKind } from "../store";
import { DidAvatarProvider } from "./avatar/did";
import { HeyGenAvatarProvider } from "./avatar/heygen";
import { MockAvatarProvider } from "./avatar/mock";
import { AnthropicScriptProvider } from "./script/anthropic";
import { MockScriptProvider } from "./script/mock";
import { HeyGenTranslateProvider } from "./translate/heygen";
import { MockTranslateProvider } from "./translate/mock";
import { ElevenLabsTtsProvider } from "./tts/elevenlabs";
import { HeyGenTtsProvider } from "./tts/heygen";
import { MockTtsProvider } from "./tts/mock";
import type { AvatarProvider, ScriptProvider, TranslateProvider, TtsProvider } from "./types";

export function getTtsProvider(): TtsProvider {
  if (config.ttsProvider === "elevenlabs" && config.elevenLabsApiKey) return new ElevenLabsTtsProvider(config.elevenLabsApiKey);
  if (config.ttsProvider === "heygen" && config.heygenApiKey) return new HeyGenTtsProvider(config.heygenApiKey);
  return new MockTtsProvider();
}

export function getAvatarProvider(): AvatarProvider {
  if (config.avatarProvider === "heygen" && config.heygenApiKey) return new HeyGenAvatarProvider(config.heygenApiKey);
  if (config.avatarProvider === "did" && config.didApiKey) return new DidAvatarProvider(config.didApiKey, getTtsProvider().name);
  return new MockAvatarProvider();
}

/** All avatar providers that could own a stored avatar id (used when polling or on webhooks). */
export function getAvatarProviderByName(name: string): AvatarProvider {
  if (name === "heygen" && config.heygenApiKey) return new HeyGenAvatarProvider(config.heygenApiKey);
  if (name === "did" && config.didApiKey) return new DidAvatarProvider(config.didApiKey, getTtsProvider().name);
  return new MockAvatarProvider();
}

export function getScriptProvider(): ScriptProvider {
  if (config.scriptProvider === "anthropic" && config.anthropicApiKey) return new AnthropicScriptProvider(config.anthropicApiKey);
  return new MockScriptProvider();
}

export function getTranslateProvider(): TranslateProvider {
  if (config.heygenApiKey) return new HeyGenTranslateProvider(config.heygenApiKey);
  return new MockTranslateProvider();
}

export function getTranslateProviderByName(name: string): TranslateProvider {
  if (name === "heygen" && config.heygenApiKey) return new HeyGenTranslateProvider(config.heygenApiKey);
  return new MockTranslateProvider();
}

export function providerStatus(): ProviderStatus {
  const avatar = getAvatarProvider().name;
  const tts = getTtsProvider().name;
  const script = getScriptProvider().name;
  const translate = getTranslateProvider().name;
  const live = [avatar, tts, script, translate].some((n) => n !== "mock");
  return { mode: live ? "live" : "demo", avatar, tts, script, translate, persistence: persistenceKind() };
}
