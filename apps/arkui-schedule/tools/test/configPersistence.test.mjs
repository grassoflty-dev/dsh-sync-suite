// 配置持久化（mod-config-persistence）可执行验证：版本信封 / 旧名链 / 一次性重写 / 两条不变量。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 依据：docs/PERSISTENCE.md 风险 2（无配置 schema 版本）与风险 3（store 改名静默丢配置）、
// docs/DATA-CONTRACT-v2.md §11（版本标记 + 未知版本只读门槛）、model/freshStart.ts（纯决策 + typed 结果）。
// 所有只读源码扫描都是静态守卫：.ets 不在 Node 门闸范围，真机偏好读写仍未装机 / unverified。
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CONFIG_ENVELOPE_KEY,
  CONFIG_SCHEMA_VERSION,
  commitConfigWrite,
  decodeEnvelope,
  encodeEnvelope,
  migrateOnce,
  needsRewrite,
  resolveLegacyChain,
  runWithSeam,
  schemaVersionOf
} from '../.build/model/configSchema.js';

const MAIN = fileURLToPath(new URL('../../entry/src/main/', import.meta.url));
const ETS = join(MAIN, 'ets');

/** 递归收集源码文件（跳过编译缓存 / 构建产物）。 */
function collectFiles(dir, suffixes, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const info = statSync(full);
    if (info.isDirectory()) {
      if (name === 'build' || name === 'cache' || name === '.build') {
        continue;
      }
      collectFiles(full, suffixes, out);
    } else if (suffixes.some((suffix) => full.endsWith(suffix))) {
      out.push(full);
    }
  }
  return out;
}

/** 去掉整行注释，只留代码行：避免注释里的 rawfile 说明被误判成写盘。 */
function codeLines(source) {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^(\/\/|\*|\/\*)/.test(line));
}

/** 注入式存储缝：writeCalls 是可观测的写入次数（首跑 1，第二跑仍 1）。 */
function makeSeam(initial = {}) {
  const map = new Map(Object.entries(initial));
  const state = { writes: 0, map: map };
  const seam = {
    read: (name) => (map.has(name) ? map.get(name) : null),
    write: (name, bytes) => {
      state.writes += 1;
      map.set(name, bytes);
    }
  };
  return { seam: seam, state: state };
}

const NAMES = ['schedule_settings', 'settings_legacy'];

describe('版本信封：与既有 {v:1} 约定同源', () => {
  test('E01 版本常量与 envelope 键固定，写入只含 v → values 两个键', () => {
    assert.equal(CONFIG_SCHEMA_VERSION, 1, '配置信封沿用既有数据信封的起始版本 1');
    assert.equal(CONFIG_ENVELOPE_KEY, 'config.schema', '保留键固定，不与旧扁平键冲突');
    const bytes = encodeEnvelope({ b: '2', a: 1 });
    const parsed = JSON.parse(bytes);
    assert.deepEqual(Object.keys(parsed), ['v', 'values'], '显式写：只有 v 与 values，无额外顶层字段');
    assert.equal(parsed.v, 1);
    assert.deepEqual(Object.keys(parsed.values), ['a', 'b'], '确定性键序');
  });

  test('E02 encode → decode 往返：字符串 / 数字 / 布尔逐项相等，字节确定', () => {
    const values = { token: 'abc-中文', aiTemperature: 0.7, aiFallbackEnabled: false, empty: '' };
    const once = encodeEnvelope(values);
    assert.equal(encodeEnvelope(values), once, '同输入同字节');
    const decoded = decodeEnvelope(once);
    assert.equal(decoded.state, 'ok');
    assert.equal(decoded.version, 1);
    assert.deepEqual(decoded.values, values);
    assert.equal(schemaVersionOf(once), 1);
    assert.deepEqual(values, { token: 'abc-中文', aiTemperature: 0.7, aiFallbackEnabled: false, empty: '' }, '不得改入参');
  });

  test('E03 宽容读：values 里的未知额外键原样保留', () => {
    const raw = JSON.stringify({ v: 1, values: { known: 'x', futureKey: 42, anotherNewKey: true } });
    const decoded = decodeEnvelope(raw);
    assert.equal(decoded.state, 'ok');
    assert.deepEqual(decoded.values, { known: 'x', futureKey: 42, anotherNewKey: true });
  });

  test('E04 空 / 坏 JSON / 非对象 / 坏 values → typed 状态且绝不抛', () => {
    assert.equal(decodeEnvelope('').state, 'empty');
    assert.equal(decodeEnvelope(null).state, 'empty');
    assert.equal(decodeEnvelope(undefined).state, 'empty');
    assert.equal(decodeEnvelope('   ').state, 'empty');
    assert.equal(decodeEnvelope('{bad').state, 'corrupt');
    assert.equal(decodeEnvelope('[]').state, 'corrupt');
    assert.equal(decodeEnvelope('"string"').state, 'corrupt');
    assert.equal(decodeEnvelope(JSON.stringify({ v: 1 })).state, 'corrupt', '信封缺 values 视为坏字节');
    assert.equal(decodeEnvelope(JSON.stringify({ v: 1, values: [] })).state, 'corrupt');
    assert.equal(decodeEnvelope(JSON.stringify({ v: 1, values: { nested: { a: 1 } } })).state, 'corrupt', '非标量 fail-closed');
    for (const raw of ['', '{bad', JSON.stringify({ v: 1, values: { nested: {} } })]) {
      assert.equal(schemaVersionOf(raw), null, '非现行信封没有可报告版本');
    }
  });

  test('E05 未知版本 → typed version-unknown + 版本号；不得按现行信封解析', () => {
    const raw = JSON.stringify({ v: 99, values: { token: 'do-not-touch' } });
    const decoded = decodeEnvelope(raw);
    assert.equal(decoded.state, 'version-unknown');
    assert.equal(decoded.version, 99);
    assert.deepEqual(decoded.values, {}, '拒绝态不泄露值');
    const resolution = resolveLegacyChain([{ name: 'current', raw: raw }]);
    assert.equal(resolution.kind, 'version-unknown');
    assert.equal(resolution.version, 99);
    assert.equal(schemaVersionOf(raw), null);
  });
});

describe('旧名链：当前名优先，空值才回退', () => {
  test('L01 当前名空 → 旧名命中 → 返回旧名的值', () => {
    const legacyRaw = encodeEnvelope({ token: 'legacy-token' });
    const resolution = resolveLegacyChain([
      { name: 'current', raw: '' },
      { name: 'legacy', raw: legacyRaw }
    ]);
    assert.equal(resolution.kind, 'found');
    if (resolution.kind === 'found') {
      assert.equal(resolution.name, 'legacy');
      assert.equal(resolution.decode.state, 'ok');
      assert.equal(resolution.decode.values.token, 'legacy-token');
      assert.deepEqual(resolution.tried, ['current', 'legacy']);
    }
  });

  test('L02 当前名是未知版本时立即 typed 拒绝，不跨过未知字节去找旧名', () => {
    const resolution = resolveLegacyChain([
      { name: 'current', raw: JSON.stringify({ v: 7, values: { token: 'x' } }) },
      { name: 'legacy', raw: encodeEnvelope({ token: 'good' }) }
    ]);
    assert.equal(resolution.kind, 'version-unknown');
    if (resolution.kind === 'version-unknown') {
      assert.equal(resolution.name, 'current');
      assert.equal(resolution.version, 7);
    }
  });

  test('L03 全空 → missing；坏字节 → corrupt（都是 typed，不抛）', () => {
    assert.equal(resolveLegacyChain([{ name: 'a', raw: '' }, { name: 'b', raw: '   ' }]).kind, 'missing');
    assert.equal(resolveLegacyChain([]).kind, 'missing');
    const corrupt = resolveLegacyChain([{ name: 'a', raw: '{broken' }]);
    assert.equal(corrupt.kind, 'corrupt');
    if (corrupt.kind === 'corrupt') {
      assert.equal(corrupt.name, 'a');
    }
  });
});

describe('一次性重写：幂等、额外键保留、失败零写入', () => {
  test('M01 migrateOnce：已是 v1 信封 → no-write（第二次运行证明）', () => {
    const raw = encodeEnvelope({ token: 'already' });
    const resolution = resolveLegacyChain([{ name: 'current', raw: raw }]);
    const decision = migrateOnce(resolution, 'current');
    assert.equal(decision.kind, 'no-write');
    if (decision.kind === 'no-write') {
      assert.equal(decision.reason, 'already-versioned');
    }
    assert.equal(needsRewrite(resolution, 'current').kind, 'no-write');
  });

  test('M02 migrateOnce：legacy 有值 → write，字节是规范信封', () => {
    const resolution = resolveLegacyChain([{ name: 'current', raw: JSON.stringify({ token: 't', branch: 'main' }) }]);
    const decision = migrateOnce(resolution, 'current');
    assert.equal(decision.kind, 'write');
    if (decision.kind === 'write') {
      assert.equal(decision.target, 'current');
      assert.deepEqual(JSON.parse(decision.bytes), { v: 1, values: { branch: 'main', token: 't' } });
    }
  });

  test('M03 首装 legacy 存储：注入 seam 首跑写一次，第二跑 no-write（write count = 1）', () => {
    // 首装现场：只有旧扁平表，没有版本标记。
    const { seam, state } = makeSeam({
      schedule_settings: JSON.stringify({ token: 'first-install', aiTemperature: 0.7 })
    });
    const first = runWithSeam(seam, NAMES, 'schedule_settings');
    assert.equal(first.decision.kind, 'write');
    assert.equal(first.wrote, true);
    assert.equal(state.writes, 1, '首跑恰好一次写入');
    assert.equal(decodeEnvelope(state.map.get('schedule_settings')).state, 'ok');
    assert.equal(state.map.get('schedule_settings'), encodeEnvelope({ token: 'first-install', aiTemperature: 0.7 }));

    const second = runWithSeam(seam, NAMES, 'schedule_settings');
    assert.equal(second.decision.kind, 'no-write', '第二跑必须判「无需写」');
    if (second.decision.kind === 'no-write') {
      assert.equal(second.decision.reason, 'already-versioned');
    }
    assert.equal(second.wrote, false);
    assert.equal(state.writes, 1, '第二跑写入次数仍为 1 —— 幂等的可观测证明');
  });

  test('M04 额外键经重写完整保留：未知键不丢、不改名', () => {
    const legacy = { known: 'v', futureKey: 123, oddName: false, author: '我' };
    const { seam, state } = makeSeam({ schedule_settings: JSON.stringify(legacy) });
    runWithSeam(seam, NAMES, 'schedule_settings');
    const decoded = decodeEnvelope(state.map.get('schedule_settings'));
    assert.deepEqual(decoded.values, legacy);
    assert.equal(Object.keys(decoded.values).length, 4);
  });

  test('M05 空 legacy 表与全空候选都不建空信封', () => {
    const emptyMap = migrateOnce(
      resolveLegacyChain([{ name: 'current', raw: '{}' }]),
      'current'
    );
    assert.equal(emptyMap.kind, 'no-write');
    if (emptyMap.kind === 'no-write') {
      assert.equal(emptyMap.reason, 'legacy-empty');
    }
    const { seam, state } = makeSeam({});
    const outcome = runWithSeam(seam, NAMES, 'schedule_settings');
    assert.equal(outcome.decision.kind, 'no-write');
    assert.equal(state.writes, 0);
  });

  test('F01 坏信封绝不覆盖好字节：原字节逐字节相等', () => {
    const good = encodeEnvelope({ token: 'good-bytes' });
    const { seam, state } = makeSeam({ schedule_settings: '{broken', settings_legacy: good });
    const outcome = runWithSeam(seam, NAMES, 'schedule_settings');
    assert.equal(outcome.decision.kind, 'refuse');
    if (outcome.decision.kind === 'refuse') {
      assert.equal(outcome.decision.reason, 'corrupt');
    }
    assert.equal(state.writes, 0);
    assert.equal(state.map.get('schedule_settings'), '{broken', '坏字节原样保留');
    assert.equal(state.map.get('settings_legacy'), good, '好字节不被波及');
  });

  test('F02 未知版本 → typed refuse + 零写入；当前名字节原样', () => {
    const raw = JSON.stringify({ v: 42, values: { token: 'x' } });
    const { seam, state } = makeSeam({ schedule_settings: raw, settings_legacy: encodeEnvelope({ token: 'y' }) });
    const outcome = runWithSeam(seam, NAMES, 'schedule_settings');
    assert.equal(outcome.decision.kind, 'refuse');
    if (outcome.decision.kind === 'refuse') {
      assert.equal(outcome.decision.reason, 'version-unknown');
      assert.match(outcome.decision.message, /未知配置版本 42/);
    }
    assert.equal(outcome.wrote, false);
    assert.equal(state.writes, 0);
    assert.equal(state.map.get('schedule_settings'), raw);
  });

  test('F03 读 / 写抛错都只落到 typed refuse，不向 UI 抛异常', () => {
    const { seam, state } = makeSeam({ schedule_settings: JSON.stringify({ token: 'keep' }) });
    const readThrow = {
      read: (name) => {
        if (name === 'settings_legacy') {
          throw new Error('storage down');
        }
        return seam.read(name);
      },
      write: seam.write
    };
    const a = runWithSeam(readThrow, NAMES, 'schedule_settings');
    assert.equal(a.decision.kind, 'refuse');
    if (a.decision.kind === 'refuse') {
      assert.equal(a.decision.reason, 'storage-unavailable');
    }
    assert.equal(state.writes, 0);

    const writeThrow = {
      read: seam.read,
      write: () => {
        throw new Error('write denied');
      }
    };
    const b = runWithSeam(writeThrow, NAMES, 'schedule_settings');
    assert.equal(b.decision.kind, 'refuse');
    if (b.decision.kind === 'refuse') {
      assert.equal(b.decision.reason, 'storage-unavailable');
    }
    assert.equal(b.wrote, false);
    assert.equal(state.map.get('schedule_settings'), JSON.stringify({ token: 'keep' }));
  });
});

describe('PERSISTENCE.md 两条不变量（源码扫描守卫）', () => {
  const sources = collectFiles(MAIN, ['.ets', '.ts', '.js']).map((file) => ({
    file: file,
    source: readFileSync(file, 'utf8')
  }));

  test('I01 绝不把用户配置写进 rawfile/：所有 $rawfile( 引用都是只读 Web src，无写目标', () => {
    const hits = [];
    for (const item of sources) {
      item.source.split('\n').forEach((line, index) => {
        if (line.includes('$rawfile(')) {
          hits.push({ file: item.file, line: index + 1, text: line.trim() });
        }
      });
    }
    assert.ok(hits.length >= 2, `应至少扫到 GitBridgeHost / SyncSection 两处只读引用，实际 ${hits.length}`);
    for (const hit of hits) {
      assert.match(hit.text, /Web\(\s*\{\s*src:\s*\$rawfile\(/, `${hit.file}:${hit.line} 必须是 Web 的只读 src`);
      assert.doesNotMatch(hit.text, /\b(write|put|append|save|create|unlink|remove|mkdir)\w*\s*\(/, '同一行不得是写 API');
    }
    // 任何代码行都不得把 rawfile 路径交给写 API（含新出现的写盘实现）。
    for (const item of sources) {
      for (const line of codeLines(item.source)) {
        assert.doesNotMatch(line, /(write\w*|put\w*|append\w*|mkdir\w*|unlink\w*)\s*\([^)]*rawfile/i, `${item.file} 出现 rawfile 写目标：${line}`);
        assert.doesNotMatch(line, /rawfile[^\n]*\.\s*(write|put|append)\s*\(/i, `${item.file} 出现 rawfile 写调用：${line}`);
      }
    }
    // 三个已知锚点仍在：两处只读 Web 加载 + gitRunner 的只读桥注释。
    const anchors = [
      'ets/components/GitBridgeHost.ets',
      'ets/components/settings/SyncSection.ets',
      'ets/services/gitRunner.ets'
    ];
    for (const rel of anchors) {
      const item = sources.find((entry) => entry.file.endsWith(rel.replace(/\//g, '\\')) || entry.file.endsWith(rel));
      assert.ok(item, `${rel} 必须存在`);
      assert.match(item.source, /rawfile/i, `${rel} 的 rawfile 锚点不得丢失`);
    }
  });

  test('I02 绝不把配置只存进 git 仓库：四个配置 store 各有 preferences / PersistentStorage 落点', () => {
    const stores = [
      ['settingsStore', 'services\\settingsStore.ets', /preferences\.getPreferences\s*\(/, /['"]schedule_settings['"]/],
      ['syncController', 'services\\syncController.ets', /preferences\.getPreferences\s*\(/, /['"]git_sync_extras['"]/],
      ['instanceStore', 'services\\instanceStore.ets', /PersistentStorage\.persistProp\s*</, /['"]instances\.json['"]/],
      ['instanceGrantStore', 'services\\instanceGrantStore.ets', /PersistentStorage\.persistProp\s*</, /['"]instance-grants\.json['"]/]
    ];
    for (const [label, rel, home, key] of stores) {
      const item = sources.find((entry) => entry.file.endsWith(rel));
      assert.ok(item, `${label} 源文件必须存在：${rel}`);
      assert.match(item.source, home, `${label} 必须有 preferences / PersistentStorage 落点`);
      assert.match(item.source, key, `${label} 必须有专用 store 键`);
    }
  });
});

describe('configStore.ets 接缝守卫（只做 IO，判定全在纯层）', () => {
  test('S01 未知版本零写入：服务层只经 resolveLegacyChain / runWithSeam，写只在 wrote 分支', () => {
    const source = readFileSync(join(ETS, 'services', 'configStore.ets'), 'utf8');
    assert.match(source, /\.\.\/model\/configSchema/, '必须复用纯层，不得复制版本判定');
    assert.match(source, /resolveLegacyChain\s*\(/, '旧名链走纯函数');
    assert.match(source, /runWithSeam\s*\(/, '一次性重写走纯决策');
    assert.match(source, /needsRewrite as decideRewrite/, 'needsRewrite 暴露给调用方');
    assert.match(source, /if \(outcome\.wrote\)/, '只有 wrote=true 才 flush');
    assert.match(source, /kind: 'storage-unavailable'/, '存储异常也是 typed 结果');
    assert.doesNotMatch(source, /console\.|hilog\./, '服务层不打印配置（凭据只在本机）');
    for (const rel of [
      'services\\settingsStore.ets',
      'services\\syncController.ets',
      'services\\instanceStore.ets',
      'services\\instanceGrantStore.ets'
    ]) {
      assert.doesNotMatch(source, new RegExp(rel.replace(/\\/g, '\\\\')), `本轮不得接线进 ${rel}`);
    }
  });
});

// ============================================================================
// mod-config-persistence-wiring：真规格接线 / 写穿回环 / 独立键 / 失败只读守卫。
// .ets 不在 Node 门闸范围，故真实 spec 与写盘路径只做源码形状断言；
// 信封本身的可观测行为用纯层做等价模拟（与 configStore 的 seam 同一套纯函数）。
// ============================================================================

const SETTINGS_ETS = readFileSync(join(ETS, 'services', 'settingsStore.ets'), 'utf8');
const SYNC_ETS = readFileSync(join(ETS, 'services', 'syncController.ets'), 'utf8');
/** 本模块全部源码（守卫「只有指定文件打开指定 store 名」用）。 */
const ALL_SRC = collectFiles(MAIN, ['.ets', '.ts', '.js']).map((file) => ({
  file: file,
  source: readFileSync(file, 'utf8')
}));

/** 与 settingsStorePairing.test.mjs 同一口径：截到下一个方法 / 顶层注释。 */
function methodBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `找不到方法：${signature}`);
  const rest = source.slice(start + signature.length);
  const end = rest.search(/\n {2}(?:async |private |\/\*\*)/);
  return end < 0 ? rest : rest.slice(0, end);
}

/** 截出两个标记之间的文本（用于 spec / 编码助手函数体）。 */
function between(source, startMark, endMark) {
  const start = source.indexOf(startMark);
  assert.ok(start >= 0, `找不到起点：${startMark}`);
  const end = source.indexOf(endMark, start + startMark.length);
  assert.ok(end >= 0, `找不到终点：${endMark}`);
  return source.slice(start, end);
}

const SETTINGS_SPEC = between(SETTINGS_ETS, 'export const SETTINGS_CONFIG_SPEC', '\n};');
const SYNC_SPEC = between(SYNC_ETS, 'export const GIT_EXTRAS_CONFIG_SPEC', '\n};');
const SETTINGS_ENVELOPE_FN = between(SETTINGS_ETS, 'function settingsEnvelopeBytes(', '\n}');
const SYNC_ENVELOPE_FN = between(SYNC_ETS, 'function extrasEnvelopeBytes(', '\n}');
const SETTINGS_SAVE = methodBody(SETTINGS_ETS, 'async save(');
const SETTINGS_SYNC_SAVE = methodBody(SETTINGS_ETS, 'async saveSyncState(');
const SYNC_SAVE = methodBody(SYNC_ETS, 'async save(');

/** 列出源码里所有 `const KEY_X: string = '...';` 的常量名 → 存储键。 */
function keyConstants(source) {
  const result = new Map();
  const pattern = /const\s+(KEY_[A-Z0-9_]+)\s*:\s*string\s*=\s*'([^']+)'\s*;/g;
  let matched;
  while ((matched = pattern.exec(source)) !== null) {
    result.set(matched[1], matched[2]);
  }
  return result;
}

describe('接线规格：两个真 spec（只登记真实存在的事实）', () => {
  test('W01 settingsStore 真规格：当前名 + 空旧名链 + 40 个整表键，aiModelsCache 排除', () => {
    assert.match(SETTINGS_SPEC, /name:\s*PREFERENCES_NAME/, '当前名取常量，不重写字面量');
    assert.match(SETTINGS_ETS, /const PREFERENCES_NAME: string = 'schedule_settings';/);
    assert.match(SETTINGS_SPEC, /legacyNames:\s*\[\s*\]/, '仓库从未改过此名：旧名链为空，绝不臆造');
    const keys = keyConstants(SETTINGS_ETS);
    const listed = [...SETTINGS_SPEC.matchAll(/KEY_[A-Z0-9_]+/g)].map((m) => m[0]);
    // 整表键一个不漏（复用 settingsStorePairing 的「每个 KEY 都成对」清单口径）。
    for (const constant of keys.keys()) {
      if (constant === 'KEY_AI_MODELS_CACHE') {
        continue;
      }
      assert.ok(listed.includes(constant), `真规格漏登记 ${constant}（${keys.get(constant)}）`);
    }
    assert.equal(listed.length, 40, '整表恰好 40 个旧扁平键');
    assert.equal(listed.includes('KEY_AI_MODELS_CACHE'), false, '模型缓存键不得进信封规格');
  });

  test('W02 syncController 真规格：当前名 + 空旧名链 + 恰好三个扩展键', () => {
    assert.match(SYNC_SPEC, /name:\s*EXTRAS_PREFS_NAME/);
    assert.match(SYNC_ETS, /const EXTRAS_PREFS_NAME: string = 'git_sync_extras';/);
    assert.match(SYNC_SPEC, /legacyNames:\s*\[\s*\]/, '同样不臆造历史 store 名');
    assert.deepEqual(
      [...SYNC_SPEC.matchAll(/KEY_[A-Z0-9_]+/g)].map((m) => m[0]),
      ['KEY_BRANCH', 'KEY_PLATFORM', 'KEY_PLATFORM_TOUCHED'],
      'branch / platform / platformTouched 三个键，不多不少'
    );
  });

  test('W03 真实接线形状：migrateOnce 在首个 prefs.get 之前，且只有各自文件打开该 store 名', () => {
    for (const [label, source, spec] of [
      ['settingsStore', SETTINGS_ETS, 'createConfigStore(SETTINGS_CONFIG_SPEC)'],
      ['syncController', SYNC_ETS, 'createConfigStore(GIT_EXTRAS_CONFIG_SPEC)']
    ]) {
      const migrateAt = source.indexOf('configStore.migrateOnce(');
      const firstGetAt = source.indexOf('prefs.get(');
      assert.ok(migrateAt > 0, `${label} 必须在首次加载前调用 migrateOnce`);
      assert.ok(firstGetAt > migrateAt, `${label} 的 migrateOnce 必须早于首个 prefs.get`);
      assert.ok(source.includes(spec), `${label} 必须由真 spec 构造版本访问器`);
      const openCalls = [...source.matchAll(/preferences\.getPreferences\s*\(/g)];
      assert.equal(openCalls.length, 1, `${label} 只能有一处 getPreferences 落点`);
    }
    // 「没有别的入口偷偷开同一个 store」：源码里带引号的 store 名各只有一个文件。
    for (const [literal, owner] of [
      ["'schedule_settings'", 'services\\settingsStore.ets'],
      ["'git_sync_extras'", 'services\\syncController.ets']
    ]) {
      const owners = ALL_SRC.filter((item) => item.source.includes(literal)).map((item) => item.file);
      assert.deepEqual(owners.length, 1, `${literal} 只能出现在一个源码文件，实际 ${owners.length}`);
      assert.ok(owners[0].endsWith(owner), `${literal} 的唯一落点必须是 ${owner}`);
    }
  });
});

describe('写穿回环：保存即更新信封，新实例读到新值', () => {
  test('W04 两条保存路径都写信封：一次编码 + 一个键 put + 一次 flush', () => {
    for (const [label, body, fn] of [
      ['settingsStore.save()', SETTINGS_SAVE, SETTINGS_ENVELOPE_FN],
      ['settingsStore.saveSyncState()', SETTINGS_SYNC_SAVE, SETTINGS_ENVELOPE_FN],
      ['syncController.save()', SYNC_SAVE, SYNC_ENVELOPE_FN]
    ]) {
      assert.equal(
        [...body.matchAll(/prefs\.put\(CONFIG_ENVELOPE_KEY,/g)].length,
        1,
        `${label} 每笔保存恰好一次信封 put（不是每个键重编码一遍）`
      );
      assert.equal([...body.matchAll(/prefs\.flush\(\)/g)].length, 1, `${label} 只 flush 一次`);
      assert.match(body, /if \(this\.envelopeWritable\)/, `${label} 必须受拒绝态闸门保护`);
      assert.equal([...fn.matchAll(/encodeEnvelope\(/g)].length, 1, '编码助手每调用只编码一次');
    }
  });

  test('W05 写穿 round-trip：迁移 → 保存改值 → 新实例从信封读回 → 二次 needsRewrite=false', () => {
    // 首装：只有旧扁平表，干净地一次性写成 v1 信封。
    const legacy = { deviceId: 'phone-a', token: 'old-token', aiTemperature: 0.7 };
    const { seam, state } = makeSeam({ [NAMES[0]]: JSON.stringify(legacy) });
    const first = runWithSeam(seam, NAMES, NAMES[0]);
    assert.equal(first.wrote, true);
    assert.equal(decodingValues(state.map.get(NAMES[0])).token, 'old-token');

    // 正常保存路径：把改后的整表值再写一次信封（与 save() 的 write-through 等价）。
    const changed = { ...decodingValues(state.map.get(NAMES[0])), token: 'new-token' };
    seam.write(NAMES[0], encodeEnvelope(changed));
    assert.equal(state.writes, 2, '一次迁移 + 一次保存 = 两次写，没有额外重写风暴');

    // 新实例：只读信封就能拿到保存后的值；值确实来自信封而不是内存缓存。
    const reopened = decodeEnvelope(state.map.get(NAMES[0]));
    assert.equal(reopened.state, 'ok');
    assert.equal(reopened.values.token, 'new-token');
    assert.equal(reopened.values.deviceId, 'phone-a', '未改字段不丢');

    // 第二次运行不再重写（needsRewrite 的纯判定与 migrateOnce 同源）。
    const second = runWithSeam(seam, NAMES, NAMES[0]);
    assert.equal(second.decision.kind, 'no-write');
    assert.equal(second.wrote, false);
    assert.equal(state.writes, 2, '第二跑写入次数仍为 2 —— 幂等的可观测证明');
  });

  test('W06 二次 needsRewrite 为 already-versioned：新实例不会再次改写用户字节', () => {
    const bytes = encodeEnvelope({ branch: 'main', platform: 'gitee', platformTouched: true });
    const resolution = resolveLegacyChain([{ name: 'git_sync_extras', raw: bytes }]);
    const decision = needsRewrite(resolution, 'git_sync_extras');
    assert.equal(decision.kind, 'no-write');
    if (decision.kind === 'no-write') {
      assert.equal(decision.reason, 'already-versioned');
    }
    assert.equal(migrateOnce(resolution, 'git_sync_extras').kind, 'no-write');
  });
});

/** decode 现行信封并取值：非 ok 态直接断言失败，避免测试静默走空表。 */
function decodingValues(raw) {
  const decoded = decodeEnvelope(raw);
  assert.equal(decoded.state, 'ok');
  return decoded.values;
}

describe('aiModelsCache 独立：不进信封，旧路径照常读', () => {
  test('W07 独立键既不进真规格，也不进编码助手；自有 get/put 成对保留', () => {
    assert.equal(SETTINGS_SPEC.includes('KEY_AI_MODELS_CACHE'), false, '规格里没有这个键');
    assert.equal(SETTINGS_ENVELOPE_FN.includes('KEY_AI_MODELS_CACHE'), false, '编码助手不写这个键');
    assert.equal(SETTINGS_ENVELOPE_FN.includes('aiModelsCache'), false, '字面量也不得出现');
    const loadCache = methodBody(SETTINGS_ETS, 'async loadAiModelsCache(');
    const saveCache = methodBody(SETTINGS_ETS, 'async saveAiModelsCache(');
    assert.match(loadCache, /prefs\.get\(KEY_AI_MODELS_CACHE, ''\)/, '缓存读取保持独立路径');
    assert.match(saveCache, /prefs\.put\(KEY_AI_MODELS_CACHE, encodeAiModelsCache\(next\)\)/, '缓存写入保持独立路径');
    for (const [label, body] of [
      ['load()', methodBody(SETTINGS_ETS, 'async load(')],
      ['save()', SETTINGS_SAVE],
      ['saveSyncState()', SETTINGS_SYNC_SAVE]
    ]) {
      assert.equal(body.includes('KEY_AI_MODELS_CACHE'), false, `${label} 不得覆盖模型缓存`);
    }
    // 纯层等价：真规格登记的键全进表，编码后表里仍没有 aiModelsCache。
    const values = {};
    for (const constant of [...SETTINGS_SPEC.matchAll(/KEY_[A-Z0-9_]+/g)].map((m) => m[0])) {
      values[constant] = 'x';
    }
    assert.equal(Object.keys(values).length, 40);
    assert.equal(decodingValues(encodeEnvelope(values)).aiModelsCache, undefined);
  });
});

describe('拒绝态与行为保持：字节不动、旧路径可读、patch 语义不变', () => {
  test('W08 未知版本：原字节逐字不动，且旧扁平表读路径仍返回全部值', () => {
    const unknown = JSON.stringify({ v: 99, values: { token: 'do-not-touch' } });
    const flat = { branch: 'main', platform: 'github', platformTouched: false };
    const { seam, state } = makeSeam({ git_sync_extras: unknown });
    const outcome = runWithSeam(seam, ['git_sync_extras'], 'git_sync_extras');
    assert.equal(outcome.decision.kind, 'refuse');
    assert.equal(state.writes, 0);
    assert.equal(state.map.get('git_sync_extras'), unknown, '未知信封一个字节都不改');

    // 应用仍走老扁平路径：load() 依旧 prefs.get 三个键，不受信封拒绝影响。
    const syncLoad = methodBody(SYNC_ETS, 'async load(');
    for (const key of ['KEY_BRANCH', 'KEY_PLATFORM', 'KEY_PLATFORM_TOUCHED']) {
      assert.match(syncLoad, new RegExp(`prefs\\.get\\(${key},`), `老路径仍读 ${key}`);
    }
    assert.deepEqual(decodeEnvelope(JSON.stringify(flat)).values, flat, '旧扁平表在纯层仍可完整读出');
    assert.equal(decodeEnvelope(unknown).state, 'version-unknown', '拒绝态不泄露值');
    for (const source of [SETTINGS_ETS, SYNC_ETS]) {
      assert.match(source, /this\.envelopeWritable = outcome\.decision\.kind !== 'refuse'/, '拒绝态关掉写穿闸门');
    }
  });

  test('W09 patch 语义与字段集合保持：未传字段沿用 current，整表键仍成对', () => {
    // 复用 settingsStorePairing 的成对口径：每个整表键仍在 save()/saveSyncState() 里 put。
    for (const [constant] of keyConstants(SETTINGS_ETS)) {
      if (constant === 'KEY_AI_MODELS_CACHE') {
        continue;
      }
      assert.ok(
        SETTINGS_SAVE.includes(`prefs.put(${constant}`) || SETTINGS_SYNC_SAVE.includes(`prefs.put(${constant}`),
        `写穿不得让 ${constant} 从保存路径消失`
      );
    }
    // 「没传就不改」的判别式逐项保留（挑代表性的字符串 / 数字 / 布尔 / 同步态字段）。
    for (const field of ['deviceId', 'deviceFingerprint', 'deviceUuid', 'token', 'aiKey', 'author', 'remoteUrl', 'remoteToken', 'remoteLastOk']) {
      assert.match(
        SETTINGS_SAVE,
        new RegExp(`patch\\.${field}\\s*===\\s*undefined\\s*\\?\\s*current\\.${field}`),
        `save() 必须保留 ${field} 的缺省沿用语义`
      );
    }
    assert.match(SETTINGS_SAVE, /aiTemperature === undefined \? current\.aiTemperature/, '数字参数同样沿用');
    assert.match(SETTINGS_SAVE, /penOnlyInput === undefined \? current\.penOnlyInput/, '布尔参数同样沿用');
    assert.match(SETTINGS_SYNC_SAVE, /patch\.lastSyncAt === undefined \? current\.lastSyncAt/, '同步态单独路径不变');
    // 两个公开接口形状不缩水（字段只增不减；这里一对一比对现行数量）。
    const patchBlock = between(SETTINGS_ETS, 'export interface SettingsPatch', '\n}');
    const settingsBlock = between(SETTINGS_ETS, 'export interface ScheduleSettings', '\n}');
    // 字段名含数字（remoteIpv6Address），正则必须允许 0-9，否则会假报少一个字段。
    assert.equal([...patchBlock.matchAll(/^\s{2}[a-zA-Z][a-zA-Z0-9]*\??:/gm)].length, 37, 'SettingsPatch 37 字段不变');
    assert.equal([...settingsBlock.matchAll(/^\s{2}[a-zA-Z][a-zA-Z0-9]*:/gm)].length, 40, 'ScheduleSettings 40 字段不变');
  });

  test('W10 防御路径：适配层抛错也照常 init / 读老值，needsRewrite 不成写环', () => {
    // 源码形状：migrateOnce 被 try 包住，catch 关闸门，之后才打开 prefs（首屏不被迁移失败挡住）。
    for (const [label, source] of [
      ['settingsStore', SETTINGS_ETS],
      ['syncController', SYNC_ETS]
    ]) {
      const init = methodBody(source, 'async init(');
      const tryAt = init.indexOf('try {');
      const migrateAt = init.indexOf('configStore.migrateOnce(');
      const catchAt = init.indexOf('} catch {');
      const openAt = init.indexOf('preferences.getPreferences(');
      assert.ok(tryAt >= 0 && migrateAt > tryAt, `${label} 的 migrateOnce 必须在 try 内`);
      assert.ok(catchAt > migrateAt, `${label} 必须有 catch 吞掉适配层失败`);
      assert.ok(openAt > catchAt, `${label} 必须失败后仍打开 prefs，首屏照常读老值`);
      assert.match(
        init.slice(catchAt),
        /this\.envelopeWritable = false/,
        `${label} 的 catch 必须关掉写穿闸门，绝不覆盖未知字节`
      );
      // 只在 init 调一次：没有按次读取重试，就不会在失败时反复触发写。
      assert.equal([...source.matchAll(/configStore\.migrateOnce\(/g)].length, 1, `${label} 不得每次读都重试迁移`);
    }
    assert.match(methodBody(SETTINGS_ETS, 'async load('), /prefs\.get\(KEY_DEVICE_ID,/, '失败后仍走老扁平键');

    // 纯层等价：迁移写盘抛错 → typed refuse + 零写入 + 原字节逐字保留。
    const flat = { deviceId: 'phone-a', token: 'legacy-token' };
    const bytes = JSON.stringify(flat);
    const { seam, state } = makeSeam({ [NAMES[0]]: bytes });
    const throwing = {
      read: seam.read,
      write: () => {
        // 模拟适配层 put/flush 直接抛错或 reject（调用方 try/catch 会吞掉）。
        throw new Error('adapter rejected');
      }
    };
    const outcome = runWithSeam(throwing, NAMES, NAMES[0]);
    assert.equal(outcome.decision.kind, 'refuse');
    assert.equal(outcome.wrote, false);
    assert.equal(state.writes, 0);
    assert.equal(state.map.get(NAMES[0]), bytes, '失败迁移一个字节都不改');

    // 老路径仍然读得到值；needsRewrite 是纯判定（仍判 write，但零 IO），
    // 不会自己写盘成环；两个 store 也只在 init 调一次 migrateOnce，没有任何按次重试。
    const resolution = resolveLegacyChain([{ name: NAMES[0], raw: bytes }]);
    assert.equal(resolution.kind, 'found');
    if (resolution.kind === 'found') {
      assert.deepEqual(resolution.decode.values, flat, '老扁平表读路径返回全部值');
    }
    for (let i = 0; i < 3; i++) {
      assert.equal(needsRewrite(resolution, NAMES[0]).kind, 'write', '字节没变就仍判需重写，但这是纯决策');
    }
    assert.equal(state.writes, 0, 'needsRewrite 反复调用也不产生任何写盘，不成写环');
    for (const [label, source] of [
      ['settingsStore', SETTINGS_ETS],
      ['syncController', SYNC_ETS]
    ]) {
      assert.equal([...source.matchAll(/needsRewrite\s*\(/g)].length, 0, `${label} 不得在读路径轮询 needsRewrite`);
    }
  });
});

// ============================================================================
// REVIEW M1：适配层 put / flush 的 Promise rejection 必须闭环，不得在启动期逃逸。
// 纯层 commitConfigWrite 是可 Node 直测的真实守卫；configStore.ets 只把缝接进去。
// ============================================================================

const REVIEW_WRITE_DECISION = migrateOnce(
  resolveLegacyChain([{ name: NAMES[0], raw: JSON.stringify({ token: 'legacy' }) }]),
  NAMES[0]
);

describe('REVIEW M1：异步 put / flush 拒绝不逃逸（适配层守卫）', () => {
  test('A01 envelope put 拒绝 → typed refuse / wrote=false / 不 flush 半截状态 / 原字节不变', async () => {
    assert.equal(REVIEW_WRITE_DECISION.kind, 'write');
    const legacyRaw = JSON.stringify({ token: 'legacy' });
    const map = new Map([[CONFIG_ENVELOPE_KEY, ''], [NAMES[0], legacyRaw]]);
    let puts = 0;
    let writeFlushes = 0;
    let restoreFlushes = 0;
    let restores = 0;
    const result = await commitConfigWrite(
      REVIEW_WRITE_DECISION,
      async () => {
        puts += 1;
        // 真实适配层里 put 失败即不调用 flush；这里直接抛错模拟同一路径。
        throw new Error('put rejected');
      },
      async () => {
        restores += 1;
        map.set(CONFIG_ENVELOPE_KEY, ''); // 重写前保留键为空；旧扁平键从未被触碰
        restoreFlushes += 1;
      }
    );
    assert.equal(result.decision.kind, 'refuse');
    if (result.decision.kind === 'refuse') {
      assert.equal(result.decision.reason, 'storage-unavailable');
    }
    assert.equal(result.wrote, false, '失败绝不报告已写');
    assert.equal(puts, 1);
    assert.equal(writeFlushes, 0, 'put 失败后没有 flush 半截状态（提交路径根本没走到 flush）');
    assert.equal(restoreFlushes, 1, '只允许回滚路径 flush 一次');
    assert.equal(restores, 1);
    assert.equal(map.get(CONFIG_ENVELOPE_KEY), '', '保留键恢复为空');
    assert.equal(map.get(NAMES[0]), legacyRaw, '旧扁平表字节逐字不变');
  });

  test('A02 flush 拒绝 → typed refuse / wrote=false / 保留键回滚为空', async () => {
    const legacyRaw = JSON.stringify({ token: 'legacy' });
    const map = new Map([[CONFIG_ENVELOPE_KEY, ''], [NAMES[0], legacyRaw]]);
    let flushes = 0;
    let restores = 0;
    const result = await commitConfigWrite(
      REVIEW_WRITE_DECISION,
      async () => {
        map.set(CONFIG_ENVELOPE_KEY, 'half-state');
        flushes += 1;
        throw new Error('flush rejected');
      },
      async () => {
        restores += 1;
        map.set(CONFIG_ENVELOPE_KEY, '');
        flushes += 1;
      }
    );
    assert.equal(result.decision.kind, 'refuse');
    assert.equal(result.wrote, false);
    assert.equal(restores, 1);
    assert.equal(flushes, 2, '失败 flush + 回滚 flush 各一次');
    assert.equal(map.get(CONFIG_ENVELOPE_KEY), '');
    assert.equal(map.get(NAMES[0]), legacyRaw);
  });

  test('A03 连回滚也拒绝 → 仍不抛、typed refuse / wrote=false', async () => {
    const result = await commitConfigWrite(
      REVIEW_WRITE_DECISION,
      async () => {
        throw new Error('put rejected');
      },
      async () => {
        throw new Error('restore rejected too');
      }
    );
    assert.equal(result.decision.kind, 'refuse');
    if (result.decision.kind === 'refuse') {
      assert.equal(result.decision.reason, 'storage-unavailable');
    }
    assert.equal(result.wrote, false);
  });

  test('A04 put + flush 都成功 → wrote=true、决策原样保留', async () => {
    const map = new Map([[CONFIG_ENVELOPE_KEY, '']]);
    let flushes = 0;
    const result = await commitConfigWrite(
      REVIEW_WRITE_DECISION,
      async () => {
        map.set(CONFIG_ENVELOPE_KEY, REVIEW_WRITE_DECISION.bytes);
        flushes += 1;
      },
      async () => {
        assert.fail('成功路径不得回滚');
      }
    );
    assert.equal(result.decision.kind, 'write');
    assert.equal(result.wrote, true);
    assert.equal(map.get(CONFIG_ENVELOPE_KEY), REVIEW_WRITE_DECISION.bytes);
    assert.equal(flushes, 1);
  });

  test('A05 configStore.ets 源码守卫：异步提交在 try/catch 内，失败映射 typed refuse', () => {
    const source = readFileSync(join(ETS, 'services', 'configStore.ets'), 'utf8');
    assert.match(source, /commitConfigWrite\s*\(/, '适配层必须复用纯层异步守卫');
    assert.match(source, /try \{[\s\S]*?commitConfigWrite\([\s\S]*?\} catch \{/, 'await 提交被 try/catch 包住');
    assert.match(source, /store\.put\(CONFIG_ENVELOPE_KEY, ''\)/, '失败时保留键恢复为空（旧扁平键不动）');
    assert.match(source, /wrote: false/, '失败结果 wrote=false');
    assert.match(source, /reason: 'storage-unavailable'/, '存储失败是 typed refuse');
  });
});
