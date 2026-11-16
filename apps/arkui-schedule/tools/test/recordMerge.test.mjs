// 记录级冲突合并（A3）纯逻辑层测试。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 覆盖：同 id 冲突取较新 ts / ID 并集（本机新增、远端新增都不丢）/ 远端缺行不误删本机 /
//       同 ts 同内容去重 / 同 ts 不同内容计冲突并取本机（可切远端）/ 坏行与空文件容错 /
//       输出为 encodeRecord 规范格式且逐字节稳定（同输入两次、乱序输入都不变）。
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

// `recordMerge.ts` 运行期 import `./jsonl`（无扩展名，ArkTS 要求）；
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

const { encodeRecord } = await import('../.build/model/jsonl.js');
const { mergeDayFile, mergeRecordLines } = await import('../.build/model/recordMerge.js');

const DAY = '2026-11-15';

/** 造一条合法记录。 */
function rec(overrides = {}) {
  return {
    id: 'r1',
    ts: `${DAY}T09:00:00+08:00`,
    title: '周会',
    body: '正文',
    author: '我',
    done: false,
    ai_processed: false,
    ...overrides
  };
}

/** 一组记录 → JSONL 文本（每行 encodeRecord 规范格式）。 */
function lines(...records) {
  return records.map((record) => encodeRecord(record)).join('');
}

/** 从合并结果里按 id 取记录。 */
function byId(stats, id) {
  return stats.result.find((record) => record.id === id);
}

// ---------------------------------------------------------------- ts 较新者胜

test('同 id：远端 ts 较新 → 取远端版本', () => {
  const local = lines(rec({ id: 'a', ts: `${DAY}T09:00:00+08:00`, title: '本机旧标题' }));
  const remote = lines(rec({ id: 'a', ts: `${DAY}T10:00:00+08:00`, title: '远端新标题' }));

  const stats = mergeRecordLines(local, remote);
  assert.equal(stats.result.length, 1);
  assert.equal(stats.result[0].title, '远端新标题', 'ts 较新的一条胜出');
  assert.equal(stats.result[0].ts, `${DAY}T10:00:00+08:00`);
  assert.equal(stats.conflicts, 0, 'ts 不同不算冲突（有明确胜者）');
  assert.equal(stats.localOnly + stats.remoteOnly, 0);
  assert.equal(stats.errors, 0);
});

test('同 id：本机 ts 较新 → 取本机版本', () => {
  const local = lines(rec({ id: 'a', ts: `${DAY}T12:00:00+08:00`, title: '本机新' }));
  const remote = lines(rec({ id: 'a', ts: `${DAY}T08:00:00+08:00`, title: '远端旧' }));

  const stats = mergeRecordLines(local, remote);
  assert.equal(stats.result.length, 1);
  assert.equal(stats.result[0].title, '本机新');
  assert.equal(stats.conflicts, 0);
});

test('同 id：单侧多版本时先各自折叠（取各自最新），再比 ts', () => {
  const local = lines(
    rec({ id: 'a', ts: `${DAY}T09:00:00+08:00`, title: '本机一' }),
    rec({ id: 'a', ts: `${DAY}T11:00:00+08:00`, title: '本机二' })
  );
  const remote = lines(rec({ id: 'a', ts: `${DAY}T10:00:00+08:00`, title: '远端' }));

  const stats = mergeRecordLines(local, remote);
  assert.equal(stats.result.length, 1);
  assert.equal(stats.result[0].title, '本机二', '本机侧先折叠到最新再比较');
});

// ---------------------------------------------------------------- ID 并集

test('ID 并集：本机新增与远端新增都进结果', () => {
  const local = lines(
    rec({ id: 'a', ts: `${DAY}T09:00:00+08:00` }),
    rec({ id: 'b', ts: `${DAY}T10:00:00+08:00` })
  );
  const remote = lines(
    rec({ id: 'b', ts: `${DAY}T10:30:00+08:00`, body: '远端改过' }),
    rec({ id: 'c', ts: `${DAY}T11:00:00+08:00` })
  );

  const stats = mergeRecordLines(local, remote);
  assert.deepEqual(
    stats.result.map((record) => record.id),
    ['a', 'b', 'c'],
    '三个 id 都在，且按 ts 升序'
  );
  assert.equal(stats.localOnly, 1, 'a 只在本机');
  assert.equal(stats.remoteOnly, 1, 'c 只在远端（远端新增不能丢）');
  assert.equal(stats.conflicts, 0);
  assert.equal(byId(stats, 'b').body, '远端改过', '同 id 取较新的远端版本');
});

test('远端删除本机保留：远端文件里没有的 id 不会被误删', () => {
  const local = lines(
    rec({ id: 'keep-me', ts: `${DAY}T09:00:00+08:00`, title: '本机独有的记录' }),
    rec({ id: 'both', ts: `${DAY}T10:00:00+08:00` })
  );
  // 远端只有 both（缺行 = 没同步过来，不是删除）
  const remote = lines(rec({ id: 'both', ts: `${DAY}T10:00:00+08:00` }));

  const stats = mergeRecordLines(local, remote);
  assert.deepEqual(
    stats.result.map((record) => record.id),
    ['keep-me', 'both']
  );
  assert.equal(byId(stats, 'keep-me').title, '本机独有的记录');
  assert.equal(stats.localOnly, 1);
});

test('远端为空文件：本机记录全部保留（空文件不是删除）', () => {
  const local = lines(rec({ id: 'a' }), rec({ id: 'b', ts: `${DAY}T10:00:00+08:00` }));
  const stats = mergeRecordLines(local, '');
  assert.equal(stats.result.length, 2);
  assert.equal(stats.localOnly, 2);
  assert.equal(stats.remoteOnly, 0);
  assert.equal(stats.errors, 0);
});

// ---------------------------------------------------------------- 同 ts：去重 vs 冲突

test('同 ts 且内容相同 → 只保留一份，不算冲突', () => {
  const record = rec({ id: 'same', ts: `${DAY}T09:00:00+08:00`, title: '一样' });
  const stats = mergeRecordLines(lines(record), lines(record));

  assert.equal(stats.result.length, 1, '同一份内容不重复出现');
  assert.equal(stats.conflicts, 0);
  assert.equal(stats.duplicates, 1, '去重计数');
});

test('同 ts 但内容不同 → 计入 conflicts，默认取本机并给出 conflictIds', () => {
  const local = lines(rec({ id: 'a', ts: `${DAY}T09:00:00+08:00`, title: '本机说法', done: false }));
  const remote = lines(rec({ id: 'a', ts: `${DAY}T09:00:00+08:00`, title: '远端说法', done: true }));

  const merged = mergeDayFile(local, remote);
  assert.equal(merged.stats.conflicts, 1);
  assert.deepEqual(merged.conflictIds, ['a']);
  assert.equal(merged.stats.result[0].title, '本机说法', '默认保留本机');
  assert.equal(merged.conflictDetails.length, 1);
  assert.equal(merged.conflictDetails[0].id, 'a');
  assert.equal(merged.conflictDetails[0].ts, `${DAY}T09:00:00+08:00`);
  // 两侧规范行都给出来，UI 可以并排展示
  assert.equal(JSON.parse(merged.conflictDetails[0].localLine).title, '本机说法');
  assert.equal(JSON.parse(merged.conflictDetails[0].remoteLine).title, '远端说法');
});

test('冲突时 prefer=remote → 取远端版本（UI「采用远端」路径）', () => {
  const local = lines(rec({ id: 'a', ts: `${DAY}T09:00:00+08:00`, title: '本机说法' }));
  const remote = lines(rec({ id: 'a', ts: `${DAY}T09:00:00+08:00`, title: '远端说法' }));

  const merged = mergeDayFile(local, remote, 'remote');
  assert.equal(merged.stats.conflicts, 1);
  assert.equal(merged.stats.result[0].title, '远端说法');
  assert.deepEqual(merged.conflictIds, ['a'], '冲突 id 不因采用哪侧而消失');
});

test('冲突 id 排序稳定（ts 升序 → id 升序）', () => {
  const local = lines(
    rec({ id: 'b', ts: `${DAY}T10:00:00+08:00`, title: 'b-本机' }),
    rec({ id: 'a', ts: `${DAY}T09:00:00+08:00`, title: 'a-本机' })
  );
  const remote = lines(
    rec({ id: 'b', ts: `${DAY}T10:00:00+08:00`, title: 'b-远端' }),
    rec({ id: 'a', ts: `${DAY}T09:00:00+08:00`, title: 'a-远端' })
  );
  const merged = mergeDayFile(local, remote);
  assert.deepEqual(merged.conflictIds, ['a', 'b']);
});

// ---------------------------------------------------------------- 容错

test('坏行/空文件容错：不抛异常，errors 计数正确', () => {
  const local = [
    encodeRecord(rec({ id: 'good-local' })).trim(),
    'not-json-at-all',
    '{"id":"only-id"}'
  ].join('\n');
  const remote = [encodeRecord(rec({ id: 'good-remote', ts: `${DAY}T10:00:00+08:00` })).trim(), '{broken'].join(
    '\n'
  );

  const stats = mergeRecordLines(local, remote);
  assert.equal(stats.localErrors, 2, '本机两个坏行（非 JSON + 字段不合法）');
  assert.equal(stats.remoteErrors, 1, '远端一个坏行');
  assert.equal(stats.errors, 3);
  assert.deepEqual(
    stats.result.map((record) => record.id),
    ['good-local', 'good-remote'],
    '坏行只跳过，不影响合法行'
  );
});

test('两侧都是空文件：空结果、零错误、空文本，不抛', () => {
  const stats = mergeRecordLines('', '');
  assert.deepEqual(stats.result, []);
  assert.equal(stats.errors, 0);
  assert.equal(stats.conflicts, 0);

  const merged = mergeDayFile('', '');
  assert.equal(merged.text, '');
  assert.deepEqual(merged.conflictIds, []);
});

test('全空行/CRLF 文本：容错且不产生假记录', () => {
  const local = `\n\n  \n${encodeRecord(rec({ id: 'crlf' })).trim()}\r\n`;
  const stats = mergeRecordLines(local, '\n\n');
  assert.deepEqual(
    stats.result.map((record) => record.id),
    ['crlf']
  );
  assert.equal(stats.errors, 0);
});

test('未知扩展字段在合并后保留（不因合并丢历史字段）', () => {
  const legacy = { ...rec({ id: 'legacy', ts: `${DAY}T10:00:00+08:00` }), remindAt: `${DAY}T08:00:00+08:00` };
  // 本机这条更新（ts 更晚）→ 它会胜出，未知字段必须原样跟着走
  const local = `${JSON.stringify(legacy)}\n`;
  const remote = lines(rec({ id: 'legacy', ts: `${DAY}T09:00:00+08:00` }));

  const merged = mergeDayFile(local, remote);
  const rows = merged.text.trim().split('\n');
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0]).ts, `${DAY}T10:00:00+08:00`);
  assert.equal(JSON.parse(rows[0]).remindAt, `${DAY}T08:00:00+08:00`, '未知字段原样透传');
});

test('未知扩展字段跟着胜者走：落败版本里的未知字段随版本一起被折叠掉', () => {
  const legacy = { ...rec({ id: 'legacy', ts: `${DAY}T09:00:00+08:00` }), remindAt: `${DAY}T08:00:00+08:00` };
  const local = `${JSON.stringify(legacy)}\n`;
  const remote = lines(rec({ id: 'legacy', ts: `${DAY}T10:00:00+08:00` }));

  const merged = mergeDayFile(local, remote);
  const rows = merged.text.trim().split('\n');
  assert.equal(rows.length, 1);
  assert.equal(
    'remindAt' in JSON.parse(rows[0]),
    false,
    '较旧版本（含其未知字段）被折叠掉，与 foldById 的语义一致'
  );
});

// ---------------------------------------------------------------- 输出格式与稳定性

test('mergeDayFile：每行都是 encodeRecord 规范格式，末尾恰好一个换行', () => {
  const local = lines(
    rec({ id: 'b', ts: `${DAY}T10:00:00+08:00`, attachments: [{ sha256: 'a'.repeat(64), name: `${'a'.repeat(64)}.png`, pageIndex: 0 }] }),
    rec({ id: 'a', ts: `${DAY}T09:00:00+08:00`, ocr_text: '手写原文', ai_structured: '- 待办' })
  );
  const remote = lines(rec({ id: 'c', ts: `${DAY}T11:00:00+08:00` }));

  const merged = mergeDayFile(local, remote);
  assert.equal(merged.text.endsWith('\n'), true);
  assert.equal(merged.text.endsWith('\n\n'), false, '末尾不能有空行');
  const rows = merged.text.slice(0, -1).split('\n');
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(JSON.parse(row) !== null, true);
    assert.equal(row, encodeRecord(JSON.parse(row)).trim(), '必须是 encodeRecord 的规范结果（幂等）');
  }
  assert.deepEqual(
    rows.map((row) => JSON.parse(row).id),
    ['a', 'b', 'c'],
    '排序：ts 升序 → 同 ts 按 id'
  );
  assert.deepEqual(
    rows.map((row) => JSON.parse(row).ts.slice(11, 13)),
    ['09', '10', '11']
  );
});

test('同 ts 的两条不同 id 记录按 id 升序（与输入顺序无关）', () => {
  const a = rec({ id: 'aaa', ts: `${DAY}T09:00:00+08:00` });
  const z = rec({ id: 'zzz', ts: `${DAY}T09:00:00+08:00` });
  const forward = mergeDayFile(lines(a, z), '').text;
  const backward = mergeDayFile(lines(z, a), '').text;
  assert.equal(forward, backward);
  assert.deepEqual(
    forward
      .trim()
      .split('\n')
      .map((row) => JSON.parse(row).id),
    ['aaa', 'zzz']
  );
});

test('输出稳定：同输入两次逐字节相同，且合并结果可重复合并（幂等）', () => {
  const local = lines(
    rec({ id: 'a', ts: `${DAY}T09:00:00+08:00`, title: '本机' }),
    rec({ id: 'local-only', ts: `${DAY}T08:00:00+08:00` })
  );
  const remote = lines(
    rec({ id: 'a', ts: `${DAY}T10:00:00+08:00`, title: '远端' }),
    rec({ id: 'remote-only', ts: `${DAY}T11:00:00+08:00` })
  );

  const first = mergeDayFile(local, remote);
  const second = mergeDayFile(local, remote);
  assert.equal(first.text, second.text, '同一输入两次调用必须逐字节相同');

  // 把结果当作「新本机」再与同一远端合并：仍然不变（可重复调用）
  const again = mergeDayFile(first.text, remote);
  assert.equal(again.text, first.text);
  assert.equal(again.stats.conflicts, 0);

  // 双方内容都变成合并结果后仍是同一份（收敛）
  const converged = mergeDayFile(first.text, first.text);
  assert.equal(converged.text, first.text);
  assert.equal(converged.stats.duplicates, first.stats.result.length);
});

test('mergeRecordLines 不修改入参文本（纯函数）', () => {
  const local = lines(rec({ id: 'a' }));
  const remote = lines(rec({ id: 'b', ts: `${DAY}T10:00:00+08:00` }));
  const localCopy = local;
  const remoteCopy = remote;
  mergeRecordLines(local, remote);
  assert.equal(local, localCopy);
  assert.equal(remote, remoteCopy);
});
