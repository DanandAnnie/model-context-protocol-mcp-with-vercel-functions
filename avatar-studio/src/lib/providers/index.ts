// Resolves concrete providers from configuration. Falls back to demo
// implementations whenever a key is missing so the app always boots.
import { config } from "../config";
import { getEmailProvider } from "./email";
import { getBillingProvider } from "../billing";
import { getStreamingProvider } from "../streaming";
import type { ProviderStatus } from "../types";
import { persistenceKind } from "../store";
import { authEnabled, authMode } from "../auth";
import { DidAvatarProvider } from "./avatar/did";
import { HEYGEN_LOOK_KEY, HeyGenAvatarProvider } from "./avatar/heygen";
import { MockAvatarProvider } from "./avatar/mock";
import { AnthropicScriptProvider } from "./script/anthropic";
import { MockScriptProvider } from "./script/mock";
import { HeyGenTranslateProvider } from "./translate/heygen";
import { MockTranslateProvider } from "./translate/mock";
import { ElevenLabsTtsProvider } from "./tts/elevenlabs";
import { HeyGenTtsProvider } from "./tts/heygen";
import { MockTtsProvider } from "./tts/mock";
import type { AvatarProvider, ScriptProvider, TranslateProvider, TtsProvider } from "./types";

export function getAvatarProvider(): AvatarProvider {
  if (config.avatarProvider === "heygen" && config.heygenApiKey) return new HeyGenAvatarProvider(config.heygenApiKey);
  if (config.avatarProvider === "did" && config.didApiKey) return new DidAvatarProvider(config.didApiKey);
  return new MockAvatarProvider();
}

/**
 * Voices must be ones the avatar renderer can speak with:
 * - HeyGen renders only accept HeyGen voice ids, so HeyGen rendering always lists HeyGen voices.
 * - D-ID accepts ElevenLabs voices (when configured) or its built-in Microsoft voices, which the
 *   demo voice list maps onto by gender.
 */
export function getTtsProvider(): TtsProvider {
  const avatar = getAvatarProvider().name;
  if (avatar === "heygen" && config.heygenApiKey) return new HeyGenTtsProvider(config.heygenApiKey);
  if (config.ttsProvider === "elevenlabs" && config.elevenLabsApiKey) return new ElevenLabsTtsProvider(config.elevenLabsApiKey);
  if (config.ttsProvider === "heygen" && config.heygenApiKey && avatar !== "did") return new HeyGenTtsProvider(config.heygenApiKey);
  return new MockTtsProvider();
}

/** Provider that owns a stored job. Throws rather than guessing when its key is missing. */
/**
 * The keys of an avatar's `providerAssetIds` that hold a renderer look made of it in the renderer's shared account
 * (HeyGen's look; the demo's stand-in). Other keys hold uploads only the studio uses (D-ID's hosted portrait), which are
 * never kept once their avatar is deleted.
 */
export const LOOK_KEYS = [HEYGEN_LOOK_KEY, "mock"] as const;

export function getAvatarProviderByName(name: string): AvatarProvider {
  if (name === "mock") return new MockAvatarProvider();
  if (name === "heygen" && config.heygenApiKey) return new HeyGenAvatarProvider(config.heygenApiKey);
  if (name === "did" && config.didApiKey) return new DidAvatarProvider(config.didApiKey);
  throw new Error(`Provider "${name}" is not configured (missing API key)`);
}

let scriptOverride: ScriptProvider | undefined;
/** Swaps in a script provider (tests); `undefined` goes back to the configured one. */
export function setScriptProvider(p: ScriptProvider | undefined) {
  scriptOverride = p;
}

export function getScriptProvider(): ScriptProvider {
  if (scriptOverride) return scriptOverride;
  if (config.scriptProvider === "anthropic" && config.anthropicApiKey) return new AnthropicScriptProvider(config.anthropicApiKey);
  return new MockScriptProvider();
}

export function getTranslateProvider(): TranslateProvider {
  if (config.heygenApiKey) return new HeyGenTranslateProvider(config.heygenApiKey);
  return new MockTranslateProvider();
}

export function getTranslateProviderByName(name: string): TranslateProvider {
  if (name === "mock") return new MockTranslateProvider();
  if (name === "heygen" && config.heygenApiKey) return new HeyGenTranslateProvider(config.heygenApiKey);
  throw new Error(`Provider "${name}" is not configured (missing API key)`);
}

export function providerStatus(): ProviderStatus {
  const avatar = getAvatarProvider().name;
  const tts = getTtsProvider().name;
  const script = getScriptProvider().name;
  const translate = getTranslateProvider().name;
  const live = [avatar, tts, script, translate].some((n) => n !== "mock");
  return {
    mode: live ? "live" : "demo",
    avatar,
    tts,
    script,
    translate,
    persistence: persistenceKind(),
    email: getEmailProvider().name,
    billing: getBillingProvider().name,
    streaming: getStreamingProvider().name,
    voiceCloning: typeof getTtsProvider().cloneVoice === "function",
    ...(getTtsProvider().oneRecording ? { voiceCloneOneRecording: true as const } : {}),
    voiceDesign: typeof getTtsProvider().designVoice === "function",
    portraitGeneration: typeof getAvatarProvider().generatePortrait === "function",
    highlightClips: typeof getAvatarProvider().startHighlights === "function",
    fillerRemoval: typeof getAvatarProvider().startCleanup === "function",
    lipsync: typeof getAvatarProvider().startLipsync === "function",
    lookPacks: typeof getAvatarProvider().startLookPack === "function",
    digitalTwins: typeof getAvatarProvider().startTwin === "function",
    studioTemplates: typeof getAvatarProvider().listStudioTemplates === "function",
    authEnabled: authEnabled(),
    authMode: authMode(),
    renderLimitPerMonth: config.renderLimitPerMonth ?? null,
  };
}
