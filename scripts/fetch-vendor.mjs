import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Recreates vendor/<name> from the pinned upstream archive plus vendor-patches/<name>.patch.
// Archive URLs and hashes match each engine's provenance file inside the patch.
const root = fileURLToPath(new URL('../', import.meta.url));
const engines = [
  {
    name: 'superdoc',
    archive: 'https://codeload.github.com/superdoc/docx-editor/tar.gz/e096323e7d5e54f95b4817d1d3aefde8c37d52cf',
    sha256: '55e65b98203ee31c9f608ac99e9924cdb220a7dfdaa2b5a23e7f20de8188eb35',
  },
  {
    name: 'rhwp',
    archive: 'https://codeload.github.com/edwardkim/rhwp/tar.gz/f1f9c6ae58344ee9368996d3543f76b9345cf227',
    sha256: '042785d3b1e27a06a07da05055f6f29cf055cea2d08780b1e1597d1b1dc2e342',
  },
  {
    name: 'pptist',
    archive: 'https://codeload.github.com/pipipi-pikachu/PPTist/tar.gz/e4912589ffdbec389fcc1bf25a85852dfe3040a8',
    sha256: '19ea5dde5734f2390609f146054a3ea4e43f9e43a9d3bd15d9eba4d16d247055',
  },
];

function run(directory, command, args, extraEnvironment = {}) {
  const result = spawnSync(command, args, { cwd: directory, stdio: 'inherit', env: { ...process.env, ...extraEnvironment } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed in ${directory}`);
}

await mkdir(path.join(root, 'vendor'), { recursive: true });

for (const { name, archive, sha256 } of engines) {
  const target = path.join(root, 'vendor', name);
  if (await access(target).then(() => true, () => false)) {
    console.log(`[vendor] ${name}: vendor/${name} exists, skipped`);
    continue;
  }
  // Staged beside the target so the final rename stays on one filesystem.
  const staging = await mkdtemp(path.join(root, 'vendor', `.${name}-`));
  try {
    console.log(`[vendor] ${name}: downloading ${archive}`);
    const response = await fetch(archive);
    if (!response.ok) throw new Error(`${archive}: HTTP ${response.status}`);
    const archiveFile = path.join(staging, 'upstream.tar.gz');
    const hash = createHash('sha256');
    await pipeline(response.body, async function* (chunks) {
      for await (const chunk of chunks) {
        hash.update(chunk);
        yield chunk;
      }
    }, createWriteStream(archiveFile));
    const actual = hash.digest('hex');
    if (actual !== sha256) throw new Error(`${name}: archive SHA-256 ${actual} does not match ${sha256}`);

    const tree = path.join(staging, 'tree');
    await mkdir(tree);
    run(staging, 'tar', ['-xzf', archiveFile, '-C', tree, '--strip-components=1']);
    // Without the ceiling, git apply would resolve paths against this repository instead of the tree.
    run(tree, 'git', ['apply', '--binary', '--whitespace=nowarn', path.join(root, 'vendor-patches', `${name}.patch`)], { GIT_CEILING_DIRECTORIES: staging });
    await rename(tree, target);
    console.log(`[vendor] ${name}: vendor/${name} ready`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
