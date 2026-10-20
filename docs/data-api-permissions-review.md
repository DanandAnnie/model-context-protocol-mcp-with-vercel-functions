# Explicit Data API privileges — October 2026

Team membership is the authorization boundary. Anonymous clients have no app-table grants. Profiles permit display_name updates only; membership changes use the invitation RPC. Legacy null-team rows remain hidden; do not backfill ownership without evidence. Existing 8-character invite codes are not rotated. No service-role app consumer is verified, so none is newly granted.

Apply the generated final migration after 001–009, or use the consolidated script on a fresh database, not both. setup-sync.sh is a legacy unsupported CLI wrapper: do not use it to validate deployment (it repeats the consolidated script and suppresses errors).

Release blockers: inactive hosted staging project and runtime project references are unverified. New consolidated bootstraps create a private image bucket; existing buckets remain unchanged. Image components still use getPublicUrl; signed URLs/object policies must be finished before cloud photo workflows are ready. No Storage or browser end-to-end validation is claimed.

## Verification

Run `npm ci --prefix tests/permissions`, then `npm test --prefix tests/permissions`.
The pinned PGlite dependency exercises PostgreSQL roles/ACLs locally, without production credentials. Read the test fixture limitations above. No production write or hosted API test is implied.

Grants determine whether a role reaches an object; RLS determines rows. No blanket schema-wide/default grants were added. New tables must receive reviewed grants and RLS in their creating migration. Service keys must stay server-side.

Reference: https://supabase.com/docs/guides/api/securing-your-api
