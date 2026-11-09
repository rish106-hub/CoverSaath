// Offline converter: IDA export v2 JSON -> CoverSaath reference-import-v1 JSON (ADR 0021).
//   node scripts/reference-import-convert.mjs --in <export.json> --out <import.json> [--force]
// Validates the export, converts, runs the importer's own validator (no database), writes the file with mode 0600 and prints
// counts only. Never prints a quote, value, name or identifier. Refuses to overwrite without --force. No network, no database.
// Synthetic data unless the owner has recorded source rights (FOR LEGAL REVIEW).
import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertAndCheck } from './lib/ida-export-convert.mjs';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const fail = (code, message) => Object.assign(new Error(message), { code });

/** Reads, converts, checks and writes. Returns counts only. Exported for tests. */
export async function runConvert({ inPath, outPath, force = false }) {
  if (!inPath || !outPath) throw fail('IDA_EXPORT_USAGE', 'Need --in <export.json> and --out <import.json>.');
  if (resolve(inPath) === resolve(outPath)) throw fail('IDA_EXPORT_USAGE', '--in and --out must differ.');
  let exp;
  try {
    if ((await stat(inPath)).size > MAX_FILE_BYTES) throw new Error('too large');
    exp = JSON.parse(await readFile(inPath, 'utf8'));
  } catch {
    throw fail('IDA_EXPORT_UNREADABLE', 'Export file is not readable JSON within 8 MB.');
  }
  const { document, summary } = convertAndCheck(exp);
  try {
    // 'wx' fails if the file exists; --force replaces it. Mode 0600 is re-applied so a pre-existing file is tightened too.
    await writeFile(outPath, `${JSON.stringify(document, null, 2)}\n`, { flag: force ? 'w' : 'wx', mode: 0o600 });
    await chmod(outPath, 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') throw fail('IDA_EXPORT_OUTPUT_EXISTS', 'Output file exists; use --force to replace it.');
    throw fail('IDA_EXPORT_OUTPUT_FAILED', 'Output file could not be written.');
  }
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = { inPath: null, outPath: null, force: false };
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--in' || arg === '--out') {
      const value = args[++index];
      if (value === undefined || value.startsWith('--')) { process.stderr.write(`Option ${arg} needs a value.\n`); process.exit(2); }
      if (arg === '--in') options.inPath = value; else options.outPath = value;
    } else if (arg === '--force') options.force = true;
    else { process.stderr.write('Unknown option. Use --in, --out and --force.\n'); process.exit(2); }
  }
  try {
    process.stdout.write(`${JSON.stringify(await runConvert(options), null, 2)}\n`);
  } catch (error) {
    const code = typeof error?.code === 'string' && error.code.startsWith('IDA_EXPORT_') ? error.code : 'UNKNOWN';
    const detail = code === 'IDA_EXPORT_SELF_CHECK_FAILED' ? `: ${error.message}` : '';
    process.stderr.write(`Export conversion failed (${code})${detail}\n`);
    process.exitCode = code === 'IDA_EXPORT_USAGE' ? 2 : 1;
  }
}
