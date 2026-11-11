// Holdings and memory (ADR 0032): every new behaviour is off unless HOLDINGS_ENABLED is exactly "true".
export const holdingsEnabled = (env = process.env) => env.HOLDINGS_ENABLED === 'true';
