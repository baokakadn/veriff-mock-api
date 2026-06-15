# ecoATM Pre-IDV Mock Backend — Full Context

> This document contains everything needed to understand, run, and extend the mock backend
> for testing the Pre-IDV with Block Checks feature. It covers the architecture, Veriff
> integration, every API endpoint, the data model, and setup instructions.

---

## Architecture

The mock backend replaces YOUR server, not Veriff's. The mobile app talks to two systems simultaneously:

```
┌─────────────────┐
│   Mobile App     │
│                  │
│  ┌────────────┐  │     ┌───────────────────────────┐
│  │ Veriff SDK │──│────▶│ Veriff Servers (REAL)      │
│  │ (camera)   │  │     │ stationapi.veriff.com      │
│  └────────────┘  │     │ Uses your real API key      │
│                  │     └───────────────────────────┘
│  ┌────────────┐  │     ┌───────────────────────────┐
│  │ Retrofit   │──│────▶│ Mock Backend               │
│  │ (your API) │  │     │ localhost:3000              │
│  └────────────┘  │     │ Exposed via ngrok           │
│                  │     │                             │
└─────────────────┘     │ - Creates REAL Veriff        │
                         │   sessions via their API     │
                         │ - Receives decision webhooks │
                         │ - Runs block checks          │
                         │ - Stores Pre-IDV data        │
                         └───────────────────────────┘
```

### What Each System Handles

| Action | Who Handles It | Where |
|--------|---------------|-------|
| Create Veriff session | Mock Backend → real Veriff API | `POST /v1/sessions` on stationapi.veriff.com |
| Camera + selfie capture | Veriff SDK (in mobile app) | Directly to Veriff servers |
| Decision webhook | Veriff → ngrok → Mock Backend | `POST /veriff/webhook` |
| Event webhook | Veriff → ngrok → Mock Backend | `POST /veriff/event-webhook` |
| App polls for decision | Mock Backend | `GET /lock-codes/:id/veriff-status` |
| Run block checks | Mock Backend | `POST /pre-idv/block-check` |
| Store Pre-IDV data | Mock Backend | `PUT /lock-codes/:id/pre-idv` |
| Kiosk retrieval + re-check | Mock Backend | `GET /lock-codes/:id/pre-idv` |

---

## End-to-End Flow

```
1. App calls Mock Backend:  POST /pre-idv/create-session
   └─ Mock calls real Veriff API (POST /v1/sessions)
   └─ Returns real sessionUrl to app

2. App launches Veriff SDK with the real sessionUrl
   └─ SDK connects to real Veriff servers
   └─ User photographs ID, takes selfie

3. Veriff SDK returns Status.DONE to app

4. Veriff processes the verification and POSTs decision webhook
   └─ Veriff → ngrok → Mock Backend (POST /veriff/webhook)
   └─ Mock verifies HMAC signature
   └─ Mock extracts biometric data + decision code
   └─ Mock stores decision on the lock code

5. App polls Mock Backend:  GET /lock-codes/:id/veriff-status
   └─ Returns "decided" with approved/declined/resubmission

6. If approved, app calls:  POST /pre-idv/block-check
   └─ Mock runs 4 checks: age, blocked consumer, no-buy list, LE hold
   └─ Returns pass/fail with block reason

7. App saves regulatory answers:  PUT /lock-codes/:id/pre-idv
   └─ Stores answers, signature, marks complete

8. Kiosk scans lock code:  GET /lock-codes/:id/pre-idv
   └─ Returns full Pre-IDV data
   └─ Runs live re-checks against current block lists
```

---

## Project Structure

```
mock-api/
├── server.js          # The entire backend (single file)
├── package.json       # Dependencies: express, cors, uuid, dotenv
├── .env               # Your credentials (NEVER commit)
├── .env.example       # Template for .env
├── .gitignore         # Excludes .env, node_modules
└── README.md          # Quick reference
```

### Dependencies

```json
{
  "express": "^4.18.2",
  "cors": "^2.8.5",
  "uuid": "^9.0.0",
  "dotenv": "^17.4.2"
}
```

---

## Setup & Configuration

### Required Environment Variables (.env)

```env
VERIFF_API_KEY=your-api-key-here
VERIFF_API_SECRET=your-shared-secret-here
VERIFF_BASE_URL=https://stationapi.veriff.com
WEBHOOK_BASE_URL=https://natural-bullfrog-moderately.ngrok-free.app
PORT=3000
```

- `VERIFF_API_KEY` / `VERIFF_API_SECRET` — from Veriff Station → Integration
- `VERIFF_BASE_URL` — always `https://stationapi.veriff.com` for sandbox
- `WEBHOOK_BASE_URL` — your ngrok HTTPS URL (Veriff requires HTTPS for callbacks)
- Server exits with an error if any of the first 3 are missing

### Running

**Terminal 1 — ngrok:**
```bash
ngrok http --url=natural-bullfrog-moderately.ngrok-free.app 3000
```

**Terminal 2 — server:**
```bash
cd "/Users/Bruno/Documents/mock api"
npm install
npm start
```

Dashboard: http://localhost:3000

### Veriff Station Configuration

Set these in Veriff Station → Integration → Settings:

- **Decision webhook URL:** `https://natural-bullfrog-moderately.ngrok-free.app/veriff/webhook`
- **Event webhook URL:** `https://natural-bullfrog-moderately.ngrok-free.app/veriff/event-webhook`

The ngrok static URL doesn't change between restarts — configure once.

---

## Mobile App Integration

### Android (Retrofit)

```kotlin
object ApiConfig {
    // Android emulator → host machine
    const val BASE_URL = "http://10.0.2.2:3000/"

    // Physical device on same WiFi
    // const val BASE_URL = "http://192.168.x.x:3000/"
}
```

### iOS Simulator

```swift
let baseURL = "http://localhost:3000/"
```

### App Flow (Kotlin)

```kotlin
// 1. Call mock backend to create a session
val response = yourApi.createSession(lockCodeId, firstName)
val sessionUrl = response.sessionUrl  // This is a REAL Veriff URL

// 2. Launch Veriff SDK with the real sessionUrl
val intent = Sdk.createLaunchIntent(activity, sessionUrl, configuration)
startActivityForResult(intent, VERIFF_REQUEST_CODE)

// 3. SDK connects to REAL Veriff servers, user takes photos

// 4. SDK returns Status.DONE — start polling
val status = yourApi.getVeriffStatus(lockCodeId)
// status.decision = "approved" | "declined" | "resubmission_requested"

// 5. If approved, run block checks
val blockResult = yourApi.runBlockCheck(lockCodeId)
// blockResult.blocked = true/false

// 6. Save regulatory answers, mark complete
yourApi.savePreIDV(lockCodeId, answers, signatureKey, markComplete = true)
```

---

## API Reference

### POST /pre-idv/create-session

Creates a real Veriff verification session.

**Request:**
```json
{
  "lockCodeId": "LOCK-001",
  "firstName": "Approved",
  "lastName": "Doe"
}
```

- `lockCodeId` — required, your internal lock code identifier
- `firstName` — controls Veriff sandbox decision: `"Approved"` (9001), `"Decline"` (9102), `"Resubmission"` (9103)

**Response (success):**
```json
{
  "sessionUrl": "https://magic.veriff.me/v/real-uuid-here",
  "verificationId": "uuid",
  "vendorDataId": "uuid"
}
```

**Response (error):**
```json
{
  "error": "Failed to create Veriff session",
  "veriffStatus": 400,
  "details": "..."
}
```

**What it does internally:**
1. Generates a `preIDVSessionToken` (UUID v4) used as `vendorData` for Veriff
2. Calls `POST ${VERIFF_BASE_URL}/v1/sessions` with `X-AUTH-CLIENT: VERIFF_API_KEY`
3. Sends the callback URL as `${WEBHOOK_BASE_URL}/veriff/webhook`
4. Stores the session in memory keyed by `verificationId`
5. Links the session to the lock code

---

### POST /veriff/webhook

Receives real decision webhooks from Veriff. **Not called by your app** — Veriff POSTs here automatically.

**Headers checked:**
- `x-hmac-signature` or `x-auth-signature` — HMAC-SHA256 of the raw body using `VERIFF_API_SECRET`

**What it does:**
1. Verifies HMAC signature (rejects with 401 if invalid)
2. Parses the decision code: 9001=approved, 9102=declined, 9103=resubmission
3. Extracts biometric data (person name, DOB, address, ID number, etc.) from the Veriff payload
4. Stores biometric data on the lock code (only for approved decisions)
5. Updates the lock code's `veriffDecision` so polling returns the result

**Biometric data extraction mapping:**
```
Veriff person.firstName       → biometricData.firstName
Veriff person.lastName        → biometricData.lastName
Veriff person.dateOfBirth     → biometricData.dateOfBirth
Veriff person.gender          → biometricData.gender
Veriff person.addresses[0]    → biometricData.address1, city, postalCode, state
Veriff document.number        → biometricData.idNumber
Veriff document.type          → biometricData.idType
Veriff document.validUntil    → biometricData.expirationDate
Veriff document.issuer        → biometricData.issuingAuthority
```

---

### POST /veriff/event-webhook

Receives Veriff status events (started, submitted, etc.). Logs them to the dashboard.

---

### GET /lock-codes/:id/veriff-status

Mobile app polls this after the Veriff SDK returns `Status.DONE`.

**Response (pending — webhook not yet received):**
```json
{
  "status": "pending",
  "decision": null,
  "message": "Waiting for Veriff webhook..."
}
```

**Response (decided):**
```json
{
  "status": "decided",
  "decision": "approved",
  "code": 9001,
  "decidedAt": "2026-06-14T...",
  "verificationId": "uuid"
}
```

---

### POST /pre-idv/block-check

Runs 4 block checks in order. Stops at the first failure.

**Request:**
```json
{ "lockCodeId": "LOCK-001" }
```

Uses biometric data already stored from the webhook. Optionally pass `biometricData` directly in the body.

**Response:**
```json
{
  "ageCheck": "PASS",
  "blockedConsumerCheck": "PASS",
  "noBuyListCheck": "PASS",
  "lawEnforcementCheck": "PASS",
  "blocked": false,
  "blockReason": null,
  "checkedAt": "2026-06-14T..."
}
```

**Block check order:**
1. **Age check** — `dateOfBirth` must be 18+. Fail → `blockReason: "UNDERAGE"`, remaining checks `NOT_RUN`
2. **Blocked consumer** — `idNumber` matched against blocked consumer list. Fail → `blockReason: "BLOCKED_CONSUMER"`
3. **No-buy list** — `idNumber` + `state` matched against no-buy list. Fail → `blockReason: "NO_BUY_LIST"`
4. **Law enforcement hold** — `idNumber` matched against LE hold list. Fail → `blockReason: "LAW_ENFORCEMENT_HOLD"`

---

### PUT /lock-codes/:id/pre-idv

Saves Pre-IDV data incrementally as app steps complete.

**Request:**
```json
{
  "regulatoryAnswers": [
    { "questionId": "Q1", "questionText": "Is your address current?", "answer": "Yes" }
  ],
  "signatureImageS3Key": "pre-idv/LOCK-001/signature.png",
  "markComplete": true
}
```

All fields are optional — send what you have. When `markComplete: true`, sets `preIDVComplete = true` on the lock code.

**Response:**
```json
{
  "lockCodeId": "LOCK-001",
  "preIDVComplete": true,
  "preIDVBlocked": false
}
```

---

### GET /lock-codes/:id

Returns lock code flags for kiosk routing.

```json
{
  "lockCodeId": "LOCK-001",
  "preIDVComplete": true,
  "preIDVBlocked": false,
  "blockReason": null,
  "createdAt": "2026-06-14T..."
}
```

---

### GET /lock-codes/:id/pre-idv

Kiosk endpoint. Returns full Pre-IDV data AND runs live re-checks against current block lists (3 of 4 — skips underage since age doesn't change).

```json
{
  "preIDVVerification": {
    "veriffVerificationId": "uuid",
    "veriffVendorDataId": "uuid",
    "verifiedAt": "...",
    "expiresAt": "...",
    "biometricData": { ... },
    "blockCheckResults": { ... },
    "idImages": { "frontImageS3Key": "...", "backImageS3Key": "..." },
    "regulatoryAnswers": [ ... ],
    "signatureImageS3Key": "..."
  },
  "reCheckStatus": {
    "blockedConsumerCheck": "PASS",
    "noBuyListCheck": "PASS",
    "lawEnforcementCheck": "PASS",
    "reCheckedAt": "..."
  },
  "reCheckBlocked": false
}
```

---

### GET /status

```json
{
  "veriffBaseUrl": "https://stationapi.veriff.com",
  "port": 3000,
  "sessionsCount": 2,
  "lockCodesCount": 2
}
```

---

### Admin Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/block-lists` | View all block lists |
| POST | `/admin/block-lists/blocked-consumer` | Add entry `{idNumber, firstName, lastName, reason}` |
| DELETE | `/admin/block-lists/blocked-consumer/:idNumber` | Remove entry |
| POST | `/admin/block-lists/le-hold` | Add entry `{idNumber, firstName, lastName}` |
| DELETE | `/admin/block-lists/le-hold/:idNumber` | Remove entry |
| GET | `/admin/lock-codes` | View all lock codes |
| GET | `/admin/log` | View activity log (last 100 entries) |
| POST | `/admin/reset` | Reset all lock codes and sessions (block lists preserved) |

---

## Pre-Seeded Test Data

### Block Lists

| List | ID Number | State | Name |
|------|-----------|-------|------|
| Blocked Consumer | BLOCKED001 | — | John Blocked |
| Blocked Consumer | BLOCKED002 | — | Jane Blocked |
| No-Buy List | NOBUY001 | CA | Bob NoBuy |
| No-Buy List | NOBUY002 | TX | Alice NoBuy |
| LE Hold | LEHOLD001 | — | Mark Held |
| LE Hold | LEHOLD002 | — | Sara Held |

### Veriff Sandbox Decision Control

The `firstName` field when creating a session controls what decision Veriff returns:

| firstName | Decision | Code |
|-----------|----------|------|
| `"Approved"` | Approved | 9001 |
| `"Decline"` | Declined | 9102 |
| `"Resubmission"` | Resubmission requested | 9103 |

---

## In-Memory Data Model

All data is stored in memory (resets on server restart).

### Lock Code Object

```javascript
{
  lockCodeId: "LOCK-001",
  preIDVComplete: false,           // true after markComplete
  preIDVBlocked: false,            // true if any block check fails
  blockReason: null,               // "UNDERAGE" | "BLOCKED_CONSUMER" | "NO_BUY_LIST" | "LAW_ENFORCEMENT_HOLD"
  preIDVVerification: null,        // populated on first PUT /lock-codes/:id/pre-idv
  veriffDecision: null,            // { status, code, decidedAt } — set by webhook
  biometricData: null,             // extracted from Veriff webhook (approved only)
  blockCheckResults: null,         // result of last block check
  currentVerificationId: "uuid",   // links to veriffSessions
  preIDVSessionToken: "uuid",      // vendorData sent to Veriff
  createdAt: "ISO string"
}
```

### Veriff Session Object

```javascript
{
  verificationId: "uuid",          // Veriff's session ID
  preIDVSessionToken: "uuid",      // our vendorData
  lockCodeId: "LOCK-001",
  firstName: "Approved",
  lastName: "Doe",
  status: "created",               // → "approved" | "declined" | "resubmission_requested"
  decision: null,                  // { code, status }
  biometricData: null,             // extracted from webhook
  createdAt: "ISO string"
}
```

---

## Webhook Security

The server verifies Veriff webhook signatures using HMAC-SHA256:

1. Reads the raw request body (registered with `express.raw()` before `express.json()`)
2. Computes `HMAC-SHA256(rawBody, VERIFF_API_SECRET)`
3. Compares against the `x-hmac-signature` or `x-auth-signature` header
4. Rejects with 401 if mismatch

---

## Key Implementation Details

- **Callback URL must be HTTPS** — Veriff rejects `http://` callback URLs (error code 1302). The `WEBHOOK_BASE_URL` env var provides the ngrok HTTPS URL used in session creation.
- **Session matching** — Webhooks are matched first by `verificationId`, then by `vendorData` (our `preIDVSessionToken`) as a fallback.
- **Biometric data only on approval** — When Veriff returns code 9001 (approved), biometric data is extracted and stored. For declined/resubmission, biometric data is null.
- **Block checks use stored data** — The `POST /pre-idv/block-check` endpoint uses biometric data already stored from the webhook. You can also pass `biometricData` directly in the request body to override.
- **Kiosk re-checks are live** — `GET /lock-codes/:id/pre-idv` re-runs block checks against the current state of block lists, catching entries added after the original Pre-IDV was completed.
- **ngrok static URL** — Using `ngrok http --url=natural-bullfrog-moderately.ngrok-free.app 3000` gives a stable URL that doesn't change between restarts, so Veriff Station only needs to be configured once.

---

## Dashboard

The server serves an HTML dashboard at `GET /` (http://localhost:3000) with:

- **Create Veriff Session** — creates a real session, shows the sessionUrl
- **Poll & Status** — poll for decisions, view lock codes, kiosk data
- **Block Checks** — run block checks against stored biometric data
- **Save Pre-IDV Data** — save regulatory answers and mark complete
- **Block List Management** — add/remove entries from block lists
- **Admin** — view all lock codes, server status, reset data
- **Activity Log** — live-updating log of all server activity (auto-refreshes every 3s)
