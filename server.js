require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());

app.use('/veriff/webhook', express.raw({ type: 'application/json' }));
app.use('/veriff/event-webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ============================================================
// VERIFF CONFIGURATION (required)
// ============================================================

const VERIFF_API_KEY = process.env.VERIFF_API_KEY;
const VERIFF_API_SECRET = process.env.VERIFF_API_SECRET;
const VERIFF_BASE_URL = process.env.VERIFF_BASE_URL || 'https://stationapi.veriff.com';
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL;

if (!VERIFF_API_KEY || !VERIFF_API_SECRET) {
  console.error('\n  Missing VERIFF_API_KEY or VERIFF_API_SECRET in .env file.');
  console.error('  Copy .env.example to .env and fill in your credentials.\n');
  process.exit(1);
}

if (!WEBHOOK_BASE_URL) {
  console.error('\n  Missing WEBHOOK_BASE_URL in .env file.');
  console.error('  Run "ngrok http 3000" and set WEBHOOK_BASE_URL to your ngrok URL.');
  console.error('  Example: WEBHOOK_BASE_URL=https://abc123.ngrok-free.app\n');
  process.exit(1);
}

// ============================================================
// IN-MEMORY DATA STORES
// ============================================================

const lockCodes = {};
const veriffSessions = {};

const blockedConsumers = {
  'BLOCKED001': { firstName: 'John', lastName: 'Blocked', reason: 'Prior fraud' },
  'BLOCKED002': { firstName: 'Jane', lastName: 'Blocked', reason: 'Policy violation' },
};

const noBuyList = {
  'NOBUY001_CA': { idNumber: 'NOBUY001', state: 'CA', firstName: 'Bob', lastName: 'NoBuy' },
  'NOBUY002_TX': { idNumber: 'NOBUY002', state: 'TX', firstName: 'Alice', lastName: 'NoBuy' },
};

const lawEnforcementHolds = {
  'LEHOLD001': { firstName: 'Mark', lastName: 'Held', holdDate: '2026-01-15' },
  'LEHOLD002': { firstName: 'Sara', lastName: 'Held', holdDate: '2026-03-20' },
};

const webhookLog = [];

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function log(type, message, data = null) {
  const entry = { timestamp: new Date().toISOString(), type, message, data };
  webhookLog.push(entry);
  if (webhookLog.length > 100) webhookLog.shift();
  console.log(`[${entry.timestamp}] [${type}] ${message}`);
}

function checkAge(dateOfBirth) {
  const dob = new Date(dateOfBirth);
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const monthDiff = today.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) age--;
  return age >= 18 ? 'PASS' : 'FAIL';
}

function verifyWebhookSignature(rawBody, signature) {
  const expected = crypto
    .createHmac('sha256', VERIFF_API_SECRET)
    .update(rawBody)
    .digest('hex')
    .toLowerCase();
  return signature && signature.toLowerCase() === expected;
}

function extractBiometricFromVeriff(person, document) {
  if (!person && !document) return null;
  return {
    firstName: person?.firstName || null,
    middleName: person?.middleName || null,
    lastName: person?.lastName || null,
    dateOfBirth: person?.dateOfBirth || null,
    address1: person?.addresses?.[0]?.fullAddress || null,
    address2: null,
    city: person?.addresses?.[0]?.parsedAddress?.city || null,
    postalCode: person?.addresses?.[0]?.parsedAddress?.postcode || null,
    state: person?.addresses?.[0]?.parsedAddress?.state || null,
    gender: person?.gender || null,
    expirationDate: document?.validUntil || null,
    issuingAuthority: document?.issuer || null,
    idType: document?.type || 'ID_CARD',
    idNumber: document?.number || null,
    height: null, weight: null, eyeColor: null, hairColor: null
  };
}

// ============================================================
// ENDPOINT 1: Create Pre-IDV Session
// POST /pre-idv/create-session
//
// Calls real Veriff API to create a verification session.
// Returns the real sessionUrl for the Veriff SDK.
// ============================================================

app.post('/pre-idv/create-session', async (req, res) => {
  const { lockCodeId, firstName, lastName } = req.body;

  if (!lockCodeId) {
    return res.status(400).json({ error: 'lockCodeId is required' });
  }

  if (!lockCodes[lockCodeId]) {
    lockCodes[lockCodeId] = {
      lockCodeId, preIDVComplete: false, preIDVBlocked: false,
      blockReason: null, preIDVVerification: null, veriffDecision: null,
      createdAt: new Date().toISOString()
    };
  }

  const preIDVSessionToken = uuidv4();

  try {
    const veriffPayload = {
      verification: {
        callback: `${WEBHOOK_BASE_URL}/veriff/webhook`,
        person: {
          firstName: firstName || 'Approved',
          lastName: lastName || 'Doe'
        },
        vendorData: preIDVSessionToken,
        timestamp: new Date().toISOString()
      }
    };

    const response = await fetch(`${VERIFF_BASE_URL}/v1/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AUTH-CLIENT': VERIFF_API_KEY
      },
      body: JSON.stringify(veriffPayload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      log('ERROR', `Veriff API error: ${response.status}`, { body: errorText });
      return res.status(502).json({
        error: 'Failed to create Veriff session',
        veriffStatus: response.status,
        details: errorText
      });
    }

    const veriffData = await response.json();
    const verificationId = veriffData.verification.id;
    const sessionUrl = veriffData.verification.url;

    const session = {
      verificationId, preIDVSessionToken, lockCodeId,
      firstName: firstName || 'Approved', lastName: lastName || 'Doe',
      status: 'created', decision: null, biometricData: null,
      createdAt: new Date().toISOString()
    };
    veriffSessions[verificationId] = session;

    lockCodes[lockCodeId].currentVerificationId = verificationId;
    lockCodes[lockCodeId].preIDVSessionToken = preIDVSessionToken;

    log('SESSION', `Created Veriff session for ${lockCodeId}`, {
      verificationId,
      sessionUrl: sessionUrl.substring(0, 60) + '...',
      firstName: session.firstName
    });

    res.json({ sessionUrl, verificationId, vendorDataId: preIDVSessionToken });

  } catch (err) {
    log('ERROR', `Failed to call Veriff API: ${err.message}`);
    res.status(502).json({ error: 'Veriff API unreachable', details: err.message });
  }
});

// ============================================================
// VERIFF DECISION WEBHOOK
// POST /veriff/webhook
//
// Veriff POSTs here after processing a verification.
// Verifies HMAC signature, extracts decision + biometric data.
// Configure this URL in Veriff Station (via ngrok for local dev).
// ============================================================

app.post('/veriff/webhook', (req, res) => {
  const rawBody = req.body;
  const signature = req.headers['x-hmac-signature'] || req.headers['x-auth-signature'];

  if (signature) {
    if (!verifyWebhookSignature(rawBody, signature)) {
      log('ERROR', 'Webhook signature verification FAILED');
      return res.status(401).json({ error: 'Invalid signature' });
    }
    log('WEBHOOK', 'Signature verified OK');
  }

  const payload = JSON.parse(rawBody.toString());
  const verification = payload.verification || payload;
  const verificationId = verification.id;
  const code = verification.code;
  const status = verification.status;
  const reason = verification.reason || null;
  const reasonCode = verification.reasonCode || null;
  const decisionTime = verification.decisionTime || null;
  const acceptanceTime = verification.acceptanceTime || null;
  const person = verification.person || payload.technicalData?.person;
  const document = verification.document || payload.technicalData?.document;
  const additionalVerifiedData = verification.additionalVerifiedData || null;
  const riskLabels = verification.riskLabels || null;
  const vendorData = verification.vendorData || null;

  let targetSession = veriffSessions[verificationId];
  if (!targetSession) {
    targetSession = Object.values(veriffSessions).find(
      s => s.preIDVSessionToken === vendorData
    );
  }

  if (!targetSession) {
    log('WEBHOOK', `Received webhook for unknown session: ${verificationId}`, { code, status, reason, reasonCode });
    return res.json({ status: 'ok', matched: false });
  }

  const decisionStatus = code === 9001 ? 'approved'
    : code === 9102 ? 'declined'
    : code === 9103 ? 'resubmission_requested'
    : status || 'unknown';

  targetSession.status = decisionStatus;
  targetSession.decision = {
    code, status: decisionStatus,
    reason, reasonCode,
    decisionTime, acceptanceTime,
    riskLabels
  };

  const biometricData = extractBiometricFromVeriff(person, document);
  targetSession.biometricData = code === 9001 ? biometricData : null;
  targetSession.additionalVerifiedData = additionalVerifiedData;
  targetSession.rawWebhookPayload = payload;

  const lockCode = lockCodes[targetSession.lockCodeId];
  if (lockCode) {
    lockCode.veriffDecision = {
      status: decisionStatus, code,
      reason, reasonCode,
      decisionTime, acceptanceTime,
      riskLabels,
      decidedAt: new Date().toISOString()
    };
    if (code === 9001 && biometricData) {
      lockCode.biometricData = biometricData;
    }
  }

  log('WEBHOOK', `Decision ${code} (${decisionStatus}) for ${targetSession.lockCodeId}`, {
    verificationId: targetSession.verificationId,
    reason, reasonCode, riskLabels,
    hasBiometricData: !!biometricData,
    personName: person ? `${person.firstName} ${person.lastName}` : 'N/A'
  });

  res.json({ status: 'ok' });
});

// ============================================================
// VERIFF EVENT WEBHOOK
// POST /veriff/event-webhook
//
// Veriff sends status events here (started, submitted, etc.)
// ============================================================

app.post('/veriff/event-webhook', (req, res) => {
  const rawBody = req.body;
  const signature = req.headers['x-hmac-signature'] || req.headers['x-auth-signature'];

  if (signature) {
    if (!verifyWebhookSignature(rawBody, signature)) {
      log('ERROR', 'Event webhook signature verification FAILED');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  const payload = JSON.parse(rawBody.toString());
  const action = payload.action || payload.feature;
  const verificationId = payload.id || payload.verificationId;

  log('EVENT', `Veriff event: ${action} for ${verificationId}`, {
    action, vendorData: payload.vendorData
  });

  res.json({ status: 'ok' });
});

// ============================================================
// ENDPOINT 2: Poll for Veriff Decision
// GET /lock-codes/:id/veriff-status
// ============================================================

app.get('/lock-codes/:id/veriff-status', (req, res) => {
  const lockCode = lockCodes[req.params.id];
  if (!lockCode) {
    return res.status(404).json({ error: 'Lock code not found' });
  }

  if (!lockCode.veriffDecision) {
    return res.json({
      status: 'pending', decision: null,
      message: 'Waiting for Veriff webhook. Ensure ngrok is running and webhook URL is configured in Veriff Station.'
    });
  }

  res.json({
    status: 'decided',
    decision: lockCode.veriffDecision.status,
    code: lockCode.veriffDecision.code,
    reason: lockCode.veriffDecision.reason,
    reasonCode: lockCode.veriffDecision.reasonCode,
    riskLabels: lockCode.veriffDecision.riskLabels,
    decisionTime: lockCode.veriffDecision.decisionTime,
    acceptanceTime: lockCode.veriffDecision.acceptanceTime,
    decidedAt: lockCode.veriffDecision.decidedAt,
    verificationId: lockCode.currentVerificationId
  });
});

// ============================================================
// ENDPOINT 3: Run Block Checks
// POST /pre-idv/block-check
// ============================================================

app.post('/pre-idv/block-check', (req, res) => {
  const { lockCodeId, biometricData } = req.body;
  const data = biometricData || lockCodes[lockCodeId]?.biometricData;

  if (!data) {
    return res.status(400).json({ error: 'No biometric data available. Ensure Veriff approved the session first.' });
  }

  const ageCheck = checkAge(data.dateOfBirth);
  if (ageCheck === 'FAIL') {
    const result = {
      ageCheck: 'FAIL', blockedConsumerCheck: 'NOT_RUN',
      noBuyListCheck: 'NOT_RUN', lawEnforcementCheck: 'NOT_RUN',
      blocked: true, blockReason: 'UNDERAGE', checkedAt: new Date().toISOString()
    };
    updateLockCodeBlock(lockCodeId, result);
    log('BLOCK', `UNDERAGE block for lock code ${lockCodeId}`, { dateOfBirth: data.dateOfBirth });
    return res.json(result);
  }

  if (blockedConsumers[data.idNumber]) {
    const result = {
      ageCheck: 'PASS', blockedConsumerCheck: 'FAIL',
      noBuyListCheck: 'NOT_RUN', lawEnforcementCheck: 'NOT_RUN',
      blocked: true, blockReason: 'BLOCKED_CONSUMER', checkedAt: new Date().toISOString()
    };
    updateLockCodeBlock(lockCodeId, result);
    log('BLOCK', `BLOCKED_CONSUMER for lock code ${lockCodeId}`, { idNumber: data.idNumber });
    return res.json(result);
  }

  const noBuyKey = `${data.idNumber}_${data.state}`;
  if (noBuyList[noBuyKey]) {
    const result = {
      ageCheck: 'PASS', blockedConsumerCheck: 'PASS',
      noBuyListCheck: 'FAIL', lawEnforcementCheck: 'NOT_RUN',
      blocked: true, blockReason: 'NO_BUY_LIST', checkedAt: new Date().toISOString()
    };
    updateLockCodeBlock(lockCodeId, result);
    log('BLOCK', `NO_BUY_LIST for lock code ${lockCodeId}`, { idNumber: data.idNumber, state: data.state });
    return res.json(result);
  }

  if (lawEnforcementHolds[data.idNumber]) {
    const result = {
      ageCheck: 'PASS', blockedConsumerCheck: 'PASS',
      noBuyListCheck: 'PASS', lawEnforcementCheck: 'FAIL',
      blocked: true, blockReason: 'LAW_ENFORCEMENT_HOLD', checkedAt: new Date().toISOString()
    };
    updateLockCodeBlock(lockCodeId, result);
    log('BLOCK', `LAW_ENFORCEMENT_HOLD for lock code ${lockCodeId}`, { idNumber: data.idNumber });
    return res.json(result);
  }

  const result = {
    ageCheck: 'PASS', blockedConsumerCheck: 'PASS',
    noBuyListCheck: 'PASS', lawEnforcementCheck: 'PASS',
    blocked: false, blockReason: null, checkedAt: new Date().toISOString()
  };
  if (lockCodes[lockCodeId]) lockCodes[lockCodeId].blockCheckResults = result;
  log('PASS', `All block checks PASSED for lock code ${lockCodeId}`);
  return res.json(result);
});

function updateLockCodeBlock(lockCodeId, result) {
  if (lockCodes[lockCodeId]) {
    lockCodes[lockCodeId].preIDVBlocked = true;
    lockCodes[lockCodeId].blockReason = result.blockReason;
    lockCodes[lockCodeId].blockCheckResults = result;
  }
}

// ============================================================
// ENDPOINT 4: Save Pre-IDV Data
// PUT /lock-codes/:id/pre-idv
// ============================================================

app.put('/lock-codes/:id/pre-idv', (req, res) => {
  const lockCode = lockCodes[req.params.id];
  if (!lockCode) return res.status(404).json({ error: 'Lock code not found' });

  const { regulatoryAnswers, signatureImageS3Key, markComplete } = req.body;

  if (!lockCode.preIDVVerification) {
    lockCode.preIDVVerification = {
      veriffVerificationId: lockCode.currentVerificationId,
      veriffVendorDataId: lockCode.preIDVSessionToken,
      verifiedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      biometricData: lockCode.biometricData,
      blockCheckResults: lockCode.blockCheckResults,
      idImages: {
        frontImageS3Key: `pre-idv/${req.params.id}/front.jpg`,
        backImageS3Key: `pre-idv/${req.params.id}/back.jpg`
      },
      regulatoryAnswers: null, signatureImageS3Key: null
    };
  }

  if (regulatoryAnswers) {
    lockCode.preIDVVerification.regulatoryAnswers = regulatoryAnswers;
    log('DATA', `Regulatory answers saved for ${req.params.id}`, { count: regulatoryAnswers.length });
  }
  if (signatureImageS3Key) {
    lockCode.preIDVVerification.signatureImageS3Key = signatureImageS3Key;
    log('DATA', `Signature saved for ${req.params.id}`);
  }
  if (markComplete) {
    lockCode.preIDVComplete = true;
    log('COMPLETE', `Pre-IDV COMPLETE for lock code ${req.params.id}`);
  }

  res.json({
    lockCodeId: req.params.id,
    preIDVComplete: lockCode.preIDVComplete,
    preIDVBlocked: lockCode.preIDVBlocked
  });
});

// ============================================================
// ENDPOINT 5: Get Lock Code
// GET /lock-codes/:id
// ============================================================

app.get('/lock-codes/:id', (req, res) => {
  const lockCode = lockCodes[req.params.id];
  if (!lockCode) return res.status(404).json({ error: 'Lock code not found' });

  res.json({
    lockCodeId: lockCode.lockCodeId,
    preIDVComplete: lockCode.preIDVComplete,
    preIDVBlocked: lockCode.preIDVBlocked,
    blockReason: lockCode.blockReason,
    createdAt: lockCode.createdAt
  });
});

// ============================================================
// ENDPOINT 6: Get Pre-IDV Data (Kiosk)
// GET /lock-codes/:id/pre-idv
// ============================================================

app.get('/lock-codes/:id/pre-idv', (req, res) => {
  const lockCode = lockCodes[req.params.id];
  if (!lockCode) return res.status(404).json({ error: 'Lock code not found' });
  if (!lockCode.preIDVVerification) return res.status(404).json({ error: 'No Pre-IDV data for this lock code' });

  const data = lockCode.biometricData || {};
  const reCheckStatus = {
    blockedConsumerCheck: blockedConsumers[data.idNumber] ? 'FAIL' : 'PASS',
    noBuyListCheck: noBuyList[`${data.idNumber}_${data.state}`] ? 'FAIL' : 'PASS',
    lawEnforcementCheck: lawEnforcementHolds[data.idNumber] ? 'FAIL' : 'PASS',
    reCheckedAt: new Date().toISOString()
  };

  const reCheckBlocked = reCheckStatus.blockedConsumerCheck === 'FAIL'
    || reCheckStatus.noBuyListCheck === 'FAIL'
    || reCheckStatus.lawEnforcementCheck === 'FAIL';

  if (reCheckBlocked) {
    log('RE-CHECK', `Kiosk re-check found NEW BLOCK for ${req.params.id}`, reCheckStatus);
  } else {
    log('RE-CHECK', `Kiosk re-check all PASS for ${req.params.id}`);
  }

  res.json({ preIDVVerification: lockCode.preIDVVerification, reCheckStatus, reCheckBlocked });
});

// ============================================================
// ENDPOINT 6: Get Latest Webhook Data
// GET /admin/webhooks
// Returns all sessions that have received a webhook decision,
// with full decision details, biometric data, and raw payload.
// ============================================================

app.get('/admin/webhooks', (req, res) => {
  const webhooks = Object.values(veriffSessions)
    .filter(s => s.decision)
    .sort((a, b) => {
      const tA = a.decision.decisionTime || '';
      const tB = b.decision.decisionTime || '';
      return tB.localeCompare(tA);
    })
    .map(s => ({
      lockCodeId: s.lockCodeId,
      verificationId: s.verificationId,
      decision: s.decision,
      biometricData: s.biometricData,
      additionalVerifiedData: s.additionalVerifiedData,
      rawWebhookPayload: s.rawWebhookPayload
    }));
  res.json(webhooks);
});

// ============================================================
// STATUS
// GET /status
// ============================================================

app.get('/status', (req, res) => {
  res.json({
    veriffBaseUrl: VERIFF_BASE_URL,
    port: PORT,
    sessionsCount: Object.keys(veriffSessions).length,
    lockCodesCount: Object.keys(lockCodes).length
  });
});

// ============================================================
// ADMIN: Manage Block Lists
// ============================================================

app.post('/admin/block-lists/blocked-consumer', (req, res) => {
  const { idNumber, firstName, lastName, reason } = req.body;
  blockedConsumers[idNumber] = { firstName, lastName, reason };
  log('ADMIN', `Added ${idNumber} to blocked consumer list`);
  res.json({ success: true, blockedConsumers: Object.keys(blockedConsumers) });
});

app.delete('/admin/block-lists/blocked-consumer/:idNumber', (req, res) => {
  delete blockedConsumers[req.params.idNumber];
  log('ADMIN', `Removed ${req.params.idNumber} from blocked consumer list`);
  res.json({ success: true, blockedConsumers: Object.keys(blockedConsumers) });
});

app.post('/admin/block-lists/le-hold', (req, res) => {
  const { idNumber, firstName, lastName } = req.body;
  lawEnforcementHolds[idNumber] = { firstName, lastName, holdDate: new Date().toISOString() };
  log('ADMIN', `Added ${idNumber} to LE hold list`);
  res.json({ success: true, leHolds: Object.keys(lawEnforcementHolds) });
});

app.delete('/admin/block-lists/le-hold/:idNumber', (req, res) => {
  delete lawEnforcementHolds[req.params.idNumber];
  log('ADMIN', `Removed ${req.params.idNumber} from LE hold list`);
  res.json({ success: true, leHolds: Object.keys(lawEnforcementHolds) });
});

app.get('/admin/block-lists', (req, res) => {
  res.json({
    blockedConsumers: Object.entries(blockedConsumers).map(([id, d]) => ({ idNumber: id, ...d })),
    noBuyList: Object.entries(noBuyList).map(([key, d]) => ({ key, ...d })),
    lawEnforcementHolds: Object.entries(lawEnforcementHolds).map(([id, d]) => ({ idNumber: id, ...d }))
  });
});

app.get('/admin/lock-codes', (req, res) => {
  res.json(Object.values(lockCodes));
});

app.get('/admin/log', (req, res) => {
  res.json(webhookLog.slice().reverse());
});

app.post('/admin/reset', (req, res) => {
  Object.keys(lockCodes).forEach(k => delete lockCodes[k]);
  Object.keys(veriffSessions).forEach(k => delete veriffSessions[k]);
  webhookLog.length = 0;
  log('ADMIN', 'All data reset');
  res.json({ success: true, message: 'All lock codes and sessions cleared. Block lists preserved.' });
});

// ============================================================
// TEST DASHBOARD
// ============================================================

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ecoATM Pre-IDV Mock Backend</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f1419; color: #e7e9ea; line-height: 1.5; }
  .header { background: #1b4d5c; padding: 20px 32px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  .header h1 { font-size: 20px; font-weight: 600; }
  .header .badge { background: #f59e0b; color: #0f1419; padding: 2px 10px; border-radius: 12px; font-size: 12px; font-weight: 700; }
  .container { max-width: 1200px; margin: 0 auto; padding: 24px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px; }
  .card { background: #1a1f26; border: 1px solid #2d3640; border-radius: 12px; padding: 20px; }
  .card h2 { font-size: 15px; color: #14e5c5; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
  label { display: block; font-size: 12px; color: #8b98a5; margin-bottom: 4px; }
  input, select { width: 100%; padding: 8px 12px; background: #0f1419; border: 1px solid #2d3640; border-radius: 6px; color: #e7e9ea; font-size: 14px; margin-bottom: 10px; }
  input:focus, select:focus { outline: none; border-color: #14e5c5; }
  button { padding: 8px 16px; border: none; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.2s; }
  .btn-primary { background: #14e5c5; color: #0f1419; }
  .btn-primary:hover { background: #0fc5a8; }
  .btn-danger { background: #f4212e; color: white; }
  .btn-danger:hover { background: #d91c28; }
  .btn-secondary { background: #2d3640; color: #e7e9ea; }
  .btn-secondary:hover { background: #3d4650; }
  .btn-warning { background: #f59e0b; color: #0f1419; }
  .btn-warning:hover { background: #d97706; }
  .btn-group { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
  .result { background: #0f1419; border: 1px solid #2d3640; border-radius: 8px; padding: 12px; margin-top: 12px; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; max-height: 300px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; }
  .result.pass { border-color: #00ba7c; }
  .result.fail { border-color: #f4212e; }
  .log-entry { padding: 6px 0; border-bottom: 1px solid #1a1f26; font-size: 12px; }
  .log-entry .time { color: #536471; }
  .log-entry .type { display: inline-block; min-width: 70px; padding: 1px 6px; border-radius: 3px; font-size: 11px; font-weight: 600; }
  .type-SESSION { background: #1d4ed8; color: white; }
  .type-WEBHOOK { background: #7c3aed; color: white; }
  .type-BLOCK { background: #f4212e; color: white; }
  .type-PASS { background: #00ba7c; color: white; }
  .type-COMPLETE { background: #14e5c5; color: #0f1419; }
  .type-DATA { background: #f59e0b; color: #0f1419; }
  .type-ADMIN { background: #536471; color: white; }
  .type-EVENT { background: #06b6d4; color: white; }
  .type-ERROR { background: #dc2626; color: white; }
  .type-RE-CHECK { background: #ec4899; color: white; }
  .full-width { grid-column: 1 / -1; }
  .info-banner { padding: 12px 20px; border-radius: 8px; margin-bottom: 20px; font-size: 13px; background: #f59e0b22; border: 1px solid #f59e0b44; }
  .info-banner code { background: #0f1419; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
</style>
</head>
<body>
<div class="header">
  <h1>ecoATM Pre-IDV Mock Backend</h1>
  <span class="badge">REAL VERIFF</span>
  <span style="color: #8b98a5; font-size: 13px; margin-left: auto;">Port ${PORT}</span>
</div>
<div class="container">

  <div class="info-banner">
    Connected to <strong>real Veriff API</strong>. Sessions create real verifications.
    Webhook callback: <code>${WEBHOOK_BASE_URL}/veriff/webhook</code>
  </div>

  <div class="grid">
    <!-- CREATE VERIFF SESSION -->
    <div class="card">
      <h2>Create Veriff Session</h2>
      <label>Lock Code ID</label>
      <input id="lockCodeId" value="LOCK-001" />
      <label>firstName (controls sandbox decision)</label>
      <select id="firstName">
        <option value="Approved">Approved (9001)</option>
        <option value="Decline">Decline (9102)</option>
        <option value="Resubmission">Resubmission (9103)</option>
      </select>
      <div class="btn-group">
        <button class="btn-warning" onclick="createSession()">Create Real Veriff Session</button>
      </div>
      <div id="session-result" class="result" style="display:none;"></div>
    </div>

    <!-- POLL & STATUS -->
    <div class="card">
      <h2>Poll & Status</h2>
      <label>Lock Code ID</label>
      <input id="pollLockCodeId" value="LOCK-001" />
      <div class="btn-group">
        <button class="btn-primary" onclick="pollStatus()">Poll Veriff Status</button>
        <button class="btn-secondary" onclick="getLockCode()">Get Lock Code</button>
        <button class="btn-secondary" onclick="getPreIDVData()">Get Pre-IDV Data (Kiosk)</button>
      </div>
      <div id="poll-result" class="result" style="display:none;"></div>
    </div>

    <!-- BLOCK CHECKS -->
    <div class="card">
      <h2>Block Checks</h2>
      <label>Lock Code ID (uses biometric data from webhook)</label>
      <input id="blockCheckLockCodeId" value="LOCK-001" />
      <div class="btn-group">
        <button class="btn-primary" onclick="runBlockCheck()">Run Block Checks</button>
      </div>
      <div id="blockcheck-result" class="result" style="display:none;"></div>
    </div>

    <!-- SAVE PRE-IDV DATA -->
    <div class="card">
      <h2>Save Pre-IDV Data</h2>
      <label>Lock Code ID</label>
      <input id="saveLockCodeId" value="LOCK-001" />
      <div class="btn-group">
        <button class="btn-primary" onclick="savePreIDV()">Save Answers & Mark Complete</button>
      </div>
      <div id="save-result" class="result" style="display:none;"></div>
    </div>

    <!-- BLOCK LIST MANAGEMENT -->
    <div class="card">
      <h2>Manage Block Lists</h2>
      <label>ID Number</label>
      <input id="blockIdNumber" placeholder="e.g. TEST001" />
      <label>List Type</label>
      <select id="blockListType">
        <option value="blocked-consumer">Blocked Consumer</option>
        <option value="le-hold">Law Enforcement Hold</option>
      </select>
      <div class="btn-group">
        <button class="btn-danger" onclick="addToBlockList()">Add to List</button>
        <button class="btn-secondary" onclick="removeFromBlockList()">Remove from List</button>
        <button class="btn-secondary" onclick="viewBlockLists()">View All Lists</button>
      </div>
      <div id="block-result" class="result" style="display:none;"></div>
    </div>

    <!-- ADMIN -->
    <div class="card">
      <h2>Admin</h2>
      <div class="btn-group">
        <button class="btn-secondary" onclick="viewAllLockCodes()">View All Lock Codes</button>
        <button class="btn-secondary" onclick="checkStatus()">Server Status</button>
        <button class="btn-danger" onclick="resetAll()">Reset All Data</button>
      </div>
      <div id="admin-result" class="result" style="display:none;"></div>
    </div>

    <!-- LIVE WEBHOOK DATA -->
    <div class="card full-width">
      <h2>Webhook Data (Live)</h2>
      <p id="webhook-status" style="font-size: 12px; color: #8b98a5; margin-bottom: 12px;">Auto-refreshes every 3 seconds. Shows biometric data and decision details from Veriff webhooks.</p>
      <div id="webhook-data" style="display: flex; flex-direction: column; gap: 12px;">
        <div style="color: #536471; font-size: 13px;">No webhook data yet. Create a session and complete Veriff verification.</div>
      </div>
    </div>

    <!-- ACTIVITY LOG -->
    <div class="card full-width">
      <h2>Activity Log</h2>
      <div id="log" class="result" style="max-height: 400px;">Loading...</div>
    </div>
  </div>
</div>

<script>
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  return res.json();
}

function show(id, data, pass) {
  const el = document.getElementById(id);
  el.style.display = 'block';
  el.textContent = JSON.stringify(data, null, 2);
  el.className = 'result' + (pass === true ? ' pass' : pass === false ? ' fail' : '');
}

async function createSession() {
  const data = await api('POST', '/pre-idv/create-session', {
    lockCodeId: document.getElementById('lockCodeId').value,
    firstName: document.getElementById('firstName').value
  });
  show('session-result', data, !!data.sessionUrl);
  refreshLog();
  startWebhookRefresh();
  refreshWebhooks();
}

async function pollStatus() {
  const data = await api('GET', '/lock-codes/' + document.getElementById('pollLockCodeId').value + '/veriff-status');
  show('poll-result', data, data.status === 'decided');
}

async function getLockCode() {
  const data = await api('GET', '/lock-codes/' + document.getElementById('pollLockCodeId').value);
  show('poll-result', data);
}

async function getPreIDVData() {
  const data = await api('GET', '/lock-codes/' + document.getElementById('pollLockCodeId').value + '/pre-idv');
  show('poll-result', data, !data.reCheckBlocked);
  refreshLog();
}

async function runBlockCheck() {
  const lockCodeId = document.getElementById('blockCheckLockCodeId').value;
  const data = await api('POST', '/pre-idv/block-check', { lockCodeId });
  show('blockcheck-result', data, !data.blocked);
  refreshLog();
}

async function savePreIDV() {
  const lockCodeId = document.getElementById('saveLockCodeId').value;
  const data = await api('PUT', '/lock-codes/' + lockCodeId + '/pre-idv', {
    regulatoryAnswers: [{ questionId: 'Q1', questionText: 'Is address current?', answer: 'Yes' }],
    markComplete: true
  });
  show('save-result', data, data.preIDVComplete);
  refreshLog();
}

async function addToBlockList() {
  const type = document.getElementById('blockListType').value;
  const idNumber = document.getElementById('blockIdNumber').value;
  const data = await api('POST', '/admin/block-lists/' + type, { idNumber, firstName: 'Test', lastName: 'User' });
  show('block-result', data);
  refreshLog();
}

async function removeFromBlockList() {
  const type = document.getElementById('blockListType').value;
  const idNumber = document.getElementById('blockIdNumber').value;
  const data = await api('DELETE', '/admin/block-lists/' + type + '/' + idNumber);
  show('block-result', data);
  refreshLog();
}

async function viewBlockLists() {
  const data = await api('GET', '/admin/block-lists');
  show('block-result', data);
}

async function viewAllLockCodes() {
  const data = await api('GET', '/admin/lock-codes');
  show('admin-result', data);
}

async function checkStatus() {
  const data = await api('GET', '/status');
  show('admin-result', data);
}

async function resetAll() {
  if (!confirm('Reset all lock codes and sessions?')) return;
  const data = await api('POST', '/admin/reset');
  show('admin-result', data);
  refreshLog();
}

async function refreshLog() {
  const data = await api('GET', '/admin/log');
  const el = document.getElementById('log');
  el.innerHTML = data.map(e =>
    '<div class="log-entry">' +
    '<span class="time">' + e.timestamp.split('T')[1].split('.')[0] + '</span> ' +
    '<span class="type type-' + e.type + '">' + e.type + '</span> ' +
    e.message +
    '</div>'
  ).join('');
}

const expandedRawPanels = new Set();
let webhookIntervalId = null;

async function refreshWebhooks() {
  const data = await api('GET', '/admin/webhooks');
  const el = document.getElementById('webhook-data');
  const statusEl = document.getElementById('webhook-status');
  if (!data.length) {
    el.innerHTML = '<div style="color: #536471; font-size: 13px;">No webhook data yet. Create a session and complete Veriff verification.</div>';
    statusEl.textContent = 'Auto-refreshes every 3 seconds. Shows biometric data and decision details from Veriff webhooks.';
    return;
  }

  const allDecided = data.every(w => w.decision && w.decision.code);
  if (allDecided && webhookIntervalId) {
    clearInterval(webhookIntervalId);
    webhookIntervalId = null;
    statusEl.innerHTML = 'All sessions have final decisions. <span style="color: #00ba7c;">Refresh paused.</span> <button class="btn-secondary" style="font-size: 11px; padding: 2px 8px;" onclick="startWebhookRefresh()">Resume</button>';
  } else if (!allDecided && !webhookIntervalId) {
    startWebhookRefresh();
    statusEl.textContent = 'Auto-refreshing every 3 seconds...';
  }

  el.innerHTML = data.map(w => {
    const d = w.decision || {};
    const isApproved = d.code === 9001;
    const isDeclined = d.code === 9102;
    const borderColor = isApproved ? '#00ba7c' : isDeclined ? '#f4212e' : '#f59e0b';
    const statusLabel = isApproved ? 'APPROVED' : isDeclined ? 'DECLINED' : (d.status || 'UNKNOWN').toUpperCase();
    const rawId = 'raw-' + (w.verificationId || '').replace(/[^a-z0-9]/gi, '');

    let html = '<div style="background: #0f1419; border: 1px solid ' + borderColor + '; border-radius: 8px; padding: 16px;">';
    html += '<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">';
    html += '<span style="font-size: 14px; font-weight: 600;">' + (w.lockCodeId || 'N/A') + '</span>';
    html += '<span style="background: ' + borderColor + '; color: ' + (isApproved ? '#0f1419' : 'white') + '; padding: 2px 10px; border-radius: 12px; font-size: 11px; font-weight: 700;">' + statusLabel + ' (' + d.code + ')</span>';
    html += '</div>';

    // Decision details
    html += '<div style="font-size: 11px; color: #14e5c5; font-weight: 600; margin-bottom: 6px; text-transform: uppercase;">Decision</div>';
    html += '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 4px 16px; font-size: 12px; margin-bottom: 12px;">';
    html += field('Reason', d.reason);
    html += field('Reason Code', d.reasonCode);
    html += field('Decision Time', d.decisionTime);
    html += field('Acceptance Time', d.acceptanceTime);
    html += '</div>';

    // Risk labels
    if (d.riskLabels && d.riskLabels.length) {
      html += '<div style="font-size: 11px; color: #14e5c5; font-weight: 600; margin-bottom: 6px; text-transform: uppercase;">Risk Labels</div>';
      html += '<div style="display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px;">';
      d.riskLabels.forEach(function(rl) {
        const catColor = rl.category === 'crosslinks' ? '#7c3aed'
          : rl.category === 'document' ? '#1d4ed8'
          : rl.category === 'person' ? '#00ba7c'
          : rl.category === 'device' ? '#f59e0b'
          : rl.category === 'client_data_mismatch' ? '#ec4899'
          : '#536471';
        html += '<div style="background: ' + catColor + '22; border: 1px solid ' + catColor + '66; border-radius: 6px; padding: 4px 8px; font-size: 11px;">';
        html += '<div style="font-weight: 600; color: ' + catColor + ';">' + (rl.category || 'unknown') + '</div>';
        html += '<div style="color: #e7e9ea;">' + (rl.label || '').replace(/_/g, ' ') + '</div>';
        if (rl.sessionIds && rl.sessionIds.length) {
          html += '<div style="color: #536471; font-size: 10px; margin-top: 2px;">' + rl.sessionIds.length + ' linked session(s)</div>';
        }
        html += '</div>';
      });
      html += '</div>';
    }

    // Biometric data
    if (w.biometricData) {
      const b = w.biometricData;
      html += '<div style="font-size: 11px; color: #14e5c5; font-weight: 600; margin-bottom: 6px; text-transform: uppercase;">Biometric Data</div>';
      html += '<div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 4px 16px; font-size: 12px; margin-bottom: 12px;">';
      html += field('First Name', b.firstName);
      html += field('Middle Name', b.middleName);
      html += field('Last Name', b.lastName);
      html += field('Date of Birth', b.dateOfBirth);
      html += field('Gender', b.gender);
      html += field('Address', b.address1);
      html += field('City', b.city);
      html += field('State', b.state);
      html += field('Postal Code', b.postalCode);
      html += field('ID Type', b.idType);
      html += field('ID Number', b.idNumber);
      html += field('Expiration', b.expirationDate);
      html += field('Issuing Authority', b.issuingAuthority);
      html += '</div>';
    } else {
      html += '<div style="font-size: 12px; color: #536471; margin-bottom: 12px;">No biometric data (decision was not approved)</div>';
    }

    // Raw payload toggle
    if (w.rawWebhookPayload) {
      const isOpen = expandedRawPanels.has(rawId);
      html += '<button class="btn-secondary" style="font-size: 11px; padding: 4px 10px;" onclick="toggleRaw(\\'' + rawId + '\\')">' + (isOpen ? 'Hide' : 'Show') + ' Raw Payload</button>';
      html += '<pre id="' + rawId + '" style="display:' + (isOpen ? 'block' : 'none') + '; margin-top: 8px; font-size: 11px; color: #8b98a5; max-height: 300px; overflow-y: auto; white-space: pre-wrap; word-break: break-all;">' + JSON.stringify(w.rawWebhookPayload, null, 2) + '</pre>';
    }

    html += '</div>';
    return html;
  }).join('');
}

function field(label, value) {
  const v = value != null ? value : '<span style="color:#536471">—</span>';
  return '<div><span style="color: #8b98a5;">' + label + ':</span> ' + v + '</div>';
}

function toggleRaw(id) {
  const el = document.getElementById(id);
  if (expandedRawPanels.has(id)) {
    expandedRawPanels.delete(id);
    el.style.display = 'none';
  } else {
    expandedRawPanels.add(id);
    el.style.display = 'block';
  }
}

function startWebhookRefresh() {
  if (webhookIntervalId) return;
  webhookIntervalId = setInterval(refreshWebhooks, 3000);
  const statusEl = document.getElementById('webhook-status');
  if (statusEl) statusEl.textContent = 'Auto-refreshing every 3 seconds...';
}

setInterval(refreshLog, 3000);
refreshLog();
startWebhookRefresh();
refreshWebhooks();
</script>
</body>
</html>`);
});

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║           ecoATM Pre-IDV Mock Backend                       ║
║                                                              ║
║   Dashboard:  http://localhost:${PORT}                         ║
║   API Base:   http://localhost:${PORT}                         ║
║   Veriff API: ${VERIFF_BASE_URL.padEnd(43)}║
║                                                              ║
║   Webhook endpoints (set in Veriff Station via ngrok):       ║
║     Decision: POST /veriff/webhook                           ║
║     Events:   POST /veriff/event-webhook                     ║
║                                                              ║
║   Sandbox decision control (firstName):                      ║
║     "Approved"     → 9001 Approved                           ║
║     "Decline"      → 9102 Declined                           ║
║     "Resubmission" → 9103 Resubmission                      ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝

  Veriff API Key: ${VERIFF_API_KEY.substring(0, 8)}...
  Veriff Base URL: ${VERIFF_BASE_URL}
  Webhook URL:     ${WEBHOOK_BASE_URL}

  Set these in Veriff Station → Settings:
    Decision webhook: ${WEBHOOK_BASE_URL}/veriff/webhook
    Event webhook:    ${WEBHOOK_BASE_URL}/veriff/event-webhook
  `);
});
