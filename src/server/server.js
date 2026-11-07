import { pathToFileURL } from 'node:url';
import { createApiServer } from './create-server.js';
import { createLogger, initSentry, silentLogger } from '../shared/logging/index.js';
import { ANALYSIS_ERROR_CODES } from '../contracts/error-codes.js';

export { createApiServer } from './create-server.js';

async function main() {
  // Built first so even a failure to build the real logger (an invalid LOG_LEVEL) is reported through a safe path below.
  let logger = silentLogger;
  let errorReporter = { enabled: false, captureError() {}, async flush() {} };
  // Startup failures log the error class, its code and (for "Invalid NAME.") the setting name, never the message, and exit 1.
  const failStartup = error => {
    try { createLogger({ level: 'fatal' }).failure(error, { event: 'startup_failed', status: 500, level: 'fatal' }); } catch { /* nothing safer to do */ }
    process.exit(1);
  };
  try {
    // Loopback by default. A container host sets HOST=0.0.0.0 (and PORT) so its proxy can reach it.
    const host = process.env.HOST || '127.0.0.1';
    const port = Number(process.env.PORT || 8787);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid PORT.');
    logger = createLogger();
    // Error reporting is off unless SENTRY_DSN is set (ADR 0016).
    errorReporter = await initSentry({ knownCodes: Object.keys(ANALYSIS_ERROR_CODES) });
    // Fatal errors are logged and reported as class, code and top frames only: Node's default handler would print the
    // message, which can hold a value. The process exits at once when nothing needs flushing, else after at most 2 s.
    let exiting = false;
    const fatal = event => error => {
      if (exiting) return;
      exiting = true;
      logger.failure(error, { event, status: 500, level: 'fatal' });
      if (!errorReporter.enabled) process.exit(1);
      errorReporter.captureError(error);
      const deadline = new Promise(resolve => setTimeout(resolve, 2_000));
      Promise.race([errorReporter.flush(2_000), deadline]).catch(() => {}).finally(() => process.exit(1));
    };
    process.on('uncaughtException', fatal('uncaught_exception'));
    process.on('unhandledRejection', fatal('unhandled_rejection'));
    createApiServer({ logger, errorReporter }).listen(port, host, () => {
      logger.info('server_listening', { host, port });
    });
  } catch (error) {
    failStartup(error);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
