import net from 'node:net';
import { DocumentIntakeError } from './contracts.js';

const MAX_REPLY_BYTES = 1024;
const MAX_SIGNATURE_CHARS = 100;

function scannerError(code, message) {
  const error = new DocumentIntakeError(code, message);
  error.retryable = code === 'SCANNER_UNAVAILABLE';
  return error;
}

const integerIn = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

function validateOptions({ host, port, timeoutMs, chunkBytes, maxBytes, connect }) {
  if (typeof host !== 'string' || host.length === 0 || host.length > 255 || /[\s/\\@?#]/.test(host) || host.includes('://')) {
    throw new TypeError('clamd host must be a non-empty hostname or address, not a URL.');
  }
  if (!integerIn(port, 1, 65535)) throw new TypeError('clamd port must be an integer from 1 to 65535.');
  if (!integerIn(timeoutMs, 1, 300_000)) throw new TypeError('clamd timeoutMs must be an integer from 1 to 300000.');
  if (!integerIn(chunkBytes, 1, 1024 * 1024)) throw new TypeError('clamd chunkBytes must be an integer from 1 to 1048576.');
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new TypeError('clamd maxBytes must be a positive integer.');
  if (typeof connect !== 'function') throw new TypeError('clamd connect must be a function.');
}

function sanitizeSignature(raw) {
  return raw.replace(/[^A-Za-z0-9._:-]/g, '').slice(0, MAX_SIGNATURE_CHARS);
}

function parseScanReply(reply) {
  const text = reply.trim();
  if (text.includes('ERROR')) throw scannerError('SCANNER_ERROR', 'Malware scanner reported an error.');
  if (text === 'stream: OK') return Object.freeze({ status: 'clean' });
  const found = /^stream: (.+) FOUND$/.exec(text);
  if (found) {
    const signature = sanitizeSignature(found[1]);
    if (signature) return Object.freeze({ status: 'blocked', signature });
  }
  throw scannerError('SCANNER_ERROR', 'Malware scanner returned an unrecognised reply.');
}

export function createClamdScanner({
  host,
  port,
  timeoutMs = 30_000,
  chunkBytes = 64 * 1024,
  maxBytes = 15 * 1024 * 1024,
  connect = net.createConnection,
} = {}) {
  validateOptions({ host, port, timeoutMs, chunkBytes, maxBytes, connect });

  // One connection, one overall deadline, socket always destroyed. Resolves with the NUL-terminated reply.
  function exchange(write, deadlineMs = timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let socket;
      let received = Buffer.alloc(0);
      let drainResolve = null;

      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { socket?.destroy(); } catch { /* already gone */ }
        if (drainResolve) drainResolve();
        if (error) reject(error); else resolve(value);
      };
      const unavailable = () => finish(scannerError('SCANNER_UNAVAILABLE', 'Malware scanner is unavailable.'));
      const timer = setTimeout(unavailable, deadlineMs);

      try {
        socket = connect({ host, port });
      } catch {
        unavailable();
        return;
      }
      socket.on('error', unavailable);
      socket.on('close', unavailable);
      socket.on('end', unavailable);
      socket.on('data', chunk => {
        if (settled) return;
        received = Buffer.concat([received, chunk]);
        const nul = received.indexOf(0);
        if (nul >= 0 && nul <= MAX_REPLY_BYTES) finish(null, received.subarray(0, nul).toString('latin1'));
        else if (nul >= 0 || received.length > MAX_REPLY_BYTES) finish(scannerError('SCANNER_ERROR', 'Malware scanner reply was too long.'));
      });

      const send = buffer => {
        if (settled) return Promise.resolve();
        if (socket.write(buffer)) return Promise.resolve();
        return new Promise(resolveDrain => {
          drainResolve = () => { drainResolve = null; resolveDrain(); };
          socket.once('drain', () => drainResolve?.());
        });
      };
      Promise.resolve().then(() => write(send, () => settled)).catch(unavailable);
    });
  }

  async function scan(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length > maxBytes) {
      throw scannerError('SCANNER_INPUT_INVALID', 'Scanner input must be a Buffer within the size limit.');
    }
    const reply = await exchange(async (send, isDone) => {
      await send(Buffer.from('zINSTREAM\0', 'latin1'));
      for (let offset = 0; offset < bytes.length && !isDone(); offset += chunkBytes) {
        const chunk = bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.length));
        const header = Buffer.alloc(4);
        header.writeUInt32BE(chunk.length);
        await send(Buffer.concat([header, chunk]));
      }
      await send(Buffer.alloc(4));
    });
    return parseScanReply(reply);
  }

  async function ping() {
    try {
      // Readiness checks must be bounded even when the configured scan timeout is long.
      const reply = await exchange(send => send(Buffer.from('zPING\0', 'latin1')), Math.min(timeoutMs, 2_000));
      return reply.trim() === 'PONG';
    } catch {
      return false;
    }
  }

  return Object.freeze({ mode: 'clamd', scan, ping });
}
