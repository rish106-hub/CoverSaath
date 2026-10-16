// Coded errors for the PostgreSQL layer. The code is a stable UPPER_SNAKE identifier and the
// message is client-safe: it never contains a connection string, SQL text or driver output.
export class PostgresDatabaseError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'PostgresDatabaseError';
    this.code = code;
  }
}
