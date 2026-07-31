---
name: Google Play API access initiative
description: Enabling Android Publisher API access for Google Play — account owner missing expected settings, need to configure via developers.google.com/android-publisher
type: project
originSessionId: 4d5a25a7-2d42-498a-ad90-e4801cd40cb3
---
Working on enabling Google Play Developer API (Android Publisher API) access. The account owner doesn't see the expected settings in the Play Console UI.

**Discovery (2026-04-23):** The correct path is through the Android Publisher API at developers.google.com/android-publisher, not the Play Console settings that were initially expected.

**Current state of Google Play in the repo:**
- EAS handles all current Google Play interaction (build submission only)
- Service account: `google-play-deploy@grounded-access-142814.iam.gserviceaccount.com`
- GCP project: `grounded-access-142814` (Android Publisher API enabled)
- JSON key stored as GitHub secret `GOOGLE_PLAY_SERVICE_ACCOUNT_KEY`, written at deploy time
- `apps/mobile/eas.json` references `./google-play-service-account.json` for preview (internal testing) and production tracks
- Android package name: `com.and.mobile` (not `com.and.app` — that was taken)
- No direct `googleapis` or `google-auth-library` dependencies — no server-side API client exists yet

**Key discovery:** The old "Settings → API access" page in Play Console (Owner-only) is no longer needed. Google now says "You no longer need to link your developer account to a Google Cloud Project." Service accounts are invited via **Users & Permissions → Invite new users** instead, which Admins can do.

**Remaining steps (ENG-566/ENG-619):**
1. Invite service account email in Play Console via Users & Permissions
2. Build + manually upload first AAB to internal testing track
3. Test `mobile-deploy.yml` pipeline end-to-end

**How to apply:** The blocker (needing account Owner) is resolved. Michael can complete the setup as Admin via Users & Permissions.
