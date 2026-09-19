// Observe public task states only. No prompts or private reasoning are printed.
const fixture = process.argv.includes('--fixture');
const baseArg = process.argv.find(arg => arg.startsWith('--base='));
const base = baseArg?.slice(7) || 'http://127.0.0.1:8787';
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base)) throw new Error('Use a local API URL.');
let cookie;
async function request(path, body) {
  const response = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  cookie ||= response.headers.get('set-cookie')?.split(';')[0];
  if (!response.ok) throw new Error(data.error || `API ${response.status}`);
  return data;
}
try {
  console.log(`Mode: ${fixture ? 'EXPLICIT FIXTURE: no provider calls' : 'LIVE: provider calls require a configured key'}`);
  const record = await request('/api/cases', { trigger: 'planned_care', patientName: 'Synthetic adult', procedure: 'Synthetic procedure', hospital: 'Synthetic hospital', estimate: 500000, consent: true });
  const path = `/api/cases/${record.id}/orchestration`;
  const run = await request(path, { mode: fixture ? 'fixture' : 'live', modelConsent: !fixture });
  const seen = new Map();
  let eventCount = 0;
  const terminal = new Set(['completed', 'flagged', 'blocked', 'failed', 'interrupted', 'cancelled', 'revoked']);
  const deadline = Date.now() + 120000;
  let snapshot = run;
  while (true) {
    for (const event of (snapshot.events || []).slice(eventCount)) {
      if (['task_started', 'task_completed', 'task_failed', 'deterministic_gate', 'release_gate'].includes(event.type)) console.log(`${event.at} ${event.role || 'gate'}: ${event.type}`);
    }
    eventCount = snapshot.events?.length || 0;
    for (const [role, task] of Object.entries(snapshot.tasks || {})) if (seen.get(role) !== task.status) {
      console.log(`${role}: ${task.status}${task.provider ? ` (${task.provider}/${task.model})` : ''}`);
      seen.set(role, task.status);
    }
    if (terminal.has(snapshot.status)) {
      console.log(`Run: ${snapshot.status}. Release: ${snapshot.release?.status}. Estimated cost: ${snapshot.budget?.estimatedCostUsd ?? 'unknown'} USD (not verified billing).`);
      if (['failed', 'blocked'].includes(snapshot.status)) process.exitCode = 1;
      break;
    }
    if (Date.now() > deadline) {
      await request(`${path}/${run.id}/cancel`, {});
      throw new Error('Observation timed out. Run cancelled.');
    }
    await new Promise(resolve => setTimeout(resolve, 200));
    snapshot = await request(`${path}/${run.id}`);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
