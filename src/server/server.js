import { pathToFileURL } from 'node:url';
import { createApiServer } from './create-server.js';

export { createApiServer } from './create-server.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Loopback by default. A container host sets HOST=0.0.0.0 (and PORT) so its proxy can reach it.
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid PORT.');
  createApiServer().listen(port, host, () => {
    console.log(`Knowvia API: http://${host}:${port}`);
  });
}
