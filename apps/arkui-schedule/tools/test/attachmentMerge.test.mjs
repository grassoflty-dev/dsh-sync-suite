// 附件 / 汇总 / 未完成索引的「较新者胜 + 绝不覆盖」合并测试（A3 的附件部分）。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 覆盖：summaries 按 generatedAt 取新（含一侧损坏）/ open.jsonl 同 id 取 ts 较新与 ID 并集 /
//       zip 同名不同内容保留两份（`.local.zip` + `.remote.zip`，内容都在）/
//       zip 同名同内容只留一份 / 落盘计划绝不覆盖已存在文件。
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

// `attachmentMerge.ts` 运行期 import `./dailySummary` / `./openIndex` / `./sha256`（无扩展名），
// Node 的 ESM 不做扩展名推断，这里只为测试进程补 `.js` 后缀。
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error !== null &&
        typeof error === 'object' &&
        error.code === 'ERR_MODULE_NOT_FOUND' &&
        specifier.startsWith('.') &&
        !specifier.endsWith('.js')
      ) {
        return nextResolve(`${specifier}.js`, context);
      }
      throw error;
    }
  }
});

const {
  archiveSha256,
  localVariantName,
  mergeArchivePair,
  mergeOpenIndexTexts,
  mergeSummaryTexts,
  planArchiveWrites,
  remoteVariantName
} = await import('../.build/model/attachmentMerge.js');
const { encodeOpenEntry } = await import('../.build/model/openIndex.js');
const { sha256Hex } = await import('../.build/model/sha256.js');

const DAY = '2026-11-15';

/** 字符串 → 字节（zip 内容不需要是真 zip：合并只按 sha256 判等）。 */
function bytes(text) {
  return new TextEncoder().encode(text);
}

/** 造一份合法汇总 JSON。 */
function summaryJson({ date = DAY, generatedAt = 1000, headline = '默认汇总' } = {}) {
  return JSON.stringify({
    version: 1,
    date,
    generatedAt,
    model: 'deepseek-chat',
    provider: 'deepseek',
    headline,
    points: ['要点一'],
    recordCount: 1,
    doneCount: 0
  });
}

/** 造一条 open.jsonl 索引条目。 */
function openEntry(overrides = {}) {
  return {
    id: 'e1',
    date: DAY,
    ts: `${DAY}T09:00:00+08:00`,
    openedAt: `${DAY}T09:00:00+08:00`,
    ...overrides
  };
}

/** 一组索引条目 → JSONL 文本。 */
function openLines(...entries) {
  return entries.map((entry) => encodeOpenEntry(entry)).join('');
}

// ---------------------------------------------------------------- 1. summaries：generatedAt 较新者胜

test('汇总：远端 generatedAt 更新 → 采用远端', () => {
  const decision = mergeSummaryTexts(
    summaryJson({ generatedAt: 1000, headline: '本机旧汇总' }),
    summaryJson({ generatedAt: 2000, headline: '远端新汇总' })
  );
  assert.equal(decision.winner, 'remote');
  assert.equal(JSON.parse(decision.text).headline, '远端新汇总');
  assert.equal(decision.localGeneratedAt, 1000);
  assert.equal(decision.remoteGeneratedAt, 2000);
  assert.equal(decision.errors, 0);
});

test('汇总：本机 generatedAt 更新 → 保留本机（不写盘）', () => {
  const decision = mergeSummaryTexts(
    summaryJson({ generatedAt: 3000, headline: '本机新汇总' }),
    summaryJson({ generatedAt: 2000, headline: '远端旧汇总' })
  );
  assert.equal(decision.winner, 'local');
  assert.equal(JSON.parse(decision.text).headline, '本机新汇总');
});

test('汇总：generatedAt 相同且内容相同 → identical（无需写盘）', () => {
  const same = summaryJson({ generatedAt: 2000, headline: '同一份' });
  const decision = mergeSummaryTexts(same, same);
  assert.equal(decision.winner, 'identical');
  assert.equal(JSON.parse(decision.text).headline, '同一份');
});

test('汇总：generatedAt 相同内容不同 → 保留本机（先到先得，不抖）', () => {
  const decision = mergeSummaryTexts(
    summaryJson({ generatedAt: 2000, headline: '本机版' }),
    summaryJson({ generatedAt: 2000, headline: '远端版' })
  );
  assert.equal(decision.winner, 'local');
  assert.equal(JSON.parse(decision.text).headline, '本机版');
});

test('汇总：一侧损坏 → 采用可用的一侧，errors 计数为 1', () => {
  const decision = mergeSummaryTexts('{不是 JSON', summaryJson({ generatedAt: 500, headline: '远端可用' }));
  assert.equal(decision.winner, 'remote');
  assert.equal(decision.errors, 1);
  assert.equal(JSON.parse(decision.text).headline, '远端可用');
  assert.match(decision.note, /本机汇总损坏/);

  const mirrored = mergeSummaryTexts(summaryJson({ generatedAt: 500, headline: '本机可用' }), '{"date":"坏"}');
  assert.equal(mirrored.winner, 'local');
  assert.equal(mirrored.errors, 1);
  assert.equal(JSON.parse(mirrored.text).headline, '本机可用');
});

test('汇总：两侧都空 → empty；两侧都损坏 → 原样保留本机文本（不清空）', () => {
  const empty = mergeSummaryTexts('', '');
  assert.equal(empty.winner, 'empty');
  assert.equal(empty.text, '');

  const bothBroken = mergeSummaryTexts('坏掉的本机', '坏掉的远端');
  assert.equal(bothBroken.winner, 'local');
  assert.equal(bothBroken.text, '坏掉的本机', '损坏也绝不静默清空');
  assert.equal(bothBroken.errors, 2);
});

// ---------------------------------------------------------------- 2. open.jsonl：同 id 取 ts 较新

test('open.jsonl：同 id 取 ts 较新（远端更新 → 取远端）', () => {
  const local = openLines(openEntry({ id: 'a', ts: `${DAY}T09:00:00+08:00`, closedAt: undefined }));
  const remote = openLines(
    openEntry({ id: 'a', ts: `${DAY}T12:00:00+08:00`, openedAt: `${DAY}T09:00:00+08:00`, closedAt: `${DAY}T12:00:00+08:00` })
  );

  const merged = mergeOpenIndexTexts(local, remote);
  assert.equal(merged.stats.result.length, 1);
  assert.equal(merged.stats.result[0].ts, `${DAY}T12:00:00+08:00`);
  assert.equal(merged.stats.result[0].closedAt, `${DAY}T12:00:00+08:00`, '较新的「已完成」状态胜出');
  assert.equal(merged.stats.conflicts, 0);
  assert.equal(merged.text, openLines(merged.stats.result[0]), '输出是 encodeOpenEntry 规范格式');
});

test('open.jsonl：ID 并集（本机独有 + 远端独有都保留）', () => {
  const local = openLines(
    openEntry({ id: 'local-only', ts: `${DAY}T09:00:00+08:00` }),
    openEntry({ id: 'shared', ts: `${DAY}T10:00:00+08:00` })
  );
  const remote = openLines(
    openEntry({ id: 'shared', ts: `${DAY}T10:00:00+08:00` }),
    openEntry({ id: 'remote-only', ts: `${DAY}T11:00:00+08:00` })
  );

  const merged = mergeOpenIndexTexts(local, remote);
  assert.deepEqual(
    merged.stats.result.map((entry) => entry.id),
    ['local-only', 'shared', 'remote-only'],
    '按 ts 升序，三个 id 都在'
  );
  assert.equal(merged.stats.localOnly, 1);
  assert.equal(merged.stats.remoteOnly, 1);
  assert.equal(merged.stats.duplicates, 1, 'shared 两侧一致，去重');
});

test('open.jsonl：ts 相同内容不同 → 冲突取本机，conflictIds 有该 id', () => {
  const local = openLines(openEntry({ id: 'a', ts: `${DAY}T09:00:00+08:00`, openedAt: `${DAY}T09:00:00+08:00` }));
  const remote = openLines(openEntry({ id: 'a', ts: `${DAY}T09:00:00+08:00`, openedAt: `${DAY}T08:00:00+08:00` }));

  const merged = mergeOpenIndexTexts(local, remote);
  assert.equal(merged.stats.conflicts, 1);
  assert.deepEqual(merged.conflictIds, ['a']);
  assert.equal(merged.stats.result[0].openedAt, `${DAY}T09:00:00+08:00`);
});

test('open.jsonl：坏行/空文件容错，errors 计数正确，不抛', () => {
  const local = [encodeOpenEntry(openEntry({ id: 'good' })).trim(), '坏行', '{"id":"x"}'].join('\n');
  const remote = '{"又一行":"坏的"}';

  const merged = mergeOpenIndexTexts(local, remote);
  assert.equal(merged.stats.localErrors, 2);
  assert.equal(merged.stats.remoteErrors, 1);
  assert.equal(merged.stats.errors, 3);
  assert.deepEqual(
    merged.stats.result.map((entry) => entry.id),
    ['good']
  );

  const blank = mergeOpenIndexTexts('', '');
  assert.equal(blank.text, '');
  assert.equal(blank.stats.errors, 0);
});

test('open.jsonl：输出稳定（同输入两次逐字节相同，可重复合并）', () => {
  const local = openLines(openEntry({ id: 'b', ts: `${DAY}T10:00:00+08:00` }), openEntry({ id: 'a', ts: `${DAY}T09:00:00+08:00` }));
  const remote = openLines(openEntry({ id: 'c', ts: `${DAY}T11:00:00+08:00` }));

  const first = mergeOpenIndexTexts(local, remote);
  const second = mergeOpenIndexTexts(local, remote);
  assert.equal(first.text, second.text);
  const again = mergeOpenIndexTexts(first.text, remote);
  assert.equal(again.text, first.text, '合并结果再合并一次不变');
});

// ---------------------------------------------------------------- 3. 按天 zip：绝不覆盖

test('zip 同名不同内容 → 保留两份（.local.zip + .remote.zip，两份内容都在）', () => {
  const localZip = { name: `${DAY}.zip`, bytes: bytes('本机手迹') };
  const remoteZip = { name: `${DAY}.zip`, bytes: bytes('远端手迹') };

  const merged = mergeArchivePair(localZip, remoteZip);
  assert.equal(merged.renamed, true);
  assert.equal(merged.identical, false);
  assert.deepEqual(
    merged.variants.map((variant) => variant.name),
    [`${DAY}.local.zip`, `${DAY}.remote.zip`],
    '改名规则固定为 .local.zip / .remote.zip'
  );
  assert.deepEqual(
    merged.variants.map((variant) => Buffer.from(variant.bytes).toString('utf8')),
    ['本机手迹', '远端手迹'],
    '两份内容都必须保留（绝不覆盖丢手迹）'
  );
  assert.equal(merged.variants[0].sha256, sha256Hex(localZip.bytes));
  assert.equal(merged.variants[1].sha256, sha256Hex(remoteZip.bytes));
  assert.notEqual(merged.localSha256, merged.remoteSha256);
  assert.equal(archiveSha256(null), '', '缺失的一侧 sha 为空串');
});

test('zip 同名同内容 → 只留一份', () => {
  const same = bytes('完全相同的字节');
  const merged = mergeArchivePair({ name: `${DAY}.zip`, bytes: same }, { name: `${DAY}.zip`, bytes: same });

  assert.equal(merged.identical, true);
  assert.equal(merged.renamed, false);
  assert.equal(merged.variants.length, 1, '同名同内容只留一份');
  assert.equal(merged.variants[0].name, `${DAY}.zip`);
  assert.equal(Buffer.from(merged.variants[0].bytes).toString('utf8'), '完全相同的字节');
});

test('zip 只有一侧 → 保留原名（不无谓改名）', () => {
  const remoteOnly = mergeArchivePair(null, { name: `${DAY}.zip`, bytes: bytes('远端') });
  assert.deepEqual(
    remoteOnly.variants.map((variant) => variant.name),
    [`${DAY}.zip`]
  );
  assert.equal(remoteOnly.variants[0].role, 'remote');

  const localOnly = mergeArchivePair({ name: `${DAY}.zip`, bytes: bytes('本机') }, null);
  assert.deepEqual(
    localOnly.variants.map((variant) => variant.name),
    [`${DAY}.zip`]
  );
  assert.equal(localOnly.variants[0].role, 'local');

  const neither = mergeArchivePair(null, null);
  assert.deepEqual(neither.variants, []);
});

test('variant 命名工具：插入到扩展名前，没有扩展名时接在末尾', () => {
  assert.equal(localVariantName(`${DAY}.zip`), `${DAY}.local.zip`);
  assert.equal(remoteVariantName(`${DAY}.zip`), `${DAY}.remote.zip`);
  assert.equal(localVariantName('piece'), 'piece.local');
});

// ---------------------------------------------------------------- 4. 落盘计划：不覆盖

test('planArchiveWrites：同名不同内容 → 只新写 .local.zip，工作副本那份原样保留', () => {
  const localZip = { name: `${DAY}.zip`, bytes: bytes('本机手迹') };
  const remoteZip = { name: `${DAY}.zip`, bytes: bytes('远端手迹') };
  const existing = [{ name: `${DAY}.zip`, sha256: sha256Hex(remoteZip.bytes) }];

  const plan = planArchiveWrites(existing, localZip, remoteZip);
  assert.equal(plan.renamed, true);
  assert.deepEqual(
    plan.kept,
    [`${DAY}.zip`],
    '盘上已有远端那份（同内容）→ 无需重写'
  );
  assert.deepEqual(
    plan.writes.map((write) => write.name),
    [`${DAY}.local.zip`],
    '只补写本机那份'
  );
  assert.equal(Buffer.from(plan.writes[0].bytes).toString('utf8'), '本机手迹');
  // 两份内容同时在：已存在的那份（远端）+ 计划写出的那份（本机）
  const present = [Buffer.from(remoteZip.bytes).toString('utf8'), Buffer.from(plan.writes[0].bytes).toString('utf8')];
  assert.deepEqual(present.sort(), ['本机手迹', '远端手迹'].sort());
});

test('planArchiveWrites：同名同内容 → 不写任何文件（只留一份）', () => {
  const same = bytes('相同字节');
  const existing = [{ name: `${DAY}.zip`, sha256: sha256Hex(same) }];

  const plan = planArchiveWrites(existing, { name: `${DAY}.zip`, bytes: same }, { name: `${DAY}.zip`, bytes: same });
  assert.equal(plan.identical, true);
  assert.deepEqual(plan.writes, []);
  assert.deepEqual(plan.kept, [`${DAY}.zip`]);
});

test('planArchiveWrites：目标名已被占用（内容不同）→ 退到 .1 后缀，绝不覆盖', () => {
  const localZip = { name: `${DAY}.zip`, bytes: bytes('本机手迹') };
  const remoteZip = { name: `${DAY}.zip`, bytes: bytes('远端手迹') };
  const existing = [
    { name: `${DAY}.zip`, sha256: sha256Hex(remoteZip.bytes) },
    { name: `${DAY}.local.zip`, sha256: 'f'.repeat(64) }
  ];

  const plan = planArchiveWrites(existing, localZip, remoteZip);
  assert.equal(plan.writes.length, 1);
  const written = plan.writes[0].name;
  assert.notEqual(written, `${DAY}.local.zip`, '不得与已存在文件同名');
  assert.notEqual(written, `${DAY}.zip`);
  assert.equal(existing.some((item) => item.name === written), false);
  assert.equal(Buffer.from(plan.writes[0].bytes).toString('utf8'), '本机手迹', '内容不丢');
});

test('planArchiveWrites：只有本机快照（远端文件被覆盖丢失）→ 补写回原名或空闲名', () => {
  const localZip = { name: `${DAY}.zip`, bytes: bytes('只有本机有的手迹') };
  const plan = planArchiveWrites([], localZip, null);
  assert.deepEqual(plan.writes.map((write) => write.name), [`${DAY}.zip`]);
  assert.equal(Buffer.from(plan.writes[0].bytes).toString('utf8'), '只有本机有的手迹');
});

test('planArchiveWrites：两侧都空 → 空计划，不抛', () => {
  const plan = planArchiveWrites([], null, null);
  assert.deepEqual(plan.writes, []);
  assert.deepEqual(plan.kept, []);
  assert.equal(plan.identical, false);
});
