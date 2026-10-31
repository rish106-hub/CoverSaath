import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { testTempRoot as tmpdir } from './support/temp-root.mjs';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { createApiServer } from '../src/server/server.js';

const bootstrapToken = 'coversaath-test-bootstrap-token-0003';

function syntheticPdf(marker = randomUUID()) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>'];
  let body = `%PDF-1.7\n% synthetic ${marker}\n`;
  const offsets = [];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

test('member_card is an accepted upload kind; other kinds stay refused', postgresTestOptions(), async t => {
  const directory = mkdtempSync(join(tmpdir(), 'coversaath-card-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { db } = await freshDatabase(t);
  const server = createApiServer({ database: db, env: {
    KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken,
    DOCUMENT_STORAGE_PATH: join(directory, 'documents'),
    DOCUMENT_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64'),
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = async (path, token, body) => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const identity = await json('/api/v1/households', bootstrapToken, { displayName: 'Synthetic household', owner: { displayName: 'Synthetic owner' } });
  const token = identity.data.session.token;
  const householdId = identity.data.household.id;
  const adultId = identity.data.owner.id;
  const created = await json('/api/v1/cases', token, { householdId, subjectMemberId: identity.data.ownerMember.id, triggerType: 'planned_care' });
  const caseId = created.data.id;
  const grant = await json('/api/v1/consents', token, { householdId, subjectAdultId: adultId, purpose: 'document_processing', scopes: [
    { resourceType: 'document', action: 'collect', dataCategory: 'insurance_document' },
    { resourceType: 'case', resourceId: caseId, action: 'read', dataCategory: 'source_pack_metadata', recipient: adultId },
  ] });
  const upload = async kind => {
    const response = await fetch(`${base}/api/v1/cases/${caseId}/documents`, { method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/pdf', 'Idempotency-Key': randomUUID(),
      'X-Document-Kind': kind, 'X-Consent-Grant-Id': grant.data.id, 'X-Filename': encodeURIComponent('synthetic-card.pdf'),
    }, body: syntheticPdf() });
    return { status: response.status, data: await response.json() };
  };
  const card = await upload('member_card');
  assert.equal(card.status, 201, JSON.stringify(card.data));
  assert.equal(card.data.document.documentKind ?? card.data.document.kind, 'member_card');
  const refused = await upload('medical_record');
  assert.equal(refused.status, 400);
  assert.equal(refused.data.error.code, 'UNSUPPORTED_DOCUMENT_KIND');
});
