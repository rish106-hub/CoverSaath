import http from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  createCase, runCase, approveQuestion, recordReply, reviewPurchase,
  simulatePayment, revokeConsent,
} from '../core/engine.js';
import { capabilities } from '../adapters/index.js';
import { createOrchestrator } from '../orchestration/index.js';
import { createModelExecutor, createFixtureExecutor, modelConfigurationStatus } from '../models/index.js';
import { failure, publicError } from './http/errors.js';
import { prepareJsonResponse, readBody, sendJson } from './http/request.js';
import { assertLocalRequest } from './http/security.js';
import { openDatabase } from '../backend/database/index.js';
import { createBackendServices } from '../backend/services/index.js';
import {
  createEmailProvider,
  createGnaniVoiceProvider,
  createPineLabsPaymentProvider,
  createSarvamOcrProvider,
} from '../integrations/index.js';
import { handleV1BackendRoute } from './routes/v1-backend-routes.js';

function validateInput(value) {
  if (!['planned_care', 'renewal', 'emergency'].includes(value.trigger)) throw failure(400, 'Choose a supported trigger.');
  if (typeof value.consent !== 'boolean') throw failure(400, 'Consent must be explicit.');
  const clean = { trigger: value.trigger, consent: value.consent };
  for (const key of ['patientName', 'procedure', 'hospital']) {
    if (typeof value[key] !== 'string' || value[key].length > 200) throw failure(400, `Check ${key}.`);
    clean[key] = value[key].trim();
  }
  if (typeof value.estimate !== 'number' || !Number.isFinite(value.estimate) || value.estimate < 0 || value.estimate > 100000000) throw failure(400, 'Enter a valid estimate.');
  clean.estimate = value.estimate;
  // No personal input is retained when permission was refused.
  if (!clean.consent) return { trigger: clean.trigger, consent: false, patientName: '', procedure: '', hospital: '', estimate: 0 };
  return clean;
}

export function createApiServer({
  executor,
  fixtureExecutor,
  orchestrator,
  store,
  env = process.env,
  database: injectedDatabase,
  databasePath,
  backendServices,
} = {}) {
  const cases = new Map();
  const runOwners = new Map();
  const liveExecutor = executor || createModelExecutor({ env });
  const localExecutor = fixtureExecutor || createFixtureExecutor();
  const budgets = {};
  for (const [name, key] of [['ORCHESTRATION_RUN_BUDGET_USD', 'budgetUsd'], ['ORCHESTRATION_PROJECT_BUDGET_USD', 'projectBudgetUsd']]) {
    if (env[name] !== undefined) {
      const value = Number(env[name]);
      if (!Number.isFinite(value) || value <= 0 || (key === 'budgetUsd' && value > 1)) throw new Error(`Invalid ${name}.`);
      budgets[key] = value;
    }
  }
  const sharedEngine = orchestrator || createOrchestrator({ ...budgets, ...(store ? { store } : {}), executor: { reservationUsd({ mode }) {
    const selected = mode === 'fixture' ? localExecutor : liveExecutor;
    return typeof selected.reservationUsd === 'function' ? selected.reservationUsd({ mode }) : mode === 'fixture' ? 0 : 0.02;
  }, execute(request) {
    return (request.packet.mode === 'fixture' ? localExecutor : liveExecutor).execute(request);
  } } });
  const engines = { live: sharedEngine, fixture: sharedEngine };
  const sessions = new Map();
  const locks = new Set();
  const expiry = 60 * 60 * 1000;
  const ownsDatabase = !injectedDatabase;
  let database = injectedDatabase ?? null;
  let services = backendServices ?? null;
  const getBackend = () => {
    database ||= openDatabase({ path: databasePath ?? env.DATABASE_PATH ?? '.local/coversaath.sqlite' });
    services ||= createBackendServices(database);
    return { database, services };
  };
  const integrations = {
    sarvam: createSarvamOcrProvider({ env }),
    gnani: createGnaniVoiceProvider({ env }),
    pineLabs: createPineLabsPaymentProvider({ env }),
    email: createEmailProvider({ env }),
  };
  const server = http.createServer(async (req, res) => {
    prepareJsonResponse(res);
    const send = (status, value) => sendJson(res, status, value);
    try {
      // Local-only isolation. Host checks also reduce DNS-rebinding exposure.
      assertLocalRequest(req);
      const url = new URL(req.url, 'http://127.0.0.1:8787');
      if (url.pathname.startsWith('/api/v1/')) {
        const backend = getBackend();
        const backendResult = await handleV1BackendRoute({ req, url, ...backend, integrations });
        return send(backendResult.status, backendResult.body);
      }
      if (req.method === 'GET' && url.pathname === '/api/health') {
        const config = modelConfigurationStatus(env);
        return send(200, { mode: 'synthetic_cases_with_optional_live_models', persistence: { cases: 'memory_only', orchestration: store ? 'injected_local_store' : 'local_disk_single_process' }, capabilities: { ...capabilities(env), models: { ...config, status: executor || config.configured ? 'configured_not_connectivity_verified' : 'not_configured', role: 'Bounded structured analysis; no claim authority or external actions.' } } });
      }
      if (req.method === 'GET' && url.pathname === '/api/orchestration/config') {
        return send(200, { ...modelConfigurationStatus(env), liveConfigured: Boolean(executor || modelConfigurationStatus(env).configured), fixtureAvailable: true, defaultMode: 'live', telephonyConnected: false, syntheticCasesOnly: true });
      }
      const now = Date.now();
      for (const [key, session] of sessions) if (session.expiresAt < now) sessions.delete(key);
      for (const [key, entry] of cases) if (!sessions.has(entry.owner)) {
        await Promise.all([...runOwners.entries()].filter(([, owned]) => owned.caseId === key).map(async ([id, owned]) => {
          await engines[owned.mode].revoke(id); runOwners.delete(id);
        }));
        cases.delete(key);
      }
      const cookie = req.headers.cookie?.match(/(?:^|;\s*)coversaath_session=([a-f0-9-]{36})(?:;|$)/)?.[1];
      let sessionId = cookie && sessions.has(cookie) ? cookie : null;
      if (!sessionId && req.method === 'POST' && url.pathname === '/api/cases') {
        if (sessions.size >= 100) throw failure(429, 'Demo capacity reached. Restart the local server.');
        sessionId = randomUUID();
        sessions.set(sessionId, { expiresAt: now + expiry });
        res.setHeader('Set-Cookie', `coversaath_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=3600`);
      }
      if (!sessionId) throw failure(401, 'Open a new demo case first.');
      if (req.method === 'POST' && url.pathname === '/api/cases') {
        if (cases.size >= 100) throw failure(429, 'Demo capacity reached. Restart the local server.');
        const record = createCase(validateInput(await readBody(req)));
        cases.set(record.id, { owner: sessionId, record, revision: 0 });
        return send(201, record);
      }
      const match = url.pathname.match(/^\/api\/cases\/([^/]+)(?:\/(.*))?$/);
      const entry = match && cases.get(match[1]);
      if (!entry || entry.owner !== sessionId) throw failure(404, 'Case not found.');
      const action = match[2];
      if (req.method === 'GET' && !action) return send(200, entry.record);
      const runAction = action?.match(/^orchestration\/([^/]+)(?:\/(cancel|resume|call-attempt))?$/);
      if (runAction) {
        const owned = runOwners.get(runAction[1]);
        if (!owned || owned.caseId !== entry.record.id || owned.owner !== sessionId) throw failure(404, 'Run not found.');
        const engine = engines[owned.mode];
        if (req.method === 'GET' && !runAction[2]) return send(200, await engine.getRun(runAction[1]));
        if (req.method !== 'POST' || !runAction[2]) throw failure(405, 'Method not supported.');
        if (runAction[2] === 'cancel') return send(200, await engine.cancel(runAction[1]));
        if (runAction[2] === 'resume') {
          if (!entry.record.input.consent) throw failure(403, 'Consent has been revoked.');
          return send(202, await engine.resume(runAction[1]));
        }
        const value = await readBody(req);
        if (typeof value.shareContext !== 'boolean') throw failure(400, 'Context-sharing permission must be explicit.');
        return send(200, await engine.recordCallAttempt(runAction[1], { shareContext: value.shareContext }));
      }
      if (req.method !== 'POST') throw failure(405, 'Method not supported.');
      if (action === 'revoke-consent') {
        entry.record = revokeConsent(entry.record);
        entry.revision += 1;
        await Promise.all([...runOwners.entries()].filter(([, owned]) => owned.caseId === entry.record.id).map(([id, owned]) => engines[owned.mode].revoke(id)));
        return send(200, entry.record);
      }
      if (action === 'orchestration') {
        if (locks.has(entry.record.id)) throw failure(409, 'A case update is already running.');
        locks.add(entry.record.id);
        try {
        const value = await readBody(req);
        const mode = value.mode ?? 'live';
        if (!['live', 'fixture'].includes(mode) || typeof value.modelConsent !== 'boolean') throw failure(400, 'Choose live or fixture and explicit model consent.');
        if (!entry.record.input.consent) throw failure(403, 'Recorded processing consent is required.');
        if ([...runOwners.values()].filter(owned => owned.caseId === entry.record.id).length >= 10) throw failure(429, 'Run limit reached for this case.');
        const revision = entry.revision;
        const packet = entry.record.policies.length ? entry.record : await runCase(entry.record);
        if (revision !== entry.revision) throw failure(409, 'Consent changed.');
        const run = await engines[mode].createRun(packet, { mode, modelConsent: value.modelConsent });
        runOwners.set(run.id, { owner: sessionId, caseId: entry.record.id, mode });
        if (revision !== entry.revision || !entry.record.input.consent || !sessions.has(sessionId)) {
          await engines[mode].revoke(run.id); throw failure(409, 'Consent changed. The queued run was revoked.');
        }
        await engines[mode].start(run.id);
        if (revision !== entry.revision || !entry.record.input.consent || !sessions.has(sessionId)) {
          await engines[mode].revoke(run.id); throw failure(409, 'Consent changed. The run was revoked.');
        }
        const snapshot = await engines[mode].getRun(run.id);
        if (revision !== entry.revision || !entry.record.input.consent) {
          await engines[mode].revoke(run.id); throw failure(409, 'Consent changed. The run was revoked.');
        }
        return send(202, snapshot);
        } finally { locks.delete(entry.record.id); }
      }
      if (locks.has(entry.record.id)) throw failure(409, 'A case update is already running.');
      const revision = entry.revision;
      locks.add(entry.record.id);
      try {
        let updated;
        if (action === 'run') updated = await runCase(entry.record);
        else if (action === 'purchase/review') {
          const value = await readBody(req);
          if (!['buy', 'retain', 'defer'].includes(value.decision)) throw failure(400, 'Choose retain, defer or buy.');
          if (value.reason !== undefined && (typeof value.reason !== 'string' || value.reason.length > 2000)) throw failure(400, 'Check the review reason.');
          updated = reviewPurchase(entry.record, { decision: value.decision, reason: value.reason, householdApproved: value.householdApproved === true });
        } else if (action === 'payment') updated = simulatePayment(entry.record);
        else {
          const question = action?.match(/^questions\/([^/]+)\/(approve|reply)$/);
          if (!question) throw failure(404, 'Action not found.');
          if (question[2] === 'approve') updated = approveQuestion(entry.record, question[1]);
          else {
            const value = await readBody(req);
            if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 6000) throw failure(400, 'Enter a reply up to 6000 characters.');
            updated = recordReply(entry.record, question[1], value.text);
          }
        }
        // Revocation wins over a concurrent analysis result.
        if (entry.revision !== revision) throw failure(409, 'Consent changed. The stale result was discarded.');
        entry.record = updated;
        entry.revision += 1;
        return send(200, updated);
      } finally { locks.delete(entry.record.id); }
    } catch (error) {
      const result = publicError(error);
      send(result.status, result.body);
    }
  });
  if (ownsDatabase) server.once('close', () => database?.close());
  return server;
}
