import { pathToFileURL } from 'node:url';
import { createApiServer } from './create-server.js';

export { createApiServer } from './create-server.js';

/**
 * SIGTERM drain: /ready turns 503 so the platform stops routing, the listener closes, idle keep-alive
 * sockets close now and busy ones after the grace period, then the database pool closes with the server.
 */
export function installGracefulShutdown(server, { graceMs, exit = code => process.exit(code), signals = ['SIGTERM', 'SIGINT'] } = {}) {
  let stopping = false;
  const stop = signal => {
    if (stopping) return;
    stopping = true;
    server.draining = true;
    console.log(JSON.stringify({ severity: 'NOTICE', message: 'shutdown started', signal }));
    const force = setTimeout(() => { server.closeAllConnections?.(); exit(0); }, graceMs);
    force.unref();
    server.close(() => { clearTimeout(force); exit(0); });
    server.closeIdleConnections?.();
  };
  for (const signal of signals) process.on(signal, () => stop(signal));
  return stop;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createApiServer();
  const { host, port, shutdownGraceMs } = server.httpConfig;
  server.listen(port, host, () => {
    console.log(JSON.stringify({ severity: 'INFO', message: `Knowvia API listening on http://${host}:${port}` }));
  });
  installGracefulShutdown(server, { graceMs: shutdownGraceMs });
}
