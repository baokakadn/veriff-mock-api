# Pre-IDV Mock Backend — Complete Workflow

> Full data flow showing every field, every request, and how data moves between
> the mobile app, mock backend, and Veriff. Use this as a reference for implementation.

---

## 1. Create Session

**Mobile App → Mock Backend → Veriff API**

```
Mobile App                          Mock Backend                         Veriff API
    │                                    │                                    │
    │  POST /pre-idv/create-session      │                                    │
    │  {                                 │                                    │
    │    lockCodeId: "LOCK-001",         │                                    │
    │    firstName: "Approved",          │                                    │
    │    lastName: "Doe"                 │                                    │
    │  }                                 │                                    │
    │ ──────────────────────────────────▶│                                    │
    │                                    │                                    │
    │                          Backend generates:                             │
    │                          preIDVSessionToken = uuid()                    │
    │                          (this becomes vendorData)                      │
    │                                    │                                    │
    │                                    │  POST /v1/sessions                 │
    │                                    │  Headers:                          │
    │                                    │    X-AUTH-CLIENT: VERIFF_API_KEY   │
    │                                    │  Body:                             │
    │                                    │  {                                 │
    │                                    │    verification: {                 │
    │                                    │      callback: "https://veriff-    │
    │                                    │        mock-api.onrender.com       │
    │                                    │        /veriff/webhook",           │
    │                                    │      person: {                     │
    │                                    │        firstName: "Approved",      │
    │                                    │        lastName: "Doe"             │
    │                                    │      },                            │
    │                                    │      vendorData:                   │
    │                                    │        preIDVSessionToken,         │
    │                                    │      timestamp: "ISO string"       │
    │                                    │    }                               │
    │                                    │  }                                 │
    │                                    │ ──────────────────────────────────▶│
    │                                    │                                    │
    │                                    │  Response:                         │
    │                                    │  {                                 │
    │                                    │    verification: {                 │
    │                                    │      id: "verificationId",         │
    │                                    │      url: "https://magic.veriff    │
    │                                    │            .me/v/real-uuid",       │
    │                                    │      vendorData:                   │
    │                                    │        preIDVSessionToken           │
    │                                    │    }                               │
    │                                    │  }                                 │
    │                                    │◀──────────────────────────────────│
    │                                    │                                    │
    │                          Backend stores in memory:                      │
    │                          veriffSessions[verificationId] = {             │
    │                            verificationId,                              │
    │                            preIDVSessionToken,                          │
    │                            lockCodeId: "LOCK-001",                      │
    │                            firstName: "Approved",                       │
    │                            status: "created",                           │
    │                            decision: null,                              │
    │                            biometricData: null                          │
    │                          }                                              │
    │                          lockCodes["LOCK-001"] = {                      │
    │                            currentVerificationId: verificationId,       │
    │                            preIDVSessionToken,                          │
    │                            preIDVComplete: false,                       │
    │                            preIDVBlocked: false,                        │
    │                            veriffDecision: null                         │
    │                          }                                              │
    │                                    │                                    │
    │  Response:                         │                                    │
    │  {                                 │                                    │
    │    sessionUrl: "https://magic      │                                    │
    │      .veriff.me/v/real-uuid",      │                                    │
    │    verificationId: "uuid",         │                                    │
    │    vendorDataId:                   │                                    │
    │      preIDVSessionToken            │                                    │
    │  }                                 │                                    │
    │◀──────────────────────────────────│                                    │
```

**Key point:** `vendorData` / `preIDVSessionToken` / `vendorDataId` are all the same UUID. It's the correlation ID that ties your lock code to Veriff's session.

---

## 2. Veriff SDK Camera Flow

**Mobile App → Veriff Servers (direct, not through mock backend)**

```
Mobile App                                              Veriff Servers
    │                                                        │
    │  App launches Veriff SDK with sessionUrl                │
    │  val intent = Sdk.createLaunchIntent(                   │
    │    activity, sessionUrl, config)                        │
    │                                                        │
    │  SDK connects directly to Veriff:                      │
    │ ──────────────────────────────────────────────────────▶│
    │                                                        │
    │  User photographs front of ID                          │
    │ ──────────────────────────────────────────────────────▶│
    │                                                        │
    │  User photographs back of ID                           │
    │ ──────────────────────────────────────────────────────▶│
    │                                                        │
    │  User takes selfie                                     │
    │ ──────────────────────────────────────────────────────▶│
    │                                                        │
    │  SDK returns Status.DONE to app                        │
    │◀──────────────────────────────────────────────────────│
    │                                                        │
    │  (Veriff is now processing in background)              │
    │  (App moves to polling step)                           │
```

**Key point:** The mock backend is NOT involved here. The SDK talks directly to Veriff. The `sessionUrl` already points to Veriff's servers.

---

## 3. Veriff Decision Webhook

**Veriff → Mock Backend (async, after processing completes)**

```
Veriff Servers                       Mock Backend
    │                                    │
    │  POST /veriff/webhook              │
    │  Headers:                          │
    │    x-hmac-signature: HMAC-SHA256   │
    │      of body with VERIFF_API_SECRET│
    │  Body:                             │
    │  {                                 │
    │    verification: {                 │
    │      id: "verificationId",         │
    │      code: 9001,                   │
    │      status: "approved",           │
    │      vendorData:                   │
    │        preIDVSessionToken,         │
    │      person: {                     │
    │        firstName: "John",          │
    │        lastName: "Doe",            │
    │        dateOfBirth: "1990-05-15",  │
    │        gender: "M",               │
    │        addresses: [{               │
    │          fullAddress: "123 Main",  │
    │          parsedAddress: {          │
    │            city: "San Diego",      │
    │            postcode: "92101",      │
    │            state: "CA"             │
    │          }                         │
    │        }]                          │
    │      },                            │
    │      document: {                   │
    │        number: "D1234567",         │
    │        type: "DRIVERS_LICENSE",    │
    │        validUntil: "2030-01-01",   │
    │        issuer: "CA DMV"            │
    │      }                             │
    │    }                               │
    │  }                                 │
    │ ──────────────────────────────────▶│
    │                                    │
    │                          1. Verify HMAC signature       │
    │                             HMAC-SHA256(body, secret)   │
    │                             Must match header           │
    │                                    │
    │                          2. Find session by:            │
    │                             verificationId (primary)    │
    │                             OR vendorData (fallback)    │
    │                                    │
    │                          3. Map decision code:          │
    │                             9001 → "approved"           │
    │                             9102 → "declined"           │
    │                             9103 → "resubmission_       │
    │                                     requested"          │
    │                                    │
    │                          4. Extract biometric data      │
    │                             (only if code == 9001):     │
    │                             person → firstName,         │
    │                               lastName, dateOfBirth,    │
    │                               gender, address, state    │
    │                             document → idNumber,        │
    │                               idType, expirationDate,   │
    │                               issuingAuthority          │
    │                                    │
    │                          5. Store on lock code:         │
    │                             lockCode.veriffDecision = { │
    │                               status: "approved",       │
    │                               code: 9001,               │
    │                               decidedAt: "ISO"          │
    │                             }                           │
    │                             lockCode.biometricData =    │
    │                               extractedData             │
    │                                    │
    │  Response: { status: "ok" }        │
    │◀──────────────────────────────────│
```

**Decision codes:**

| Code | Status | What happens |
|------|--------|-------------|
| 9001 | approved | Biometric data extracted and stored. App proceeds to block checks. |
| 9102 | declined | No biometric data. App shows decline screen with retry option. |
| 9103 | resubmission_requested | No biometric data. App prompts user to retake photos. |

**Key point:** In Veriff sandbox, the `firstName` sent during session creation controls which decision code comes back. `"Approved"` → 9001, `"Decline"` → 9102, `"Resubmission"` → 9103.

---

## 4. App Polls for Decision

**Mobile App → Mock Backend**

```
Mobile App                          Mock Backend
    │                                    │
    │  (App polls repeatedly after       │
    │   SDK returns Status.DONE)         │
    │                                    │
    │  GET /lock-codes/LOCK-001/         │
    │      veriff-status                 │
    │ ──────────────────────────────────▶│
    │                                    │
    │  IF webhook has NOT arrived yet:   │
    │  {                                 │
    │    status: "pending",              │
    │    decision: null,                 │
    │    message: "Waiting for webhook"  │
    │  }                                 │
    │◀──────────────────────────────────│
    │                                    │
    │  ... app waits, polls again ...    │
    │                                    │
    │  GET /lock-codes/LOCK-001/         │
    │      veriff-status                 │
    │ ──────────────────────────────────▶│
    │                                    │
    │  IF webhook HAS arrived:           │
    │  {                                 │
    │    status: "decided",              │
    │    decision: "approved",           │
    │    code: 9001,                     │
    │    decidedAt: "2026-06-14T...",    │
    │    verificationId: "uuid"          │
    │  }                                 │
    │◀──────────────────────────────────│
    │                                    │
    │  App checks decision:              │
    │  - "approved" → go to block checks │
    │  - "declined" → show decline UI    │
    │  - "resubmission_requested"        │
    │    → prompt retake, new session    │
```

---

## 5. Block Checks (if approved)

**Mobile App → Mock Backend**

```
Mobile App                          Mock Backend
    │                                    │
    │  POST /pre-idv/block-check         │
    │  { lockCodeId: "LOCK-001" }        │
    │ ──────────────────────────────────▶│
    │                                    │
    │                          Uses biometricData stored      │
    │                          from webhook (step 3)          │
    │                                    │
    │                          Check 1: AGE                   │
    │                          dateOfBirth → must be 18+      │
    │                          FAIL → blockReason: "UNDERAGE" │
    │                          remaining checks: NOT_RUN      │
    │                                    │
    │                          Check 2: BLOCKED CONSUMER      │
    │                          idNumber lookup in             │
    │                          blockedConsumers map            │
    │                          FAIL → "BLOCKED_CONSUMER"      │
    │                                    │
    │                          Check 3: NO-BUY LIST           │
    │                          idNumber + state lookup in     │
    │                          noBuyList map                   │
    │                          FAIL → "NO_BUY_LIST"           │
    │                                    │
    │                          Check 4: LAW ENFORCEMENT HOLD  │
    │                          idNumber lookup in             │
    │                          lawEnforcementHolds map         │
    │                          FAIL → "LAW_ENFORCEMENT_HOLD"  │
    │                                    │
    │                          Checks run in order.           │
    │                          Stops at first failure.        │
    │                                    │
    │  Response (all pass):              │
    │  {                                 │
    │    ageCheck: "PASS",               │
    │    blockedConsumerCheck: "PASS",    │
    │    noBuyListCheck: "PASS",         │
    │    lawEnforcementCheck: "PASS",    │
    │    blocked: false,                 │
    │    blockReason: null               │
    │  }                                 │
    │◀──────────────────────────────────│
    │                                    │
    │  OR Response (blocked):            │
    │  {                                 │
    │    ageCheck: "PASS",               │
    │    blockedConsumerCheck: "FAIL",    │
    │    noBuyListCheck: "NOT_RUN",      │
    │    lawEnforcementCheck: "NOT_RUN", │
    │    blocked: true,                  │
    │    blockReason: "BLOCKED_CONSUMER" │
    │  }                                 │
    │◀──────────────────────────────────│
    │                                    │
    │  If blocked: show block screen     │
    │  If clear: proceed to regulatory   │
```

---

## 6. Save Pre-IDV Data

**Mobile App → Mock Backend (called incrementally)**

```
Mobile App                          Mock Backend
    │                                    │
    │  PUT /lock-codes/LOCK-001/pre-idv  │
    │  {                                 │
    │    regulatoryAnswers: [            │
    │      {                             │
    │        questionId: "Q1",           │
    │        questionText: "Is your      │
    │          address current?",        │
    │        answer: "Yes"               │
    │      },                            │
    │      {                             │
    │        questionId: "Q2",           │
    │        questionText: "Are you      │
    │          the owner?",              │
    │        answer: "Yes"               │
    │      }                             │
    │    ],                              │
    │    signatureImageS3Key:            │
    │      "pre-idv/LOCK-001/sig.png",   │
    │    markComplete: true              │
    │  }                                 │
    │ ──────────────────────────────────▶│
    │                                    │
    │                          Creates preIDVVerification:    │
    │                          {                              │
    │                            veriffVerificationId,        │
    │                            veriffVendorDataId,          │
    │                            verifiedAt: "ISO",           │
    │                            expiresAt: "+7 days",        │
    │                            biometricData: {...},        │
    │                            blockCheckResults: {...},    │
    │                            idImages: {                  │
    │                              frontImageS3Key,           │
    │                              backImageS3Key             │
    │                            },                           │
    │                            regulatoryAnswers: [...],    │
    │                            signatureImageS3Key          │
    │                          }                              │
    │                          Sets preIDVComplete = true     │
    │                                    │
    │  Response:                         │
    │  {                                 │
    │    lockCodeId: "LOCK-001",         │
    │    preIDVComplete: true,           │
    │    preIDVBlocked: false            │
    │  }                                 │
    │◀──────────────────────────────────│
```

---

## 7. Kiosk Retrieval (at Drop-Off)

**Kiosk → Mock Backend**

```
Kiosk                               Mock Backend
    │                                    │
    │  (User scans lock code at kiosk)   │
    │                                    │
    │  GET /lock-codes/LOCK-001          │
    │ ──────────────────────────────────▶│
    │                                    │
    │  {                                 │
    │    lockCodeId: "LOCK-001",         │
    │    preIDVComplete: true,  ←──── kiosk checks this      │
    │    preIDVBlocked: false,           │
    │    blockReason: null               │
    │  }                                 │
    │◀──────────────────────────────────│
    │                                    │
    │  If preIDVComplete == true:        │
    │                                    │
    │  GET /lock-codes/LOCK-001/pre-idv  │
    │ ──────────────────────────────────▶│
    │                                    │
    │                          Runs LIVE re-checks against    │
    │                          current block lists:           │
    │                          - blockedConsumerCheck          │
    │                          - noBuyListCheck                │
    │                          - lawEnforcementCheck           │
    │                          (skips age — doesn't change)   │
    │                                    │
    │  {                                 │
    │    preIDVVerification: {           │
    │      biometricData: {...},         │
    │      regulatoryAnswers: [...],     │
    │      signatureImageS3Key: "...",   │
    │      blockCheckResults: {...},     │
    │      idImages: {...},              │
    │      verifiedAt: "...",            │
    │      expiresAt: "..."              │
    │    },                              │
    │    reCheckStatus: {                │
    │      blockedConsumerCheck: "PASS", │
    │      noBuyListCheck: "PASS",       │
    │      lawEnforcementCheck: "PASS",  │
    │      reCheckedAt: "..."            │
    │    },                              │
    │    reCheckBlocked: false           │
    │  }                                 │
    │◀──────────────────────────────────│
    │                                    │
    │  If reCheckBlocked == true:        │
    │    Person was added to a block     │
    │    list AFTER completing Pre-IDV.  │
    │    Kiosk rejects the transaction.  │
```

---

## vendorData / preIDVSessionToken Lifecycle

This is the correlation ID that ties everything together:

```
Step 1: Backend generates it
        preIDVSessionToken = uuidv4()
                │
Step 2: Sent to Veriff as vendorData
        POST /v1/sessions { verification: { vendorData: preIDVSessionToken } }
                │
Step 3: Returned to mobile app as vendorDataId
        Response: { vendorDataId: preIDVSessionToken }
                │
Step 4: Veriff echoes it back in webhook
        POST /veriff/webhook { verification: { vendorData: preIDVSessionToken } }
                │
Step 5: Backend uses it to match webhook → lock code
        find session where preIDVSessionToken === verification.vendorData
                │
Step 6: Stored on preIDVVerification as veriffVendorDataId
        lockCode.preIDVVerification.veriffVendorDataId = preIDVSessionToken
```

---

## Complete Happy Path Timeline

```
TIME    ACTION                              WHO → WHERE
─────   ──────────────────────────────────  ─────────────────────────
t=0     POST /pre-idv/create-session        App → Mock Backend
t=0     POST /v1/sessions                   Mock Backend → Veriff API
t=0     Response: sessionUrl                Mock Backend → App
t=1     Launch Veriff SDK                   App → Veriff Servers
t=2     User photographs ID front           App (SDK) → Veriff
t=3     User photographs ID back            App (SDK) → Veriff
t=4     User takes selfie                   App (SDK) → Veriff
t=5     SDK returns Status.DONE             Veriff SDK → App
t=5     GET /lock-codes/:id/veriff-status   App → Mock Backend (pending)
t=6     GET /lock-codes/:id/veriff-status   App → Mock Backend (pending)
t=10    POST /veriff/webhook (9001)         Veriff → Mock Backend
t=11    GET /lock-codes/:id/veriff-status   App → Mock Backend (decided!)
t=12    POST /pre-idv/block-check           App → Mock Backend (all pass)
t=13    PUT /lock-codes/:id/pre-idv         App → Mock Backend (save + complete)
─────   ──────────────────────────────────  ─────────────────────────
LATER   GET /lock-codes/:id                 Kiosk → Mock Backend
LATER   GET /lock-codes/:id/pre-idv         Kiosk → Mock Backend (re-check pass)
```

---

## Hosted Environment

- **Server URL:** https://veriff-mock-api.onrender.com
- **Dashboard:** https://veriff-mock-api.onrender.com/
- **GitHub repo:** https://github.com/baokakadn/veriff-mock-api
- **Veriff Station webhook URLs:**
  - Decision: `https://veriff-mock-api.onrender.com/veriff/webhook`
  - Events: `https://veriff-mock-api.onrender.com/veriff/event-webhook`
- **ngrok (for local dev):** `ngrok http --url=natural-bullfrog-moderately.ngrok-free.app 3000`

---

## Pre-Seeded Block Lists

| List | ID Number | State | Name | Trigger |
|------|-----------|-------|------|---------|
| Blocked Consumer | BLOCKED001 | — | John Blocked | idNumber match |
| Blocked Consumer | BLOCKED002 | — | Jane Blocked | idNumber match |
| No-Buy List | NOBUY001 | CA | Bob NoBuy | idNumber + state match |
| No-Buy List | NOBUY002 | TX | Alice NoBuy | idNumber + state match |
| LE Hold | LEHOLD001 | — | Mark Held | idNumber match |
| LE Hold | LEHOLD002 | — | Sara Held | idNumber match |

Manage via admin endpoints:
- `POST /admin/block-lists/blocked-consumer` — add `{idNumber, firstName, lastName, reason}`
- `DELETE /admin/block-lists/blocked-consumer/:idNumber` — remove
- `POST /admin/block-lists/le-hold` — add `{idNumber, firstName, lastName}`
- `DELETE /admin/block-lists/le-hold/:idNumber` — remove
- `GET /admin/block-lists` — view all
- `POST /admin/reset` — clear all sessions/lock codes (block lists preserved)
