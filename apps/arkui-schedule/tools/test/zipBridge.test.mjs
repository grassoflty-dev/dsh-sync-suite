// 附件按天 zip（WebView 桥里的 JSZip）测试。
//
// 为什么测桥里的实现而不是自己写一份：zip 的读写唯一实现就在 `rawfile/git/git-bridge.js`
// （JSZip 在 WebView 里，两端环境一致）。这里用 Node 直接把该文件加载起来，
// 配一个**内存 host**（模拟 ArkTS 侧的 fileExists/readFileBase64/writeFileBase64/mkdirp），
// 就能在 Node 里跑真实的 `zipUpsert / zipList / zipRead`，不用装机。
//
// 覆盖：
//   - 往返：写 3 条 → list 3 条 → read 字节完全一致；
//   - 同名覆盖：同条目再写一次，内容替换而不是重复追加；
//   - 空 zip；损坏 zip（不是 zip 的字节）容错成空包；
//   - 条目名非法（带 `/`）被拒绝；
//   - 分块：大于一块的数据按 ≤256KB base64 分块返回，拼起来字节一致。
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, describe, test } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = joinPath(here, '..', '..');
const bridgeDir = joinPath(appRoot, 'entry', 'src', 'main', 'resources', 'rawfile', 'git');
const require = createRequire(import.meta.url);

/** 内存文件系统：路径 → Buffer。 */
const memFs = new Map();

/** UTF-8 ↔ base64（与桥内 bytesToBase64 等价，测试侧独立实现）。 */
function toB64(buffer) {
  return Buffer.from(buffer).toString('base64');
}

function fromB64(text) {
  return Buffer.from(String(text), 'base64');
}

/** 构造 ArkTS 侧的 host 代理（只实现 zip 需要的 4 个方法）。 */
function installHost() {
  globalThis.dshGitHost = {
    fileExists(path) {
      return memFs.has(path) || [...memFs.keys()].some((key) => key.startsWith(`${path}/`));
    },
    readFileBase64(path) {
      const value = memFs.get(path);
      if (value === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      return toB64(value);
    },
    writeFileBase64(path, base64) {
      memFs.set(path, fromB64(base64));
      return true;
    },
    mkdirp() {
      return true;
    }
  };
}

/** 载入桥 + JSZip（jszip.min.js 是 UMD，浏览器里挂 `window.JSZip`）。 */
function loadBridge() {
  // 仓库根 package.json 是 `"type": "module"`：`.js` 会被当 ESM 加载，
  // UMD 因此走「挂全局」分支（`module.exports` 不可用）——与浏览器里的行为一致。
  const jszipModule = require(joinPath(bridgeDir, 'jszip.min.js'));
  const JSZip =
    typeof globalThis.JSZip === 'function'
      ? globalThis.JSZip
      : typeof jszipModule === 'function'
        ? jszipModule
        : jszipModule.default;
  assert.equal(typeof JSZip, 'function', 'jszip.min.js 必须可用（UMD 挂到 globalThis.JSZip）');
  // 显式挂一次，保证后续加载的桥能拿到（不依赖 require 的副作用顺序）
  globalThis.JSZip = JSZip;

  installHost();
  require(joinPath(bridgeDir, 'git-bridge.js'));
  const loaded = globalThis.DshGitBridge;
  assert.equal(typeof loaded, 'object', 'git-bridge.js 必须暴露 DshGitBridge');
  assert.equal(typeof loaded.internals.zipUpsert, 'function', 'internals 必须暴露 zipUpsert（供 Node 单测）');
  return loaded;
}

let bridge = null;

before(() => {
  bridge = loadBridge();
});

/** 把字节切成 base64 分块（≤ chunkBytes 原始字节/块）。 */
function chunk(buffer) {
  const chunkBytes = bridge.internals.zipChunkBytes;
  const chunks = [];
  for (let offset = 0; offset < buffer.length; offset += chunkBytes) {
    chunks.push(toB64(buffer.subarray(offset, Math.min(offset + chunkBytes, buffer.length))));
  }
  return chunks;
}

/** 把返回的 chunks 拼回 Buffer。 */
function join(chunks) {
  return Buffer.concat(chunks.map((item) => fromB64(item)));
}

describe('附件按天 zip：JSZip 桥（zipUpsert / zipList / zipRead）', () => {
  test('往返：写 3 条 → list 3 条 → read 字节完全一致', async () => {
    const archive = '/data/attachments/2026-11-15.zip';
    const files = [
      { name: 'page-0-aaaa1111.jpg', data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) },
      { name: 'page-1-bbbb2222.jpg', data: Buffer.from('hello-jpeg-1') },
      { name: 'page-2-cccc3333.jpg', data: Buffer.from('第三页手写内容') }
    ];
    const written = await bridge.internals.zipUpsert({
      archivePath: archive,
      entries: files.map((item) => ({ name: item.name, chunks: chunk(item.data) }))
    });
    assert.equal(written.archivePath, archive);
    assert.ok(written.bytes > 0, 'zip 字节数必须 > 0');
    assert.equal(written.entries.length, 3, '返回的条目数必须是 3');

    const listed = await bridge.internals.zipList({ archivePath: archive });
    assert.equal(listed.entries.length, 3);
    assert.deepEqual(
      listed.entries.map((item) => item.name),
      ['page-0-aaaa1111.jpg', 'page-1-bbbb2222.jpg', 'page-2-cccc3333.jpg'],
      'list 必须按条目名排序'
    );

    for (const item of files) {
      const read = await bridge.internals.zipRead({ archivePath: archive, entryName: item.name });
      assert.equal(read.size, item.data.length, `${item.name} 大小必须一致`);
      assert.deepEqual(join(read.chunks), item.data, `${item.name} 字节必须完全一致`);
    }
  });

  test('同名覆盖：同条目再写一次是替换，不重复追加', async () => {
    const archive = '/data/attachments/2026-11-16.zip';
    await bridge.internals.zipUpsert({
      archivePath: archive,
      entries: [{ name: 'page-0-11112222.jpg', chunks: chunk(Buffer.from('old')) }]
    });
    await bridge.internals.zipUpsert({
      archivePath: archive,
      entries: [
        { name: 'page-0-11112222.jpg', chunks: chunk(Buffer.from('NEW-content')) },
        { name: 'page-1-33334444.jpg', chunks: chunk(Buffer.from('second')) }
      ]
    });
    const listed = await bridge.internals.zipList({ archivePath: archive });
    assert.equal(listed.entries.length, 2, '覆盖不应新增条目');
    const read = await bridge.internals.zipRead({ archivePath: archive, entryName: 'page-0-11112222.jpg' });
    assert.equal(join(read.chunks).toString('utf8'), 'NEW-content', '内容必须被替换');
  });

  test('不存在的包：list 返回空数组、read 返回空 chunks（不抛）', async () => {
    const missing = '/data/attachments/2026-01-01.zip';
    const listed = await bridge.internals.zipList({ archivePath: missing });
    assert.deepEqual(listed.entries, []);
    const read = await bridge.internals.zipRead({ archivePath: missing, entryName: 'page-0-00000000.jpg' });
    assert.equal(read.size, 0);
    assert.deepEqual(read.chunks, []);
  });

  test('条目不存在：read 返回空 chunks，不抛', async () => {
    const archive = '/data/attachments/2026-11-17.zip';
    await bridge.internals.zipUpsert({
      archivePath: archive,
      entries: [{ name: 'page-0-55556666.jpg', chunks: chunk(Buffer.from('x')) }]
    });
    const read = await bridge.internals.zipRead({ archivePath: archive, entryName: 'page-9-deadbeef.jpg' });
    assert.equal(read.size, 0);
    assert.deepEqual(read.chunks, []);
  });

  test('损坏 zip（不是 zip 的字节）容错成空包后仍可写入', async () => {
    const archive = '/data/attachments/2026-11-18.zip';
    memFs.set(archive, Buffer.from('this-is-not-a-zip-at-all'));
    // 损坏包上 list 不抛
    const listed = await bridge.internals.zipList({ archivePath: archive });
    assert.deepEqual(listed.entries, []);
    // 写入后是正常包
    await bridge.internals.zipUpsert({
      archivePath: archive,
      entries: [{ name: 'page-0-77778888.jpg', chunks: chunk(Buffer.from('recovered')) }]
    });
    const read = await bridge.internals.zipRead({ archivePath: archive, entryName: 'page-0-77778888.jpg' });
    assert.equal(join(read.chunks).toString('utf8'), 'recovered');
  });

  test('条目名非法（含路径分隔符）被拒绝', async () => {
    await assert.rejects(
      bridge.internals.zipUpsert({
        archivePath: '/data/attachments/2026-11-19.zip',
        entries: [{ name: '../evil.jpg', chunks: chunk(Buffer.from('x')) }]
      }),
      /条目名不合法/
    );
    assert.equal(memFs.has('/data/attachments/2026-11-19.zip'), false, '失败不得写出半个包');
  });

  test('大文件分块：>1 块的数据跨块拼接后字节一致', async () => {
    const archive = '/data/attachments/2026-11-20.zip';
    // 300KB 伪随机字节（故意大于一块 192KB）
    const big = Buffer.alloc(300 * 1024);
    for (let i = 0; i < big.length; i++) {
      big[i] = (i * 37 + 11) & 0xff;
    }
    await bridge.internals.zipUpsert({
      archivePath: archive,
      entries: [{ name: 'page-0-big0big0.jpg', chunks: chunk(big) }]
    });
    const read = await bridge.internals.zipRead({ archivePath: archive, entryName: 'page-0-big0big0.jpg' });
    assert.ok(read.chunks.length >= 2, `300KB 必须至少分 2 块，实际 ${read.chunks.length}`);
    for (const part of read.chunks) {
      assert.ok(part.length <= 256 * 1024, `单块 base64 必须 ≤256KB，实际 ${part.length}`);
    }
    assert.deepEqual(join(read.chunks), big, '跨块拼接必须字节一致');
  });

  test('zip 里只有附件条目，不含临时/目录条目', async () => {
    const archive = '/data/attachments/2026-11-21.zip';
    await bridge.internals.zipUpsert({
      archivePath: archive,
      entries: [
        { name: 'page-0-aaaabbbb.jpg', chunks: chunk(Buffer.from('a')) },
        { name: 'page-1-ccccdddd.jpg', chunks: chunk(Buffer.from('b')) }
      ]
    });
    const listed = await bridge.internals.zipList({ archivePath: archive });
    assert.equal(listed.entries.length, 2);
    for (const item of listed.entries) {
      assert.ok(/^page-\d+-[0-9a-f]{8}\.jpg$/.test(item.name), `条目名必须符合 page-<页>-<sha8>.jpg：${item.name}`);
      assert.ok(item.size > 0, `${item.name} 的 size 必须 > 0`);
    }
  });
});
