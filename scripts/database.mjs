import { openDatabase, validateSchema } from '../src/backend/database/index.js';

const path = process.env.DATABASE_PATH || '.local/coversaath.sqlite';
const database = openDatabase({ path });

try {
  const schema = validateSchema(database);
  process.stdout.write(`${JSON.stringify({ path, ...schema }, null, 2)}\n`);
} finally {
  database.close();
}
