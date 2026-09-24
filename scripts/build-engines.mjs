import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, cp, lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'public/engines');
const environment = { ...process.env, CI: '1', HUSKY: '0' };
const stampFile = path.join(root, 'node_modules/.cache/pdfeditor-engines.json');
const skippedDirectories = new Set(['node_modules', 'dist', 'target', 'pkg', '.git']);
const scriptSource = await readFile(fileURLToPath(import.meta.url));

// Signature of every engine source file (path, size, mtime) plus this script.
// Build outputs and dependencies are excluded; files a build generates elsewhere
// are captured because the signature is recorded after the build.
async function signature(directories) {
  const entries = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else entries.push(file);
    }
  }
  for (const directory of directories) await walk(path.join(root, directory));
  const stats = await Promise.all(entries.map(file => lstat(file)));
  const hash = createHash('sha256').update(scriptSource);
  entries.map((file, i) => `${path.relative(root, file)}\0${stats[i].size}\0${stats[i].mtimeMs}\n`).sort().forEach(line => hash.update(line));
  return hash.digest('hex');
}
const stamps = JSON.parse(await readFile(stampFile, 'utf8').catch(() => '{}'));

async function engine(name, sources, build) {
  const published = await access(path.join(output, name, 'index.html')).then(() => true, () => false);
  if (process.env.FORCE_ENGINES !== '1' && published && stamps[name] === await signature(sources)) {
    console.log(`\n[engines] ${name}: sources unchanged, reusing public/engines/${name}/ (FORCE_ENGINES=1 to rebuild)`);
    return;
  }
  delete stamps[name];
  await build();
  stamps[name] = await signature(sources);
  await mkdir(path.dirname(stampFile), { recursive: true });
  await writeFile(stampFile, JSON.stringify(stamps, null, 2));
}

function run(directory, command, args, extraEnvironment = {}) {
  console.log(`\n[engines] ${directory}: ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: path.join(root, directory),
    env: { ...environment, ...extraEnvironment },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed in ${directory} (${result.signal ?? result.status})`);
  }
}

async function publish(source, name) {
  const destination = path.join(output, name);
  await rm(destination, { recursive: true, force: true });
  await cp(path.join(root, source), destination, { recursive: true, dereference: true });
}

if (Number(process.versions.node.split('.')[0]) < 22) {
  throw new Error('Office engine builds require Node.js 22 or newer.');
}

await mkdir(output, { recursive: true });
await publish('src/assets/fonts', 'fonts');

await engine('docx', ['vendor/superdoc', 'engines/docx'], async () => {
  run('vendor/superdoc', 'pnpm', ['run', 'build:superdoc']);
  run('engines/docx', 'npm', ['run', 'build']);
  await publish('engines/docx/dist', 'docx');
  await cp(path.join(root, 'vendor/superdoc/shared/font-system/assets'), path.join(output, 'docx/fonts'), {
    recursive: true,
    dereference: true,
  });
});

await engine('rhwp', ['vendor/rhwp'], async () => {
  run('vendor/rhwp', 'wasm-pack', ['build', '--target', 'web', '--release'], {
    CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? '2',
  });
  const studioPublic = path.join(root, 'vendor/rhwp/rhwp-studio/public');
  await mkdir(studioPublic, { recursive: true });
  await cp(path.join(root, 'vendor/rhwp/assets/logo/favicon.ico'), path.join(studioPublic, 'favicon.ico'));
  for (const name of ['rhwp_bg.wasm', 'rhwp.js']) {
    await cp(path.join(root, 'vendor/rhwp/pkg', name), path.join(studioPublic, name));
  }
  run('vendor/rhwp/rhwp-studio', 'npm', ['run', 'build', '--', '--base=/engines/rhwp/'], {
    RHWP_DISABLE_EXTERNAL_WEBFONTS: '1',
  });
  await publish('vendor/rhwp/rhwp-studio/dist', 'rhwp');
});

await engine('pptx', ['vendor/pptist'], async () => {
  run('vendor/pptist', 'npm', ['run', 'build']);
  await publish('vendor/pptist/dist', 'pptx');
});
console.log('\n[engines] DOCX, HWP/HWPX, and PPTX runtimes are ready in public/engines/.');
