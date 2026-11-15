import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bridgeDir = join(here, '..', '..', 'entry', 'src', 'main', 'resources', 'rawfile', 'git');
const require = createRequire(import.meta.url);

const memFs = new Map();
globalThis.dshGitHost = {
  fileExists: (p) => memFs.has(p),
  readFileBase64: (p) => Buffer.from(memFs.get(p)).toString('base64'),
  writeFileBase64: (p, b64) => {
    memFs.set(p, Buffer.from(b64, 'base64'));
    return true;
  },
  mkdirp: () => true
};
globalThis.JSZip = require(join(bridgeDir, 'jszip.min.js'));
console.log('JSZip type', typeof globalThis.JSZip);
const bridge = require(join(bridgeDir, 'git-bridge.js'));
console.log('bridge type', typeof bridge, Object.keys(bridge).slice(0, 8));
console.log('internals keys', Object.keys(bridge.internals).slice(0, 30));
const r = await bridge.internals.zipUpsert({
  archivePath: '/a/2026-11-15.zip',
  entries: [{ name: 'page-0-aaaa1111.jpg', chunks: [Buffer.from('hi').toString('base64')] }]
});
console.log('upsert', r);
const l = await bridge.internals.zipList({ archivePath: '/a/2026-11-15.zip' });
console.log('list', l);
const rd = await bridge.internals.zipRead({ archivePath: '/a/2026-11-15.zip', entryName: 'page-0-aaaa1111.jpg' });
console.log('read', rd);
