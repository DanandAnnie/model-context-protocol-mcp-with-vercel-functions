import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";

function status(locked: boolean) {
  // A fresh process avoids cached configuration and singleton providers.
  const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    'import { providerStatus } from "./src/lib/providers/index.ts"; console.log(JSON.stringify(providerStatus()));',
  ], { encoding: "utf8", env: {
    ...process.env, STUDIO_DEMO_MODE: String(locked), AVATAR_PROVIDER: "heygen",
    TTS_PROVIDER: "elevenlabs", SCRIPT_PROVIDER: "anthropic", BILLING_PROVIDER: "stripe",
    EMAIL_PROVIDER: "resend", STREAMING_AVATAR: "true",
    HEYGEN_API_KEY: "test-placeholder", ELEVENLABS_API_KEY: "test-placeholder",
    ANTHROPIC_API_KEY: "test-placeholder", STRIPE_SECRET_KEY: "test-placeholder",
    STRIPE_PRICE_PRO: "price_test", RESEND_API_KEY: "test-placeholder",
    SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "",
  } });
  return JSON.parse(output.trim());
}

describe("launch demo lock", () => {
  it("keeps every paid backend mocked even when keys and live selectors are present", () => {
    const s = status(true);
    assert.equal(s.mode, "demo");
    for (const capability of ["avatar", "tts", "script", "translate", "billing", "email", "streaming"]) {
      assert.equal(s[capability], "mock", capability);
    }
  });
  it("allows configured providers after the lock is explicitly disabled without calling them", () => {
    const s = status(false);
    assert.equal(s.mode, "live");
    assert.equal(s.avatar, "heygen");
    assert.equal(s.translate, "heygen");
    assert.equal(s.billing, "stripe");
    assert.equal(s.email, "resend");
  });
});
