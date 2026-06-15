# ecoATM Pre-IDV Mock Backend

A ready-to-run mock backend for testing the Pre-IDV with Block Checks feature on your Android/iOS app. Simulates all backend endpoints, Veriff webhooks, and block list checks.

## Quick Start

```bash
npm install
npm start
```

Open **http://localhost:3000** for the test dashboard.

## What It Simulates

| Real System | Mock Equivalent |
|---|---|
| Veriff POST /sessions | `POST /pre-idv/create-session` — creates a session, returns sessionUrl |
| Veriff decision webhook | `POST /veriff/simulate-complete` or `POST /veriff/auto-complete/:lockCodeId` — fires the decision |
| Your decision polling endpoint | `GET /lock-codes/:id/veriff-status` — returns pending/decided |
| Your block check endpoint | `POST /pre-idv/block-check` — runs all 4 checks against seeded lists |
| Your Pre-IDV data storage | `PUT /lock-codes/:id/pre-idv` — stores regulatory answers, signature, marks complete |
| Your lock code endpoint | `GET /lock-codes/:id` — returns preIDVComplete and preIDVBlocked flags |
| Kiosk Pre-IDV retrieval | `GET /lock-codes/:id/pre-idv` — returns full data with live re-checks |

## How to Connect Your Android App

In your app's Retrofit base URL or network config, point to your computer's local IP:

```kotlin
// In your debug build config or DI module:
const val BASE_URL = "http://10.0.2.2:3000/" // Android emulator → host machine
// OR
const val BASE_URL = "http://192.168.x.x:3000/" // Physical device on same WiFi
```

For iOS Simulator:
```swift
let baseURL = "http://localhost:3000/"
```

## Veriff SDK + Mock Backend Flow

The Veriff SDK still connects to Veriff's real sandbox. The mock backend replaces YOUR backend, not Veriff's.

```
┌─────────────┐     ┌──────────────────┐     ┌───────────────┐
│  Mobile App  │────▶│  Mock Backend     │     │  Veriff       │
│              │◀────│  (localhost:3000) │     │  Sandbox      │
│              │     └──────────────────┘     │               │
│              │─────────────────────────────▶│  (real SDK)   │
│              │◀────────────────────────────│               │
└─────────────┘                               └───────────────┘

1. App calls Mock Backend: POST /pre-idv/create-session
   → Mock returns sessionUrl (placeholder)

2. App launches Veriff SDK with REAL Veriff sandbox session
   → SDK connects to real Veriff servers
   → User photographs ID, takes selfie

3. Veriff SDK returns Status.DONE to app

4. App polls Mock Backend: GET /lock-codes/:id/veriff-status
   → Returns "pending" until you trigger the webhook

5. You trigger webhook: POST /veriff/auto-complete/:lockCodeId
   → Mock simulates the decision based on firstName

6. App polls again: GET /lock-codes/:id/veriff-status
   → Returns "decided" with approved/declined/resubmission

7. If approved, app calls: POST /pre-idv/block-check
   → Mock checks against seeded block lists
```

### Option A: Fully Mocked (No Real Veriff)

Skip the Veriff SDK entirely during development. Your app calls the mock backend for everything:

1. `POST /pre-idv/create-session` — get a fake sessionUrl
2. Skip SDK launch, go straight to polling
3. `POST /veriff/auto-complete/:lockCodeId` — simulate the decision
4. `GET /lock-codes/:id/veriff-status` — get the decision
5. `POST /pre-idv/block-check` — run block checks

This is fastest for testing your UI screens and block check logic without needing the camera flow.

### Option B: Real Veriff SDK + Mock Backend

Use the real Veriff sandbox SDK for the camera flow, but use the mock for everything else:

1. Create a REAL Veriff session from the mock (or use Veriff's sandbox API directly)
2. Launch the real SDK — user goes through camera flow
3. After Status.DONE, trigger `POST /veriff/auto-complete/:lockCodeId` on the mock
4. Continue with mock endpoints for polling and block checks

## Pre-Seeded Test Data

### Block Lists

| List | ID Number | State | Name |
|---|---|---|---|
| Blocked Consumer | BLOCKED001 | — | John Blocked |
| Blocked Consumer | BLOCKED002 | — | Jane Blocked |
| No-Buy List | NOBUY001 | CA | Bob NoBuy |
| No-Buy List | NOBUY002 | TX | Alice NoBuy |
| LE Hold | LEHOLD001 | — | Mark Held |
| LE Hold | LEHOLD002 | — | Sara Held |

### Decision Control

Set the `firstName` field when creating a session:

| firstName Value | Veriff Decision | Code |
|---|---|---|
| `"Approved"` | Approved | 9001 |
| `"Decline"` | Declined | 9102 |
| `"Resubmission"` | Resubmission requested | 9103 |

## API Reference

### POST /pre-idv/create-session
```json
{ "lockCodeId": "LOCK-001", "firstName": "Approved" }
```

### POST /veriff/auto-complete/:lockCodeId
```json
{
  "overrideBiometricData": {
    "idNumber": "BLOCKED001",
    "dateOfBirth": "2009-06-15",
    "state": "CA"
  }
}
```
Override biometric data to test specific block scenarios. Omit for defaults.

### GET /lock-codes/:id/veriff-status
Returns `{ status: "pending" | "decided", decision: "approved" | "declined" | ... }`

### POST /pre-idv/block-check
```json
{ "lockCodeId": "LOCK-001" }
```
Uses biometric data already stored from the webhook.

### PUT /lock-codes/:id/pre-idv
```json
{
  "regulatoryAnswers": [{ "questionId": "Q1", "questionText": "...", "answer": "..." }],
  "signatureImageS3Key": "pre-idv/LOCK-001/signature.png",
  "markComplete": true
}
```

### GET /lock-codes/:id/pre-idv
Kiosk endpoint. Returns full Pre-IDV data + re-check results.

### Admin Endpoints
- `GET /admin/block-lists` — view all block lists
- `POST /admin/block-lists/blocked-consumer` — add to blocked consumer list
- `DELETE /admin/block-lists/blocked-consumer/:idNumber` — remove
- `POST /admin/block-lists/le-hold` — add LE hold
- `DELETE /admin/block-lists/le-hold/:idNumber` — remove
- `GET /admin/lock-codes` — view all lock codes
- `GET /admin/log` — view activity log
- `POST /admin/reset` — reset all data (block lists preserved)
