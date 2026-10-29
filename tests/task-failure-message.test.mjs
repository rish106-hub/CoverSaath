// v9 review item 12: a failed task stores a static message, never the thrown error's text. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { postgresTestOptions } from './support/pg.mjs';
import { setupLiveCase, startLiveServer } from './support/live-analysis-scenario.mjs';

test('a thrown task error is stored with a static message, not its own text', postgresTestOptions(), async t => {
  const probe = 'asha.synthetic@example.test';
  const app = await startLiveServer(t, { onGenerate: () => { throw new Error(`provider echoed ${probe} and 9876543210`); } });
  const scenario = await setupLiveCase(app, { pageText: 'Synthetic schedule: room rent limit is 5000.' });
  await scenario.startLiveRun('task-failure-message');
  const failed = await app.database.prepare("SELECT last_error_code, last_error_message FROM workflow_tasks WHERE status = 'failed'").all();
  assert.ok(failed.length > 0, 'the stub forces model tasks to fail');
  const body = JSON.stringify({
    tasks: await app.database.prepare('SELECT last_error_code, last_error_message, output_json FROM workflow_tasks').all(),
    audit: await app.database.prepare('SELECT event_payload_json FROM audit_events').all(),
  });
  assert.ok(!body.includes(probe) && !body.includes('9876543210'), 'the error text must not be persisted');
  assert.ok(failed.every(task => task.last_error_message === 'Analysis task failed.'), JSON.stringify(failed));
});
