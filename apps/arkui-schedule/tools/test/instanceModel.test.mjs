// `mod-instance-model`：实例模型 + 信封 + 打码 + 排序 + 可达更新 + 存储源码守卫。
//
// 前置：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 纯模型 `model/instances.ts` 有相对 import（remoteAccess / remoteUrl / sha256），
// 编译产物是扩展名省略的 ES import，故用 registerHooks 补 `.js`（与本仓其它测试同法）。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.js')) {
        return nextResolve(`${specifier}.js`, context);
      }
      throw error;
    }
  }
});

const M = await import('../.build/model/instances.js');

// mod-instances-drop-local：本机实例已删除。原测试 id 全部保留，断言 retarget 为
// 「无本机原语 / 遗留 local 行读取时过滤 / 排序无本机锚点」，旧断言一条未删。
const {
  INSTANCE_ID_PATTERN,
  DEFAULT_REMOTE_NAME,
  INSTANCE_ENVELOPE_VERSION,
  INSTANCE_KEY_PREFIX,
  normalizeInstance,
  instanceIdFromUrl,
  instanceKey,
  deriveCapabilities,
  redactUrl,
  redactInstance,
  sortInstances,
  upsertInstance,
  removeInstance,
  findInstance,
  applyReachability,
  encodeInstances,
  decodeInstances,
  problemText
} = M;

const ID_A = 'inst-0123456789abcdef';
const ID_B = 'inst-fedcba9876543210';
const URL_A = 'http://192.168.1.6:3080/';
const URL_B = 'https://pc-b.example.com/';
const SECRET = 'TOP_SECRET_NEVER_LOG_8f3a';

function remoteInstance(overrides = {}) {
  const base = {
    id: ID_A,
    name: 'pc-b',
    url: URL_B,
    mode: 'lan',
    reachable: 'unknown',
    capabilities: deriveCapabilities(ID_A)
  };
  return { ...base, ...overrides };
}

function normalized(raw) {
  const result = normalizeInstance(raw);
  assert.equal(result.ok, true, `应通过归一：${JSON.stringify(raw)}（${result.reason}）`);
  assert.equal(result.problem, 'ok');
  assert.equal(result.reason, '');
  assert.notEqual(result.instance, null);
  return result.instance;
}

function refused(raw, code) {
  const result = normalizeInstance(raw);
  assert.equal(result.ok, false, `应拒绝：${JSON.stringify(raw)}`);
  assert.equal(result.instance, null);
  assert.equal(result.problem, code);
  assert.ok(result.reason.length > 0, '拒绝必须带中文原因');
  assert.notEqual(result.reason, '', 'reason 不能为空');
  return result;
}

// ---------------------------------------------------------------- 归一 / typed 拒绝

describe('normalizeInstance：字段校验与 typed 拒绝', () => {
  test('N-01 合法远程实例：trim 名称、url 原样、能力集按 id 派生', () => {
    const inst = normalized({ id: ID_A, name: '  pc-b  ', url: URL_B, mode: 'cloudflare' });
    assert.equal(inst.name, 'pc-b');
    assert.equal(inst.url, URL_B);
    assert.equal(inst.mode, 'cloudflare');
    assert.equal(inst.reachable, 'unknown');
    assert.deepEqual(inst.capabilities, {
      webUI: true, rpc: false, chatExport: false, lease: false, sessionCreate: false
    });
    assert.equal(inst.token, undefined);
    assert.equal(inst.lastSeen, undefined);
  });

  test('N-02 坏 url：ftp / 裸 host（无协议）/ 空串都给 E_INSTANCE_URL', () => {
    refused({ id: ID_A, name: 'x', url: 'ftp://host/', mode: 'lan' }, 'E_INSTANCE_URL');
    refused({ id: ID_A, name: 'x', url: '192.168.1.6:3080', mode: 'lan' }, 'E_INSTANCE_URL');
    refused({ id: ID_A, name: 'x', url: '   ', mode: 'lan' }, 'E_INSTANCE_URL');
  });

  test('N-03 坏 mode：未知值 / 大小写不符都给 E_INSTANCE_MODE（不回落 lan）', () => {
    refused({ id: ID_A, name: 'x', url: URL_A, mode: 'wifi' }, 'E_INSTANCE_MODE');
    refused({ id: ID_A, name: 'x', url: URL_A, mode: 'LAN' }, 'E_INSTANCE_MODE');
    refused({ id: ID_A, name: 'x', url: URL_A, mode: '' }, 'E_INSTANCE_MODE');
  });

  // 旧断言把 local 当合法 id；新事实更严格：只有远程 id 合法，旧 local 一律拒绝。
  test('N-04 坏 id：形状不对的四种都给 E_INSTANCE_ID（旧 local 也拒绝）', () => {
    for (const id of ['', 'LOCAL', 'local', 'inst-xyz', 'pc-b', 'inst-0123456789abcdef0']) {
      refused({ id, name: 'x', url: URL_A, mode: 'lan' }, 'E_INSTANCE_ID');
    }
    assert.equal(INSTANCE_ID_PATTERN.test('local'), false, '本机 id 不再是实例 id');
    assert.equal(INSTANCE_ID_PATTERN.test(ID_A), true);
  });

  test('N-05 显式空名 / 非字符串名给 E_INSTANCE_NAME；字段缺失用默认值', () => {
    refused({ id: ID_A, name: '   ', url: URL_A, mode: 'lan' }, 'E_INSTANCE_NAME');
    refused({ id: ID_A, name: 42, url: URL_A, mode: 'lan' }, 'E_INSTANCE_NAME');
    assert.equal(normalized({ id: ID_A, url: URL_A, mode: 'lan' }).name, DEFAULT_REMOTE_NAME);
    assert.equal(normalized({ id: ID_A, name: ' 我的电脑 ', url: URL_A, mode: 'lan' }).name, '我的电脑');
    assert.equal(normalized({ id: ID_A, url: URL_A, mode: 'lan' }).url, URL_A, '远程行恒有 URL，无空 URL 的本机形态');
  });

  test('N-06 脏入参（null / 数组 / 数字）给 E_INSTANCE_SHAPE，不抛错', () => {
    for (const raw of [null, undefined, [], 7, 'x']) {
      assert.equal(normalizeInstance(raw).ok, false);
      assert.equal(normalizeInstance(raw).problem, 'E_INSTANCE_SHAPE');
    }
  });

  test('N-07 URL 里的 token / k 被抽到 token 字段，url 永不含令牌', () => {
    const byToken = normalized({
      id: ID_A, name: 'x', url: `http://h:3080/?token=${SECRET}&a=1`, mode: 'lan'
    });
    assert.equal(byToken.token, SECRET);
    assert.equal(byToken.url, 'http://h:3080/?a=1');
    assert.equal(byToken.url.includes(SECRET), false);
    const byK = normalized({
      id: ID_A, name: 'x', url: `http://h:3080/?k=${SECRET}&a=1`, mode: 'lan'
    });
    assert.equal(byK.token, SECRET);
    assert.equal(byK.url.includes(SECRET), false);
  });

  test('N-08 显式 token 优先；lastSeen 取整；reachable 兼容三态且未知不升 ok', () => {
    const inst = normalized({
      id: ID_A, name: 'x', url: `http://h/?token=${SECRET}`, mode: 'lan',
      token: '  OWNTOKEN  ', lastSeen: 1234.9, reachable: true
    });
    assert.equal(inst.token, 'OWNTOKEN');
    assert.equal(inst.lastSeen, 1234);
    assert.equal(inst.reachable, 'ok');
    assert.equal(normalized({ ...remoteInstance(), reachable: false }).reachable, 'fail');
    assert.equal(normalized({ ...remoteInstance(), reachable: null }).reachable, 'unknown');
    assert.equal(normalized({ ...remoteInstance(), reachable: 'weird' }).reachable, 'unknown');
    assert.equal(normalized({ ...remoteInstance(), lastSeen: -1 }).lastSeen, undefined);
  });

  // 旧断言钉「本机行忽略 url / token」；新事实更严格：旧本机 id 直接拒绝，远程行照常带令牌。
  test('N-09 旧本机 id 一律拒绝，不能靠忽略 url / token 造出本机行', () => {
    refused({
      id: 'local', mode: 'lan', url: `http://h/?token=${SECRET}`, token: SECRET
    }, 'E_INSTANCE_ID');
    const remote = normalized({
      id: ID_A, name: 'x', mode: 'lan', url: `http://h/?token=${SECRET}`, token: SECRET
    });
    assert.equal(remote.url, 'http://h/');
    assert.equal(remote.token, SECRET, '远程行的令牌语义不变');
  });

  test('N-10 大写 ?TOKEN= 也抽到 token 字段，url 只留 base（P2 评审缺口）', () => {
    const inst = normalized({
      id: ID_A, name: 'x', url: `http://h/?TOKEN=${SECRET}&a=1`, mode: 'lan'
    });
    assert.equal(inst.token, SECRET);
    assert.equal(inst.url, 'http://h/?a=1');
    assert.equal(inst.url.includes(SECRET), false);
  });
});

// ---------------------------------------------------------------- 打码

describe('redactUrl / redactInstance：令牌绝不外泄', () => {
  test('R-01 ?token= 打码成 *** 且原值消失', () => {
    const masked = redactUrl(`http://h:3080/?token=${SECRET}&a=1`);
    assert.equal(masked.includes(SECRET), false);
    assert.match(masked, /token=\*\*\*/);
    assert.match(masked, /a=1/);
  });

  test('R-02 ?k= 打码，其它参数原样保留', () => {
    const masked = redactUrl(`http://h:3080/?k=${SECRET}&b=2`);
    assert.equal(masked.includes(SECRET), false);
    assert.match(masked, /k=\*\*\*/);
    assert.match(masked, /b=2/);
  });

  test('R-03 大小写不敏感 + fragment 兜底打码', () => {
    assert.equal(redactUrl(`http://h/?TOKEN=${SECRET}`).includes(SECRET), false);
    assert.equal(redactUrl(`http://h/#token=${SECRET}`).includes(SECRET), false);
    assert.match(redactUrl('http://h/?token='), /token=\*\*\*/);
  });

  test('R-04 redactInstance 结构上没有 token 字段，tokenSet 正确', () => {
    const inst = normalized({
      id: ID_A, name: 'pc-b', url: `https://h/?token=${SECRET}`, mode: 'lan',
      token: SECRET, lastSeen: 999
    });
    const view = redactInstance(inst);
    assert.equal(Object.prototype.hasOwnProperty.call(view, 'token'), false);
    assert.equal(view.tokenSet, true);
    assert.equal(view.url.includes(SECRET), false);
    assert.equal(view.lastSeen, 999);
    assert.equal(JSON.stringify(view).includes(SECRET), false);
    const noToken = redactInstance(remoteInstance());
    assert.equal(noToken.tokenSet, false);
    assert.deepEqual(redactInstance(null).capabilities, deriveCapabilities(ID_A));
    assert.equal(redactInstance(null).capabilities.webUI, true, '空视图按远程能力集，无本机特例');
  });

  test('R-05 redactInstance 的能力集是副本，不会反过来改原实例', () => {
    const inst = remoteInstance();
    const view = redactInstance(inst);
    view.capabilities.webUI = false;
    assert.equal(inst.capabilities.webUI, true);
  });
});

// ---------------------------------------------------------------- 排序 / CRUD（无本机行）

describe('远程实例列表操作', () => {
  // 旧断言用 localInstance() 造一条显式首行；新事实更严格：这些原语已从模型删除，
  // 任何调用点都无法再构造本机行，远程行的能力集统一为 webUI=true / rpc=false。
  test('L-01 无本机原语：localInstance / LOCAL_INSTANCE_ID / DEFAULT_LOCAL_NAME 均不存在', () => {
    assert.equal(typeof M.localInstance, 'undefined', '模型不得导出 localInstance');
    assert.equal(typeof M.LOCAL_INSTANCE_ID, 'undefined', '模型不得导出本机 id 常量');
    assert.equal(typeof M.DEFAULT_LOCAL_NAME, 'undefined', '模型不得导出本机名常量');
    const remote = normalized({ id: ID_A, name: 'pc', url: URL_A, mode: 'lan' });
    assert.equal(remote.url, URL_A);
    assert.equal(remote.capabilities.webUI, true);
    assert.equal(remote.capabilities.rpc, false);
  });

  // 旧断言钉「本机第一」；新事实更严格：排序完全没有本机锚点，纯 name→id，空表仍为空。
  test('L-02 sortInstances：无本机首行，按 name→id，输入不被改', () => {
    const z = remoteInstance({ id: ID_B, name: 'z-电脑' });
    const a = remoteInstance({ id: ID_A, name: 'a-电脑' });
    const same1 = remoteInstance({ id: ID_B, name: '同名' });
    const same2 = remoteInstance({ id: ID_A, name: '同名' });
    const input = [z, a, same1, same2];
    const sorted = sortInstances(input);
    assert.deepEqual(sorted.map((x) => x.id), [ID_A, ID_B, ID_A, ID_B]);
    assert.equal(sorted[0].name, 'a-电脑', '没有本机锚点，第一行按名字排');
    assert.equal(input[0].id, ID_B, '排序不能就地修改入参');
    assert.deepEqual(sortInstances(sorted), sorted, '重复排序幂等');
    assert.deepEqual(sortInstances([]), [], '空表排序仍为空');
  });

  test('L-03 upsert：同 id 更新、新 id 追加，无重复且不改原数组；本机 id 无法插入', () => {
    const a = remoteInstance({ name: 'a' });
    const b = remoteInstance({ id: ID_B, name: 'b' });
    const original = [a, b];
    const next = upsertInstance(original, remoteInstance({ name: 'a-改名' }));
    assert.equal(next.length, 2);
    assert.equal(findInstance(next, ID_A).name, 'a-改名');
    assert.equal(original[0].name, 'a');
    const rejected = upsertInstance(next, { id: 'local', name: 'x', url: URL_A, mode: 'lan' });
    assert.deepEqual(rejected, next, '旧本机 id 不能经 upsert 进入列表');
    assert.equal(rejected.filter((x) => x.id === 'local').length, 0);
  });

  test('L-04 upsert 坏实例原样返回（fail-closed，不抛错）', () => {
    const list = [remoteInstance()];
    const next = upsertInstance(list, { id: 'bad', name: 'x', url: URL_A, mode: 'lan' });
    assert.deepEqual(next, list);
    assert.notEqual(next, list, '仍返回新数组');
  });

  // 旧断言钉「本机不可删」；新事实更严格：任何 id 都可删，遗留字面量 local 也不受保护，
  // 删空后保持空表（不回补）。
  test('L-05 remove：任意行可删（含遗留 local 字面量），删空保持空表', () => {
    const list = [remoteInstance({ id: ID_B, name: 'b' }), remoteInstance({ name: 'a' })];
    const next = removeInstance(list, ID_B);
    assert.deepEqual(next.map((x) => x.id), [ID_A]);
    assert.deepEqual(removeInstance(list, 'local').map((x) => x.id), [ID_A, ID_B], '本机字面量不再受保护');
    assert.deepEqual(removeInstance(next, ID_A), [], '删空 = 空表，不回补');
    assert.equal(findInstance(next, ID_B), null);
    assert.equal(findInstance(list, ID_A).name, 'a');
  });
});

// ---------------------------------------------------------------- 信封 / 恢复

describe('持久化信封 {v:1,items:[...]}', () => {
  test('E-01 round-trip：token / lastSeen 保留，capabilities 不落盘而重算', () => {
    const inst = normalized({
      id: ID_A, name: 'pc-b', url: URL_B, mode: 'lan',
      token: SECRET, lastSeen: 1700000000000, reachable: 'ok'
    });
    const json = encodeInstances([inst]);
    const envelope = JSON.parse(json);
    assert.equal(envelope.v, INSTANCE_ENVELOPE_VERSION);
    assert.equal(envelope.items.length, 1, '信封里只有远程行，没有本机行');
    assert.deepEqual(Object.keys(envelope.items[0]).sort(),
      ['id', 'lastSeen', 'mode', 'name', 'reachable', 'token', 'url']);
    const decoded = decodeInstances(json);
    assert.equal(decoded.ok, true);
    assert.equal(decoded.problem, 'ok');
    assert.deepEqual(decoded.items, [inst]);
    assert.equal(decoded.items[0].capabilities.webUI, true);
  });

  // 旧断言钉「遗留本机行排第一」；新事实更严格：读取时直接丢弃该行，不复活、不重编码落盘，
  // 同一信封里的远程行照常解码，整表也不因这一行判坏。
  test('E-02 decode 过滤遗留 local 行，远程行照常排序，重复 decode 字节相等', () => {
    const inst = remoteInstance({ name: 'b' });
    const legacyLocal = { id: 'local', name: '本机（默认）', url: '', mode: 'lan', reachable: 'unknown' };
    const unsorted = JSON.stringify({ v: 1, items: [inst, legacyLocal] });
    const decoded = decodeInstances(unsorted);
    assert.equal(decoded.ok, true, '遗留本机行不能把整表判成损坏');
    assert.equal(decoded.items.length, 1, '本机行读取时过滤，不是排到第一行');
    assert.equal(decoded.items[0].id, ID_A);
    const reencoded = encodeInstances(decoded.items);
    assert.equal(reencoded.includes('"local"'), false, '不重新落盘本机行');
    assert.equal(reencoded, encodeInstances(decodeInstances(unsorted).items));
    const onlyLegacy = JSON.stringify({ v: 1, items: [legacyLocal] });
    assert.deepEqual(decodeInstances(onlyLegacy).items, [], '只有遗留本机行时读出空表');
  });

  test('E-03 损坏信封一律回落空表 + typed reason，不抛异常', () => {
    const cases = [
      ['', 'E_ENVELOPE_EMPTY'],
      ['   ', 'E_ENVELOPE_EMPTY'],
      ['{not json', 'E_ENVELOPE_JSON'],
      ['[]', 'E_ENVELOPE_SHAPE'],
      ['null', 'E_ENVELOPE_SHAPE'],
      ['{}', 'E_ENVELOPE_SHAPE'],
      [JSON.stringify({ v: 2, items: [] }), 'E_ENVELOPE_VERSION'],
      [JSON.stringify({ v: 1, items: 'nope' }), 'E_ENVELOPE_SHAPE'],
      [JSON.stringify({ v: 1, items: [{ id: 'bad', name: 'x', url: URL_A, mode: 'lan' }] }), 'E_ENVELOPE_ITEM']
    ];
    for (const [raw, code] of cases) {
      const result = decodeInstances(raw);
      assert.equal(result.ok, false, `应拒绝：${raw}`);
      assert.deepEqual(result.items, []);
      assert.equal(result.problem, code);
      assert.ok(result.reason.length > 0);
      assert.equal(problemText(code), result.reason);
    }
  });

  test('E-04 instanceIdFromUrl：稳定、token 不参与哈希、坏地址空串', () => {
    const id1 = instanceIdFromUrl(`http://h:3080/?token=${SECRET}`);
    const id2 = instanceIdFromUrl('http://h:3080/');
    assert.match(id1, /^inst-[0-9a-f]{16}$/);
    assert.equal(id1, id2);
    assert.equal(instanceIdFromUrl('h:3080'), '');
    assert.equal(instanceIdFromUrl('ftp://h/'), '');
  });

  test('E-07 fragment token 不参与哈希 / 不进持久 url：带 #token= 与干净地址同 id（P2-1）', () => {
    const withFragment = `http://h/?k=${SECRET}#token=${SECRET}`;
    const fragmentOnly = `http://h/#token=${SECRET}`;
    const clean = `http://h/?k=${SECRET}`;
    const idA = instanceIdFromUrl(withFragment);
    const idB = instanceIdFromUrl(clean);
    assert.match(idA, /^inst-[0-9a-f]{16}$/);
    assert.equal(idA, idB, 'fragment 不能改变 id');
    assert.equal(instanceIdFromUrl(fragmentOnly), instanceIdFromUrl('http://h/'), '只有 fragment token 也不改变 id');
    const inst = normalized({ id: idA, name: 'x', url: withFragment, mode: 'lan' });
    assert.equal(inst.url, 'http://h/', 'fragment 被定向剥离，明文不落盘');
    assert.equal(inst.url.includes(SECRET), false);
    assert.equal(inst.token, SECRET, 'query 里的 k 仍按原规则抽到 token');
    const cleanInst = normalized({ id: idB, name: 'x', url: clean, mode: 'lan' });
    assert.equal(encodeInstances([inst]), encodeInstances([cleanInst]));
    const fragOnlyInst = normalized({ id: ID_A, name: 'x', url: fragmentOnly, mode: 'lan' });
    assert.equal(fragOnlyInst.url, 'http://h/');
    assert.equal(fragOnlyInst.token, undefined, 'fragment token 不抽到 token 字段，直接丢弃');
  });

  test('E-05 instanceKey：只由合法 id 生成，脏 id 空串', () => {
    assert.equal(instanceKey('local'), '', '旧本机 id 不再生成持久键');
    assert.equal(instanceKey(ID_A), `${INSTANCE_KEY_PREFIX}${ID_A}`);
    for (const bad of ['local', '', 'bad', 'inst-xyz', 'local/..']) {
      assert.equal(instanceKey(bad), '');
    }
  });

  test('E-06 markReachable 纯核心：ok 推进 lastSeen，fail 保留上次成功', () => {
    const inst = normalized({ ...remoteInstance(), reachable: 'fail', lastSeen: 1000, token: SECRET });
    const okList = applyReachability([inst], ID_A, 'ok', 2000);
    assert.equal(okList[0].reachable, 'ok');
    assert.equal(okList[0].lastSeen, 2000);
    assert.equal(okList[0].token, SECRET);
    const failList = applyReachability(okList, ID_A, 'fail', 3000);
    assert.equal(failList[0].reachable, 'fail');
    assert.equal(failList[0].lastSeen, 2000);
    assert.deepEqual(applyReachability([inst], ID_B, 'ok', 4000), [inst]);
    assert.deepEqual(applyReachability([inst], ID_A, 'weird', 4000), [inst]);
    assert.equal(inst.lastSeen, 1000, '入参不被修改');
  });

  test('E-08 非法 nowMs（NaN / 0 / 负数 / Infinity / 字符串）不得推进 lastSeen（P2 评审缺口）', () => {
    const inst = normalized({ ...remoteInstance(), reachable: 'fail', lastSeen: 1000 });
    for (const bad of [NaN, 0, -1, Infinity, '2000']) {
      const next = applyReachability([inst], ID_A, 'ok', bad);
      assert.equal(next[0].reachable, 'ok');
      assert.equal(next[0].lastSeen, 1000, `非法 nowMs=${String(bad)} 仍推进了 lastSeen`);
    }
  });
});

// ---------------------------------------------------------------- 源码守卫

const MODEL_SRC = readFileSync(new URL('../../entry/src/main/ets/model/instances.ts', import.meta.url), 'utf8');
const STORE_SRC = readFileSync(new URL('../../entry/src/main/ets/services/instanceStore.ets', import.meta.url), 'utf8');
const TEST_SRC = readFileSync(new URL('./instanceModel.test.mjs', import.meta.url), 'utf8');

describe('静态守卫：存储接线与令牌日志', () => {
  test('S-01 store 只用单个 PersistentStorage 键 + 一次整串原子写', () => {
    assert.match(STORE_SRC, /const INSTANCE_STORAGE_KEY: string = 'instances\.json'/);
    assert.match(STORE_SRC, /PersistentStorage\.persistProp<string>\(INSTANCE_STORAGE_KEY/);
    assert.match(STORE_SRC, /AppStorage\.setOrCreate<string>\(INSTANCE_STORAGE_KEY, json\)/);
    assert.match(STORE_SRC, /decodeInstances\(raw\)/);
    assert.match(STORE_SRC, /encodeInstances\(sorted\)/);
    assert.match(STORE_SRC, /applyReachability\(/);
    assert.match(STORE_SRC, /redactInstance\(item\)/);
  });

  test('S-02 三个新文件都没有 console / hilog / logger 调用', () => {
    // 动态拼词，避免守卫自身源码里的字符串被当成日志调用
    const logWord = 'con' + 'sole';
    const logRe = new RegExp(`(?:${logWord}|hilog|logger)\\s*\\.`, 'i');
    for (const [name, src] of [['model', MODEL_SRC], ['store', STORE_SRC], ['test', TEST_SRC]]) {
      assert.equal(logRe.test(src), false, `${name} 不得有日志调用`);
    }
  });

  test('S-03 含 token 的代码行都不出现在日志表达式里，也没有测试令牌字面量', () => {
    const logWord = 'con' + 'sole';
    const logRe = new RegExp(`(?:${logWord}|hilog|logger)`, 'i');
    for (const [name, src] of [['model', MODEL_SRC], ['store', STORE_SRC], ['test', TEST_SRC]]) {
      for (const line of src.split(/\r?\n/)) {
        if (line.toLowerCase().includes('token')) {
          assert.equal(logRe.test(line), false, `${name} 的 token 行不得是日志行：${line}`);
        }
      }
    }
    assert.equal(MODEL_SRC.includes(SECRET), false);
    assert.equal(STORE_SRC.includes(SECRET), false);
  });
});
