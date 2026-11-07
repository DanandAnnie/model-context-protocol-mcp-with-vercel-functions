import type { StreamingProvider } from "../types";

/** No live video in demo mode: pages keep the animated portrait and browser speech. */
export class MockStreamingProvider implements StreamingProvider {
  readonly name = "mock";
  readonly available = false;
  async createSession(): Promise<never> {
    throw new Error("Live video is not configured");
  }
  async speak() {}
  async stop() {}
}
