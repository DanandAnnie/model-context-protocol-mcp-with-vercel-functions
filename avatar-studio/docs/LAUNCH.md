# Avatar Studio launch gate

Use a separate Vercel project with Root Directory `avatar-studio`, Next.js,
`npm ci`, and `npm run build`. Do not repoint the repository's existing MCP projects.
Use a protected Preview deployment (`target: staging` in the deployment REST API).

## Review configuration

- Set `STUDIO_DEMO_MODE=true`, all five provider selectors to `mock`, and
  `STREAMING_AVATAR=false`. The demo lock suppresses all paid-provider credentials,
  including automatic HeyGen translation, Stripe and Resend. It does not disable
  application webhooks or persistence. Leave provider callbacks unconfigured for review.
- Set both `RENDER_LIMIT_PER_MONTH` and `PLAN_PRO_RENDERS` to 10 for review.
- Keep Vercel Authentication enabled for all deployments. Before production,
  configure Supabase Auth or a strong `STUDIO_PASSWORD` as an application gate too.
- Set `APP_URL` to the exact reviewed deployment origin.
- Use a separate non-production Supabase project for previews. Run
  `supabase/schema.sql`, set `SUPABASE_URL` and the server-only service role key,
  and verify `/api/health` reports `persistence: supabase`. Never put a service key
  under a `NEXT_PUBLIC_` name. The schema denies anon/authenticated table access;
  all document authorization is enforced in the server application.
- For accounts, configure the public Supabase URL and publishable/anon key,
  enable email auth, and allow the exact `/auth/callback` URL. Verify confirmed
  account login and isolation between two test accounts.

## Verification before live approval

1. Typecheck, unit tests, build, and Playwright open/password suites.
2. Deployed health and provider status; unauthenticated protection; studio pages.
3. Select an avatar and voice, create a demo video, poll to completion, inspect
   player/captions; save branding and confirm defaults in a new editor.
4. With persistent storage configured, repeat reads across deployments/cold starts.
5. Mint a temporary developer key while signed in; call avatars, brand, video
   creation/status as Hermes would; revoke the key and confirm rejection. Do not
   place the key into a bot until the destination and authorization are verified.
6. Outbound webhook: use a controlled HTTPS receiver and verify HMAC-SHA256 over
   `timestamp.body`. Do not send client information during the test.

## Live approval

Only after the above passes, separately approve promotion, paid provider calls,
and merging. Store credentials as Vercel Secrets scoped to the intended environment.
HeyGen rendering currently uses HeyGen voices: selecting ElevenLabs does not add
ElevenLabs audio to HeyGen renders. ElevenLabs voices are supported with D-ID and
for previews/cloning. Do not promise an unimplemented HeyGen/ElevenLabs audio pipeline.

Set a random `WEBHOOK_SECRET` only when provider callbacks are needed. The current
callback adapter passes a secret in the URL (or accepts `x-webhook-secret`); treat
callback URLs as credentials and keep them out of screenshots/logs. Outbound studio
webhooks use HMAC. Provider streaming remains disabled until its separate live test;
its session registry and request throttles are per instance and need a shared store
for reliable multi-instance enforcement.

Keep Stripe disabled until its own approval. Mock upgrades are simulations and
must not be presented as real payment or enforceable paid-plan protection.
