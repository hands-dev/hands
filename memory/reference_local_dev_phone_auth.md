---
name: local-dev-phone-auth
description: Logging in locally — toll-free Twilio SMS is silently filtered; use the +1816555 test-phone bypass + code 267735
metadata: 
  node_type: memory
  type: reference
  originSessionId: f9439a6f-70f7-4e96-890c-21c9ce07cca2
---

Local OTP login (`apps/api/src/routes/verification.ts`): the API generates its own code, **hashes** it into the `phone_verifications` table (so the plaintext is NOT recoverable from the DB), and sends via real Twilio (`apps/api/src/services/sms.ts` — no local mock). `TWILIO_FROM_NUMBER` is a **toll-free `+1855…`** number, which US carriers **silently filter** when unverified → real numbers never receive the SMS locally.

**Bypass for local login (verified 2026-06-24):** locally `AND_ENVIRONMENT` is unset → defaults to `development` ∈ `TEST_ALLOWED_ENVIRONMENTS`, so any `isTestPhone` number bypasses Twilio:
- **Phone:** any `+1816555XXXX` (e.g. `+18165559999`) — `816-555` is a reserved test exchange. Send returns a dummy attempt, no SMS.
- **Code:** `267735` (`TEST_CODE`). Verify returns `getAndeeByPhone(phone)`.
- **To log in AS a specific andee** (e.g. yourself after a staging clone): `UPDATE andees SET phone_number='+18165559999' WHERE primary_tag='michael'` (column is `phone_number`, not `phone`), then log in with that number + `267735`. `&michael`'s staging email is not `michael@and.com`. See [[staging-gcp-access]] for the data clone.

**Seeded review account (lands on the authed app with zero setup):** phone `+18165550100`, code `267735`, andee id `andee_review_appstore` — created by migration `0011_review_account.sql`, already `onboarded`, so it bootstraps straight to the tab bar (a random `+1816555XXXX` has no account → drops into signup). `REVIEW_PHONE` constant in `verification.ts`.

**`DEVICE_ACCESS_TOKEN_SECRET` is REQUIRED for local mobile login (verified 2026-06-29):** the OTP verifies, then `/v1/public/auth/mobile-bootstrap` 500s with `Error: DEVICE_ACCESS_TOKEN_SECRET is not configured` (`packages/db/src/auth/device-token.ts`) if it's unset. The API loads `apps/api/.env.local` directly (`config({ path: '../.env.local' })`); set `DEVICE_ACCESS_TOKEN_SECRET` (+ `CLI_ACCESS_TOKEN_SECRET` fallback) there — any stable string works locally (API signs + verifies with it). There was no `apps/api/.env.example` template; added one + CONTRIBUTING cp step in ENG-1113 / PR #1924. The full local backend must be up (`pnpm dev` — DB, API :3025, MCP, Metro) or the app shows "no internet connection"; real numbers can't get an SMS locally (Twilio not configured → "Failed to send verification code", not rate limiting).
