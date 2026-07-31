---
name: brand-name-ampersign-not-ampersand
description: "Brand name in user-facing copy is \"&\" (the ampersign), not the word \"Ampersand\". Applies to push/in-app notification bodies, marketing copy, and anywhere the platform is named to the user."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ba17f555-ca55-47e7-a76d-4ab2cda6a356
---

In user-facing copy — push notification bodies, in-app notification titles, marketing strings, anywhere the platform name appears to an andee — the platform is "&", not "Ampersand". Examples:

- "Michael Prewitt joined &" (not "joined Ampersand")
- "You've added 100 signals on &" (not "on Ampersand")
- "Open & to view it." (not "Open Ampersand to view it.")

**Why**: "Ampersand" is the company name internally and in docs/API metadata; "&" is the consumer-facing brand and visual identity. Mixing them in UI copy reads as off-brand.

**How to apply**:
- When writing notification copy (push title/body, in-app inbox titles, system messages the andee sees), use "&".
- The exception is screen-reader / accessibility labels where "&" would read as "and" — there, "Ampersand" is fine (e.g. `accessibilityLabel="Ampersand logo"`).
- Code comments, internal logs, OpenAPI spec titles, package names, GCP project names — keep "Ampersand" or leave as-is.
- iOS permission prompts (`NSFaceIDUsageDescription` etc.) are a grey area — they're user-facing but bundled with the OS chrome; Michael can decide per-string.
