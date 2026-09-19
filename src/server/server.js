import { pathToFileURL } from 'node:url';
import { createApiServer } from './create-server.js';

export { createApiServer } from './create-server.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createApiServer().listen(8787, '127.0.0.1', () => {
    console.log('CoverSaath demo API: http://127.0.0.1:8787');
  });
}
