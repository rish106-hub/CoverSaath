// Review finding F1 (Section 2): driver and runtime errors never reach clients verbatim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { readBody } from '../src/shared/http/index.js';
import { errorResponse } from '../src/server/routes/v1-backend-routes.js';

test('a real node:sqlite constraint error is returned as a generic coded body', () => {
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE secret_tbl (email TEXT UNIQUE)');
  database.prepare('INSERT INTO secret_tbl VALUES (?)').run('probe@example.test');
  let thrown;
  try { database.prepare('INSERT INTO secret_tbl VALUES (?)').run('probe@example.test'); } catch (error) { thrown = error; }
  database.close();
  const response = errorResponse(thrown);
  const body = JSON.stringify(response.body);
  assert.equal(response.body.error.code, 'BACKEND_REQUEST_FAILED');
  assert.ok(!/secret_tbl|UNIQUE|email|probe@example\.test|SQLITE/i.test(body), body);
});

test('Node ERR_* and uncoded errors are hidden; application codes keep their message', () => {
  const nodeError = Object.assign(new TypeError('The "x" argument received 4111111111111111'), { code: 'ERR_INVALID_ARG_TYPE' });
  assert.equal(errorResponse(nodeError).body.error.message, 'The request could not be completed.');
  assert.equal(errorResponse(new Error('internal detail')).body.error.code, 'BACKEND_REQUEST_FAILED');
  const app = Object.assign(new Error('Idempotency key was reused with a different request.'), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.deepEqual(errorResponse(app), { status: 409, body: { error: { code: 'IDEMPOTENCY_CONFLICT', message: app.message } } });
});

test('operating-system errors are hidden, including their file paths', () => {
  let thrown;
  try { readFileSync('/nonexistent-coversaath-probe/secret-household.json'); } catch (error) { thrown = error; }
  assert.equal(thrown.code, 'ENOENT');
  const response = errorResponse(thrown);
  assert.equal(response.body.error.code, 'BACKEND_REQUEST_FAILED');
  assert.ok(!/ENOENT|secret-household|nonexistent/.test(JSON.stringify(response.body)));
  const errnoOnly = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { code: 'SOCKET_REFUSED', errno: -61 });
  assert.equal(errorResponse(errnoOnly).body.error.code, 'BACKEND_REQUEST_FAILED');
});

const request = (contentType, body) => Object.assign(Readable.from(body === undefined ? [] : [body]), { headers: contentType ? { 'content-type': contentType } : {} });
async function readBodyFailure(req, options) {
  try { await readBody(req, options); } catch (error) { return errorResponse(error); }
  assert.fail('readBody should have refused the request');
}

test('request body errors keep their status, a stable code and their message', async () => {
  assert.deepEqual(await readBodyFailure(request('text/plain', 'x')), { status: 415, body: { error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Use JSON.' } } });
  assert.deepEqual(await readBodyFailure(request('application/json', 'x'.repeat(40)), { limitBytes: 16 }), { status: 413, body: { error: { code: 'REQUEST_TOO_LARGE', message: 'Request is too large.' } } });
  assert.deepEqual(await readBodyFailure(request('application/json', '{not json')), { status: 400, body: { error: { code: 'INVALID_JSON_BODY', message: 'Provide a JSON object.' } } });
  assert.deepEqual(await readBodyFailure(request('application/json', '[1]')), { status: 400, body: { error: { code: 'INVALID_JSON_BODY', message: 'Provide a JSON object.' } } });
});
