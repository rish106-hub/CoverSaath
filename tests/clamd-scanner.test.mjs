import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createClamdScanner } from '../src/features/input/clamd-scanner.js';

// Fake clamd: parses real INSTREAM framing and records received bytes.
async function startFakeClamd({ reply = 'stream: OK', onStream, silent = false, closeEarly = false } = {}) {
  const received = [];
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    let command = null;
    let payload = [];
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (command === null) {
        const nul = buffer.indexOf(0);
        if (nul < 0) return;
        command = buffer.subarray(0, nul).toString('latin1');
        buffer = buffer.subarray(nul + 1);
        if (command === 'zPING') {
          if (!silent) socket.end(`${typeof reply === 'string' && reply === 'PONG' ? 'PONG' : 'PONG'}\0`);
          return;
        }
        if (closeEarly) { socket.destroy(); return; }
      }
      if (command !== 'zINSTREAM') return;
      for (;;) {
        if (buffer.length < 4) return;
        const length = buffer.readUInt32BE(0);
        if (length === 0) {
          received.push(Buffer.concat(payload));
          onStream?.(socket);
          if (!silent) socket.write(Buffer.concat([Buffer.from(reply, 'latin1'), Buffer.from([0])]));
          return;
        }
        if (buffer.length < 4 + length) return;
        payload.push(buffer.subarray(4, 4 + length));
        buffer = buffer.subarray(4 + length);
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    received,
    sockets,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

async function withFake(options, run) {
  const fake = await startFakeClamd(options);
  try { await run(fake); } finally { await fake.close(); }
}

const scannerFor = (fake, extra = {}) => createClamdScanner({ host: '127.0.0.1', port: fake.port, timeoutMs: 2000, ...extra });
const synthetic = length => Buffer.from(Array.from({ length }, (_, i) => (i * 7 + 3) % 256));
const EICAR = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');

test('clean reply returns clean and the server receives exact bytes', async () => {
  await withFake({}, async fake => {
    const result = await scannerFor(fake).scan(EICAR);
    assert.deepEqual(result, { status: 'clean' });
    assert.ok(Object.isFrozen(result));
    assert.deepEqual(fake.received[0], EICAR);
  });
});

test('multi-chunk input is framed correctly and reassembled', async () => {
  await withFake({}, async fake => {
    const input = synthetic(10_007);
    await scannerFor(fake, { chunkBytes: 1000 }).scan(input);
    assert.ok(input.equals(fake.received[0]));
  });
});

test('empty input is accepted', async () => {
  await withFake({}, async fake => {
    assert.deepEqual(await scannerFor(fake).scan(Buffer.alloc(0)), { status: 'clean' });
    assert.equal(fake.received[0].length, 0);
  });
});

test('large input respects backpressure and arrives intact', async () => {
  await withFake({}, async fake => {
    const input = synthetic(5 * 1024 * 1024);
    await scannerFor(fake, { timeoutMs: 20_000 }).scan(input);
    assert.ok(input.equals(fake.received[0]));
  });
});

test('FOUND reply is blocked with a sanitised signature', async () => {
  await withFake({ reply: 'stream: Win.Test.EICAR_HDB-1 FOUND' }, async fake => {
    assert.deepEqual(await scannerFor(fake).scan(EICAR), { status: 'blocked', signature: 'Win.Test.EICAR_HDB-1' });
  });
  await withFake({ reply: 'stream: Bad<script>"sig"; rm -rf /.X FOUND' }, async fake => {
    const result = await scannerFor(fake).scan(EICAR);
    assert.equal(result.status, 'blocked');
    assert.match(result.signature, /^[A-Za-z0-9._:-]+$/);
    assert.doesNotMatch(result.signature, /[<>"; ]/);
  });
  await withFake({ reply: `stream: ${'A'.repeat(300)} FOUND` }, async fake => {
    assert.equal((await scannerFor(fake).scan(EICAR)).signature.length, 100);
  });
});

test('ERROR and size-limit replies map to non-retryable SCANNER_ERROR', async () => {
  for (const reply of ['stream: Something broke ERROR', 'INSTREAM size limit exceeded. ERROR']) {
    await withFake({ reply }, async fake => {
      await assert.rejects(scannerFor(fake).scan(EICAR), error => {
        assert.equal(error.code, 'SCANNER_ERROR');
        assert.equal(error.retryable, false);
        assert.doesNotMatch(error.message, /size limit|broke/);
        return true;
      });
    });
  }
});

test('garbage and over-long replies map to SCANNER_ERROR', async () => {
  await withFake({ reply: 'hello world' }, async fake => {
    await assert.rejects(scannerFor(fake).scan(EICAR), { code: 'SCANNER_ERROR', retryable: false });
  });
  await withFake({ reply: 'stream: ' + 'A'.repeat(2000) + ' FOUND' }, async fake => {
    await assert.rejects(scannerFor(fake).scan(EICAR), error => {
      assert.equal(error.code, 'SCANNER_ERROR');
      assert.doesNotMatch(error.message, /AAAA/);
      return true;
    });
  });
});

test('connection refused is retryable SCANNER_UNAVAILABLE', async () => {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  const scanner = createClamdScanner({ host: '127.0.0.1', port, timeoutMs: 2000 });
  await assert.rejects(scanner.scan(EICAR), { code: 'SCANNER_UNAVAILABLE', retryable: true });
});

test('a server that never replies times out and the socket is destroyed', async () => {
  await withFake({ silent: true }, async fake => {
    let socket;
    const scanner = createClamdScanner({
      host: '127.0.0.1',
      port: fake.port,
      timeoutMs: 100,
      connect: options => (socket = net.createConnection(options)),
    });
    await assert.rejects(scanner.scan(EICAR), { code: 'SCANNER_UNAVAILABLE', retryable: true });
    assert.equal(socket.destroyed, true);
  });
});

test('readiness ping is bounded even when the scan timeout is long', async () => {
  await withFake({ silent: true }, async fake => {
    const scanner = scannerFor(fake, { timeoutMs: 10_000 });
    const started = Date.now();
    assert.equal(await scanner.ping(), false);
    assert.ok(Date.now() - started < 3_000, 'readiness ping should not wait for the full scan timeout');
  });
});

test('server closing early is SCANNER_UNAVAILABLE', async () => {
  await withFake({ closeEarly: true }, async fake => {
    await assert.rejects(scannerFor(fake).scan(EICAR), { code: 'SCANNER_UNAVAILABLE', retryable: true });
  });
});

test('socket is destroyed after success and after error replies', async () => {
  for (const reply of ['stream: OK', 'stream: x ERROR']) {
    await withFake({ reply }, async fake => {
      let socket;
      const scanner = createClamdScanner({
        host: '127.0.0.1',
        port: fake.port,
        timeoutMs: 2000,
        connect: options => (socket = net.createConnection(options)),
      });
      await scanner.scan(EICAR).catch(() => {});
      assert.equal(socket.destroyed, true);
    });
  }
});

test('invalid scanner input is refused without connecting', async () => {
  let connected = false;
  const scanner = createClamdScanner({
    host: '127.0.0.1',
    port: 3310,
    maxBytes: 16,
    connect: () => { connected = true; throw new Error('should not connect'); },
  });
  await assert.rejects(scanner.scan(Buffer.alloc(17)), { code: 'SCANNER_INPUT_INVALID', retryable: false });
  await assert.rejects(scanner.scan('not a buffer'), { code: 'SCANNER_INPUT_INVALID' });
  await assert.rejects(scanner.scan(new Uint8Array(4)), { code: 'SCANNER_INPUT_INVALID' });
  assert.equal(connected, false);
});

test('ping returns true for PONG and false for every failure, never throwing', async () => {
  await withFake({}, async fake => {
    assert.equal(await scannerFor(fake).ping(), true);
  });
  await withFake({ silent: true }, async fake => {
    assert.equal(await scannerFor(fake, { timeoutMs: 100 }).ping(), false);
  });
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  assert.equal(await createClamdScanner({ host: '127.0.0.1', port, timeoutMs: 500 }).ping(), false);
  const throwing = createClamdScanner({ host: '127.0.0.1', port: 1, connect: () => { throw new Error('boom'); } });
  assert.equal(await throwing.ping(), false);
});

test('construction validates options', () => {
  const bad = [
    {},
    { host: '', port: 1 },
    { host: 'http://clamd', port: 3310 },
    { host: 'clamd/path', port: 3310 },
    { host: 5, port: 3310 },
    { host: 'h', port: 0 },
    { host: 'h', port: 65536 },
    { host: 'h', port: 1.5 },
    { host: 'h', port: 1, timeoutMs: 0 },
    { host: 'h', port: 1, timeoutMs: 300_001 },
    { host: 'h', port: 1, chunkBytes: 0 },
    { host: 'h', port: 1, chunkBytes: 1024 * 1024 + 1 },
  ];
  for (const options of bad) assert.throws(() => createClamdScanner(options), TypeError);
  const scanner = createClamdScanner({ host: 'clamd.internal', port: 3310 });
  assert.equal(scanner.mode, 'clamd');
  assert.ok(Object.isFrozen(scanner));
});
