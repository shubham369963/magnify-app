import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDirectory = resolve(serverDirectory, '..');

function filesUnder(directory, extensions) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(path, extensions);
    return extensions.some((extension) => path.endsWith(extension)) ? [path] : [];
  });
}

function readFiles(paths) {
  return paths.map((path) => readFileSync(path, 'utf8')).join('\n');
}

function envTemplateKeys(path) {
  return new Set(readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.match(/^([A-Z][A-Z0-9_]*)=/)?.[1])
    .filter(Boolean));
}

function referencedKeys(source, expression) {
  return new Set([...source.matchAll(expression)].map((match) => match[1]));
}

const serverSources = readFiles(filesUnder(join(serverDirectory, 'src'), ['.ts'])
  .filter((path) => !path.endsWith('.spec.ts')));
const composeSource = readFileSync(join(serverDirectory, 'docker-compose.yml'), 'utf8');
const serverReferences = referencedKeys(serverSources, /process\.env\.([A-Z][A-Z0-9_]*)/g);
for (const key of referencedKeys(serverSources, /(?:configuredTreeLimit|positiveIntegerFromEnvironment)\(\s*["']([A-Z][A-Z0-9_]*)/g)) {
  serverReferences.add(key);
}
for (const key of referencedKeys(composeSource, /\$\{([A-Z][A-Z0-9_]*)/g)) {
  serverReferences.add(key);
}

const clientSources = readFiles([
  ...filesUnder(join(repositoryDirectory, 'client', 'app'), ['.ts', '.tsx']),
  join(repositoryDirectory, 'client', 'proxy.ts'),
  join(repositoryDirectory, 'client', 'next.config.ts'),
]);
const clientReferences = referencedKeys(clientSources, /process\.env\.([A-Z][A-Z0-9_]*)/g);

const missingServer = [...serverReferences].filter((key) => !envTemplateKeys(join(serverDirectory, '.env.example')).has(key));
const missingClient = [...clientReferences].filter((key) => !envTemplateKeys(join(repositoryDirectory, 'client', '.env.example')).has(key));

if (missingServer.length || missingClient.length) {
  if (missingServer.length) console.error(`Missing from server/.env.example: ${missingServer.join(', ')}`);
  if (missingClient.length) console.error(`Missing from client/.env.example: ${missingClient.join(', ')}`);
  process.exit(1);
}

console.log(`Env templates cover ${serverReferences.size} server/Compose keys and ${clientReferences.size} client keys.`);
