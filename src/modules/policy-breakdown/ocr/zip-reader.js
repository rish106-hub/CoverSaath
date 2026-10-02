import { inflateRawSync } from 'node:zlib';

// Minimal, bounded ZIP reader for provider result archives (stored and deflate entries only).
// It reads the central directory, never trusts entry names as paths, and caps sizes.

export const ZIP_LIMITS = Object.freeze({ maxEntries: 2_000, maxEntryBytes: 50 * 1024 * 1024, maxTotalBytes: 200 * 1024 * 1024 });

export class ZipReadError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ZipReadError';
    this.code = 'ZIP_INVALID';
  }
}

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new ZipReadError('ZIP end of central directory not found.');
}

/** Returns Map<entryName, Buffer> for file entries. */
export function readZip(input) {
  const buffer = Buffer.from(input);
  if (buffer.length < 22) throw new ZipReadError('ZIP is too small.');
  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  let pointer = buffer.readUInt32LE(eocd + 16);
  if (entryCount > ZIP_LIMITS.maxEntries || pointer + directorySize > buffer.length) throw new ZipReadError('ZIP central directory is out of bounds.');
  const entries = new Map();
  let total = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(pointer) !== 0x02014b50) throw new ZipReadError('ZIP central directory entry is invalid.');
    const flags = buffer.readUInt16LE(pointer + 8);
    const method = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const uncompressedSize = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.subarray(pointer + 46, pointer + 46 + nameLength).toString('utf8');
    pointer += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    if (flags & 0x1) throw new ZipReadError('Encrypted ZIP entries are not supported.');
    if (uncompressedSize > ZIP_LIMITS.maxEntryBytes) throw new ZipReadError('ZIP entry exceeds the size limit.');
    total += uncompressedSize;
    if (total > ZIP_LIMITS.maxTotalBytes) throw new ZipReadError('ZIP content exceeds the total size limit.');
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new ZipReadError('ZIP local header is invalid.');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    if (compressed.length !== compressedSize) throw new ZipReadError('ZIP entry data is truncated.');
    let content;
    if (method === 0) content = Buffer.from(compressed);
    else if (method === 8) content = inflateRawSync(compressed, { maxOutputLength: ZIP_LIMITS.maxEntryBytes });
    else throw new ZipReadError(`ZIP compression method ${method} is not supported.`);
    if (content.length !== uncompressedSize) throw new ZipReadError('ZIP entry size mismatch.');
    entries.set(name.replaceAll('\\', '/'), content);
  }
  return entries;
}
