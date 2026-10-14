// Review finding F1 (Section 2): driver and runtime errors never reach clients verbatim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
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
