import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = resolve(projectRoot, 'src');
const violations = [];
const sourceFiles = [];
const kebabName = /^(?:index|[a-z0-9]+(?:-[a-z0-9]+)*)\.js$/;
const kebabDirectory = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (!kebabDirectory.test(entry.name)) violations.push(`${relative(projectRoot, path)}: directory must use lowercase kebab-case.`);
      await walk(path);
    } else if (extname(entry.name) === '.js') {
      if (!kebabName.test(entry.name)) violations.push(`${relative(projectRoot, path)}: source file must use lowercase kebab-case.`);
      sourceFiles.push(path);
    }
  }
}

const inside = (path, directory) => path === directory || path.startsWith(`${directory}${sep}`);
const topLevelArea = path => relative(sourceRoot, path).split(sep)[0];

await walk(sourceRoot);

for (const file of sourceFiles) {
  const text = await readFile(file, 'utf8');
  const imports = [...text.matchAll(/(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g)].map(match => match[1]);
  for (const specifier of imports) {
    if (!specifier.startsWith('.')) continue;
    const target = resolve(dirname(file), specifier);
    const sourceArea = topLevelArea(file);
    const targetArea = inside(target, sourceRoot) ? topLevelArea(target) : null;
    const location = relative(projectRoot, file);

    if (sourceArea === 'shared' && targetArea !== 'shared') {
      violations.push(`${location}: shared code cannot import ${specifier}.`);
    }
    if (sourceArea === 'integrations' && targetArea && targetArea !== 'integrations') {
      violations.push(`${location}: integration code cannot import ${specifier}.`);
    }
    if (sourceArea === 'agents' && ['adapters', 'backend', 'integrations', 'server', 'ui'].includes(targetArea)) {
      violations.push(`${location}: agent code cannot import ${specifier}.`);
    }
    if (sourceArea === 'backend' && ['adapters', 'server', 'ui'].includes(targetArea)) {
      violations.push(`${location}: backend code cannot import ${specifier}.`);
    }
    if (sourceArea === 'ui' && ['adapters', 'backend', 'integrations', 'server'].includes(targetArea)) {
      violations.push(`${location}: UI code cannot import ${specifier}.`);
    }
    if (sourceArea !== 'integrations' && targetArea === 'integrations' && !target.endsWith(`${sep}integrations${sep}index.js`)) {
      violations.push(`${location}: import integrations through src/integrations/index.js, not ${specifier}.`);
    }
  }
}

if (violations.length) {
  process.stderr.write(`Architecture boundary check failed:\n${violations.map(item => `- ${item}`).join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Architecture boundary check passed for ${sourceFiles.length} source files.\n`);
}
