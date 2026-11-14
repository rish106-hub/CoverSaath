// Live P0 journey driver (docs/runbooks/demo-journey.md steps 1-7) against a local API. Synthetic PDFs only.
// Prints statuses and coded errors; never prints tokens and writes nothing to disk. With --eval, also asks the
// 100 eval questions through chat v1 in the same process (scripts/live-run/eval-v1.mjs).
import { readFile } from 'node:fs/promises';
import { runEvalV1 } from './eval-v1.mjs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const here = '.local/live-run';
const BASE = 'http://127.0.0.1:8787'; // loopback only: the API refuses any other Host
const BOOT = process.env.LIVE_RUN_BOOTSTRAP_TOKEN; if (!BOOT) { console.error('Set LIVE_RUN_BOOTSTRAP_TOKEN.'); process.exit(2); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t0 = Date.now();
const log = (step, ...rest) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${step}`, ...rest);
let token;

async function call(path, { method = 'GET', body, headers = {}, raw } = {}) {
  const res = await fetch(BASE + path, {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(raw ? {} : body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const code = r => r.data?.error?.code ?? r.data?.code ?? '';
function must(r, ok, what) { if (!ok.includes(r.status)) { log(`FAIL ${what}`, r.status, code(r), JSON.stringify(r.data).slice(0, 400)); process.exit(1); } return r.data; }
async function poll(what, fn, done, { every = 2000, max = 300_000 } = {}) {
  const end = Date.now() + max; let last;
  while (Date.now() < end) { last = await fn(); if (done(last)) return last; await sleep(every); }
  log(`TIMEOUT ${what}`, JSON.stringify(last?.data ?? last).slice(0, 400)); process.exit(1);
}

// 1. household + case
let r = await fetch(BASE + '/api/v1/households', { method: 'POST', headers: { authorization: `Bearer ${BOOT}`, 'content-type': 'application/json' }, body: JSON.stringify({ displayName: 'Live run household', owner: { displayName: 'Synthetic Owner' } }) });
const hh = await r.json(); if (r.status !== 201) { log('FAIL household', r.status, JSON.stringify(hh)); process.exit(1); }
token = hh.session.token; const householdId = hh.household.id; const ownerId = hh.owner.id;
log('1 household', r.status);
const kase = must(await call('/api/v1/cases', { method: 'POST', body: { householdId, subjectMemberId: hh.ownerMember.id, triggerType: 'planned_care' } }), [201], 'case');
const caseId = kase.id ?? kase.case?.id; log('1 case', caseId ? 'ok' : 'no id');

// 2. consent + upload
const grant = must(await call('/api/v1/consents', { method: 'POST', body: { householdId, subjectAdultId: ownerId, purpose: 'document_processing', scopes: [
  { resourceType: 'document', action: 'collect', dataCategory: 'insurance_document' },
  { resourceType: 'case', resourceId: caseId, action: 'read', dataCategory: 'source_pack_metadata', recipient: ownerId }] } }), [201], 'upload consent');
const grantId = grant.id ?? grant.grant?.id;
const docs = {};
for (const [kind, file] of [['policy_schedule', 'zephyr-schedule.pdf'], ['policy_wording', 'zephyr-terms.pdf']]) {
  const bytes = await readFile(join(here, 'pdfs', file));
  const up = must(await call(`/api/v1/cases/${caseId}/documents`, { method: 'POST', raw: bytes, headers: { 'content-type': 'application/pdf', 'idempotency-key': randomUUID(), 'x-document-kind': kind, 'x-consent-grant-id': grantId, 'x-filename': file } }), [201], `upload ${kind}`);
  docs[kind] = up.document.id; log(`2 upload ${kind}`, up.document.status);
}

// 3. scan
await poll('scan', () => call(`/api/v1/cases/${caseId}/documents`), x => {
  const list = x.data?.documents ?? x.data?.data ?? [];
  return Object.values(docs).every(id => ['accepted', 'active'].includes(list.find(d => d.id === id)?.status));
});
log('3 scan', 'both accepted (clamd clean)');

// 4. OCR (live Sarvam)
for (const [kind, id] of Object.entries(docs)) {
  const g = must(await call('/api/v1/consents', { method: 'POST', body: { householdId, subjectAdultId: ownerId, grantedToActor: 'sarvam', purpose: 'document_processing', scopes: [{ resourceType: 'document', resourceId: id, action: 'derive', dataCategory: 'insurance_document', recipient: 'sarvam' }] } }), [201], `sarvam consent ${kind}`);
  const gid = g.id ?? g.grant?.id;
  const job = must(await call(`/api/v1/documents/${id}/ocr-jobs`, { method: 'POST', body: { consentGrantId: gid } }), [202, 200, 201], `ocr start ${kind}`);
  const done = await poll(`ocr ${kind}`, () => call(`/api/v1/ocr-jobs/${job.job.id}/refresh`, { method: 'POST', body: { consentGrantId: gid } }), x => ['succeeded', 'failed'].includes(x.data?.job?.status) || x.status >= 400, { every: 4000, max: 600_000 });
  log(`4 ocr ${kind}`, done.status, done.data?.job?.status, code(done), done.data?.job?.failureCode ?? '', JSON.stringify(done.data?.error ?? done.data?.job ?? {}).slice(0, 400));
  if (done.data?.job?.status !== 'succeeded') process.exit(1);
}

// 5. holdings, candidates, confirm
const holdings = await poll('holdings', () => call(`/api/v1/households/${householdId}/holdings`), x => (x.data?.holdings ?? []).some(h => h.documentId === docs.policy_schedule));
const list = holdings.data.holdings; log('5 holdings', list.length, list.map(h => h.status).join(','));
const holdingId = list.find(h => h.documentId === docs.policy_schedule).id;
const cands = await poll('candidates', () => call(`/api/v1/holdings/${holdingId}/product-candidates`), x => x.status === 200 || (x.status >= 400 && x.status !== 503), { every: 3000, max: 120_000 });
log('5 candidates', cands.status, code(cands), (cands.data?.candidates ?? []).map(c => c.candidateId).join(','));
if (cands.status === 200 && cands.data.candidates?.length) {
  const conf = must(await call(`/api/v1/holdings/${holdingId}/confirm-product`, { method: 'POST', headers: { 'idempotency-key': `confirm-${randomUUID()}` }, body: { candidateId: cands.data.candidates[0].candidateId, expectedVersion: cands.data.profileVersion } }), [200], 'confirm product');
  log('5 confirm', conf.status ?? 'ok');
}

// 6. link wording
must(await call(`/api/v1/holdings/${holdingId}/documents`, { method: 'POST', body: { documentId: docs.policy_wording, kind: 'wording' } }), [200, 201], 'link wording');
log('6 link wording', 'ok');
await sleep(15000);
const after = await call(`/api/v1/households/${householdId}/holdings`);
log('6 holdings after link', (after.data?.holdings ?? []).length, JSON.stringify(after.data?.holdings?.[0]?.summary ?? {}).slice(0, 300));

// 7. facts + chat
const facts = await poll('facts', () => call(`/api/v1/holdings/${holdingId}/facts`), x => (x.data?.facts ?? []).length > 0 || x.status >= 400, { every: 4000, max: 180_000 });
must(facts, [200], 'facts');
const fl = facts.data.facts;
log('7 facts', facts?.status, fl.length, fl.slice(0, 40).map(f => `${f.factKey ?? f.key}=${JSON.stringify(f.value).slice(0, 40)}[${f.status ?? f.state ?? ''}]`).join(' | '));
const conflicts = await call(`/api/v1/holdings/${holdingId}/conflicts`);
log('7 conflicts', conflicts.status, (conflicts.data?.conflicts ?? []).length);
const thread = must(await call('/api/v1/chat/threads', { method: 'POST', body: { household_id: householdId, holding_id: holdingId } }), [201], 'thread');
const threadId = thread.thread.id;
const questions = ['How long is the waiting period for pre-existing diseases?', 'What is my sum insured?', 'Is cosmetic surgery covered?', 'What is the room rent limit?', 'What is the co-payment?', 'Does the policy cover space travel injuries?'];
for (const q of questions) {
  const res = await fetch(`${BASE}/api/v1/chat/threads/${threadId}/turns`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ message: q }) });
  const text = await res.text();
  const events = text.split('\n\n').map(b => ({ ev: /event: (.*)/.exec(b)?.[1], data: /data: (.*)/s.exec(b)?.[1] })).filter(e => e.ev);
  const ans = events.find(e => e.ev === 'answer');
  if (!res.ok || !ans) { log(`FAIL chat "${q}"`, res.status, events.find(e => e.ev === 'error')?.data?.slice(0, 200) ?? ''); process.exit(1); }
  let a = {}; try { a = JSON.parse(ans.data); } catch { log('FAIL chat answer not JSON'); process.exit(1); }
  log(`7 chat "${q}"`, res.status, a.status ?? '', '→', String(a.answer ?? a.text ?? '').slice(0, 220), '| sources:', JSON.stringify(a.sources ?? []).slice(0, 160), '| model:', a.model?.status ?? a.modelStatus ?? '');
}
if (process.argv.includes('--eval')) {
  const set = JSON.parse(await readFile('scripts/fixtures/synthetic-policy-questions.json', 'utf8'));
  await runEvalV1({ base: BASE, token, householdId, holdingId, documentKinds: { [docs.policy_schedule]: 'schedule', [docs.policy_wording]: 'terms' }, questions: set.questions });
}
log('done');
