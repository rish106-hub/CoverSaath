import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Local development only: one process, bounded runs, no encryption or tenant auth.
// Each acknowledged put is an atomic rename; interrupted writes leave harmless temp files.
export function createDiskStore({ directory = '.local/runs', maxRuns = 100, maxBytes = 2_000_000 } = {}) {
  const root = resolve(directory);
  let writes = Promise.resolve();
  const valid = id => { if (!/^run-[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid run id.'); return join(root, `${id}.json`); };
  const list = async () => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    return (await readdir(root)).filter(name => /^run-[a-f0-9-]{36}\.json$/.test(name)).map(name => name.slice(0, -5));
  };
  return {
    limits: { directory: root, maxRuns, maxBytes, singleProcessOnly: true, encrypted: false },
    list,
    async get(id) { try { return JSON.parse(await readFile(valid(id), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } },
    put(record) {
      const data = JSON.stringify(record);
      if (Buffer.byteLength(data) > maxBytes) return Promise.reject(new Error('Local run snapshot size limit exceeded.'));
      const path = valid(record.id);
      const operation = writes.catch(() => {}).then(async () => {
        await mkdir(root, { recursive: true, mode: 0o700 });
        const ids = await list();
        if (!ids.includes(record.id) && ids.length >= maxRuns) throw new Error('Local run count limit exceeded.');
        const temporary = join(root, `.write-${randomUUID()}.tmp`);
        await writeFile(temporary, data, { mode: 0o600, flag: 'wx' });
        await rename(temporary, path);
      });
      writes = operation;
      return operation;
    }
  };
}

export function createMemoryStore() {
  const records = new Map();
  return { async list() { return [...records.keys()]; }, async get(id) { return records.has(id) ? structuredClone(records.get(id)) : null; }, async put(record) { records.set(record.id, structuredClone(record)); } };
}
