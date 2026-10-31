import { LANGUAGES } from "../../stock";
import { demoAssetUrl } from "../../config";
import type { TranslationRequest } from "../../types";
import type { TranslateProvider } from "../types";

const SAMPLE_VIDEO = "/demo/render.webm";
/** The demo video's lines in a few languages; any other language gets the English lines marked with its name. */
const SAMPLE_LINES: Record<string, string[]> = {
  English: ["Hi, and welcome to Avatar Studio.", "In the next minute I'll show you how a video comes together.", "Let's get started."],
  Spanish: ["Hola y bienvenidos a Avatar Studio.", "En el próximo minuto te muestro cómo se hace un video.", "Empecemos."],
  French: ["Bonjour et bienvenue sur Avatar Studio.", "Dans la minute qui suit, je vous montre comment se monte une vidéo.", "C'est parti."],
  German: ["Hallo und willkommen bei Avatar Studio.", "In der nächsten Minute zeige ich dir, wie ein Video entsteht.", "Los geht's."],
};

export class MockTranslateProvider implements TranslateProvider {
  readonly name = "mock";
  async createTranslation() {
    return { providerJobId: `mock_tr_${Date.now()}` };
  }
  async getStatus(providerJobId: string) {
    if (!/^mock_tr_\d+$/.test(providerJobId)) throw new Error(`Not a demo job id: ${providerJobId}`);
    const startedAt = Number(providerJobId.split("_")[2]);
    if (Date.now() - startedAt < 15_000) return { status: "processing" as const };
    return { status: "completed" as const, videoUrl: demoAssetUrl(SAMPLE_VIDEO) };
  }
  async createProofread() {
    return { proofreadId: `mock_pr_${Date.now()}` };
  }
  async getProofread(proofreadId: string, input: TranslationRequest) {
    if (!/^mock_pr_\d+$/.test(proofreadId)) throw new Error(`Not a demo proofread id: ${proofreadId}`);
    // The demo's lines are ready as soon as they are asked about (listings ask about a job at most every 15 seconds).
    const lines = SAMPLE_LINES[input.targetLanguage] ?? SAMPLE_LINES.English.map((l) => `[${input.targetLanguage}] ${l}`);
    return { status: "ready" as const, cues: lines.map((text, i) => ({ startMs: i * 3000, endMs: i * 3000 + 2800, text })) };
  }
  async dubProofread(proofreadId: string) {
    if (!/^mock_pr_\d+$/.test(proofreadId)) throw new Error(`Not a demo proofread id: ${proofreadId}`);
    return { providerJobId: `mock_tr_${Date.now()}` };
  }
  supportedLanguages() {
    return LANGUAGES.map((l) => l.code);
  }
}
