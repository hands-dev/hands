---
name: Signals & Perspectives Identity Architecture
description: Zero-knowledge encryption architecture for identity data — signals (encrypted data points) and perspectives (key-gated views that control access). Core privacy model for the Ampersand platform.
type: project
---

## Core Concept

Identity data is modeled as **signals** (data points) and **perspectives** (views that control access). Signals have no visibility state — visibility is determined entirely by perspective membership.

**Metaphor:** Your identity is in a central room. Surrounding rooms have windows showing different parts of your identity. Each room has a key. To see your identity, someone needs a key to a room — the room controls the view, not the person.

## Signals

Signals are identity data points: bio, city, state, gender, ageRange, socialLinks, and future fields like shoeSize, clothingStyle, etc.

- Signals have NO visibility property
- Always encrypted at rest under the owner's MPK (e1: secretbox)
- The owner can always read their own signals
- Visibility is determined by which perspectives include the signal

## Perspectives

A perspective is a named collection of signals with a key. Access = having the key.

- Every andee has a default "Public" perspective (open door, key stored in the clear)
- Connected perspectives (Family, SXSW, Nike) have keys shared only with granted andees/entities
- "Making a field public" = adding that signal to the Public perspective
- "Making a field private" = removing that signal from the Public perspective
- A signal in zero perspectives = invisible to everyone (private by default)
- The perspective controls the view, not the person. Two people in the same perspective see identical data.

## Key Hierarchy

```
MPK (random 256-bit, secure store, backed up via iCloud/Google)
  │
  │  protects perspective keys at rest
  │
  ├── PK_public  (random, stored in the clear — open door)
  ├── PK_family  (random, stored encrypted under MPK as e1:...)
  └── PK_nike    (random, stored encrypted under MPK as e1:...)

Identity Key Pair (X25519, secure store alongside MPK)
  ├── Public key → stored on server, pinned by connections (TOFU)
  └── Private key → never leaves device
```

**Why:** Perspective keys are random (not HKDF-derived from MPK) so they can be rotated on revocation. MPK protects them at rest.

## Encryption Scheme

| Component | Algorithm | Library |
|-----------|-----------|---------|
| Signal encryption (owner copy) | XSalsa20-Poly1305 (secretbox) | TweetNaCl.js |
| Perspective signal encryption | XSalsa20-Poly1305 (secretbox) | TweetNaCl.js |
| Perspective key sharing | X25519 key exchange | TweetNaCl.js |
| Key derivation | HKDF-SHA256 | @noble/hashes |
| Ciphertext prefix | e1: (secretbox), e2: (box/asymmetric) | — |

## Data Model

```
signals: stored as columns on andees table, always e1: encrypted under MPK

perspectives:
  id, owner_id, name, encrypted_key (e1: under MPK), public_key_material (only for Public)

perspective_signals:
  perspective_id, signal_name, encrypted_value (encrypted under perspective key)

perspective_grants:
  perspective_id, grantee_id, encrypted_key (perspective key encrypted under grantee's X25519 public key)
```

## Privacy States (UI)

The UI shows a binary toggle: **public** or **consented**.
- Public = signal is in the Public perspective
- Consented = signal is NOT in the Public perspective (private until shared via a connected perspective)
- Architecture deals only in signals and perspectives — "private" is emergent, not declared

## Web Session Model

MPK never leaves the mobile secure store. Web gets scoped access:

1. Web authenticates via OTP
2. Web shows pairing code → user approves on mobile
3. Ephemeral X25519 key exchange between mobile and web
4. Mobile decrypts relevant perspective keys, re-encrypts under ephemeral shared secret
5. Web receives perspective keys in memory (not persisted)
6. Tab close or timeout → keys zeroed

Fallback: recovery phrase entry in browser (explicit "break glass" action).

## Threat Model Decisions

| Threat | Decision |
|--------|----------|
| Perspective key rotation on revocation | Random keys (not derived), stored encrypted under MPK |
| MPK in browser (XSS) | Scoped perspective key delivery — MPK stays on mobile |
| Server MITM on public key exchange | TOFU for V1, safety numbers for V2, key transparency for V3 |
| Public signal encryption overhead | Accepted — uniformity over optimization |
| Server sees perspective membership structure | Accepted — structural metadata, not content |
| No forward secrecy for data at rest | Inherent to persistent data, accepted |
| Grantee collusion | Social trust problem, not crypto — accepted |

## Recovery Layers

1. **Platform backup** (automatic): MPK in iOS Keychain (synced) / Android Keystore backup
2. **Recovery phrase** (optional): 24-word mnemonic, server stores recovery_blob (MPK encrypted under phrase)
3. **Key reset** (nuclear): New MPK, all encrypted signal values wiped, re-enter from scratch

## Future: Quantum Readiness

- Symmetric (XSalsa20-Poly1305): already quantum-safe at 256 bits
- Asymmetric (X25519 for key sharing): vulnerable to Shor's algorithm
- When connected sharing ships: hybrid X25519 + ML-KEM-768 (FIPS 203)
- Ciphertext version prefix (e1:, e2:, e3:) enables algorithm rotation
