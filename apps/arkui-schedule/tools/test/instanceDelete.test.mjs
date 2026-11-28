// mod-app-instance-delete-in-settings：删除入口只住在设置子页的纯模型 / 真实播种路径 / 源码守卫。
//
// 前置：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
// 纯模型有相对 import（instances / instanceSeed / instanceGrant / instanceDelete），
// 编译产物是扩展名省略的 ES import，故用 registerHooks 补 `.js`。
// 源码守卫不依赖构建产物：D-05 可以在改动前单独运行，必须红。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { registerHooks } from 'node:module';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const ETS = join(APP, 'entry', 'src', 'main', 'ets');
const BUILD = join(HERE, '..', '.build');
const SECRET = 'SECRET_NEVER_SHOWN_9f3a';
const ID_A = 'inst-0123456789abcdef';
const ID_B = 'inst-fedcba9876543210';
const URL_A = 'http://192.168.1.6:3080/';

const src = (relative) => readFileSync(join(ETS, relative), 'utf8');
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** 模型按需加载：D-05 的源码守卫在未构建 / 改动前也能单独跑。 */
const load = (file) => import(pathToFileURL(file).href);

async function models() {
  return {
    instances: await load(join(BUILD, 'model', 'instances.js')),
    grant: await load(join(BUILD, 'model', 'instanceGrant.js')),
    del: await load(join(BUILD, 'model', 'instanceDelete.js')),
    seed: await load(join(BUILD, 'model', 'instanceSeed.js')),
    remoteUrl: await load(join(BUILD, 'model', 'remoteUrl.js'))
  };
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile() && full.endsWith('.ets')) {
      out.push(full);
    }
  }
  return out;
}

function grant(g, overrides = {}) {
  return {
    grantId: g,
    instanceId: ID_A,
    principal: 'dots',
    tools: ['instance.list', 'session.prompt'],
    grantedAt: 1000,
    ...overrides
  };
}

function instance(id, url) {
  const item = {
    id: id,
    name: id === ID_A ? '书房电脑' : '客厅电脑',
    url: url,
    mode: 'lan',
    reachable: 'unknown',
    capabilities: { webUI: true, rpc: false, chatExport: false, lease: false, sessionCreate: false }
  };
  if (id === ID_A) {
    item.token = 'REMOVE_WITH_RECORD';
    item.tlsFingerprint = 'AA:BB:CC:DD:EE:FF';
    item.pairingInstanceId = 'pair-1234';
  }
  return item;
}

// ---------------------------------------------------------------- 纯模型

describe('D-01..D-04 删除的纯判定：记录 + 授权 + 文案', () => {
  test('D-01 删记录并移除它的全部授权行；另一个实例的授权逐字不动', async () => {
    const { instances, grant: G } = await models();
    const list = [instance(ID_A, URL_A), instance(ID_B, 'https://pc-b.example.com/')];
    const grants = [
      grant('g-a1'), grant('g-a2', { tools: ['instance.list'] }),
      grant('g-b', { instanceId: ID_B, tools: ['session.prompt'] })
    ];
    const afterInstances = instances.removeInstance(list, ID_A);
    const changed = G.revokeAllForInstance(grants, ID_A, 5000);
    assert.equal(changed.ok, true);
    assert.deepEqual(afterInstances.map((x) => x.id), [ID_B]);
    assert.equal(JSON.stringify(afterInstances).includes('REMOVE_WITH_RECORD'), false,
      '整条记录消失：token 不残留');
    assert.equal(JSON.stringify(afterInstances).includes('AA:BB:CC:DD:EE:FF'), false,
      '整条记录消失：tlsFingerprint 不残留');
    assert.equal(JSON.stringify(afterInstances).includes('pair-1234'), false,
      '整条记录消失：pairingInstanceId 不残留');
    assert.equal(changed.items.length, 1, '该实例的授权行必须整组移除，不留 dangling instanceId');
    assert.equal(changed.items.filter((x) => x.instanceId === ID_A).length, 0,
      '被删实例不得残留任何授权行（连吊销历史行也不能留）');
    const b = changed.items.find((x) => x.grantId === 'g-b');
    assert.deepEqual(b, grants[2], '第二个实例的授权逐字不动');
    assert.equal(G.canPrompt(changed.items, ID_A, 5000), false);
    assert.equal(G.canPrompt(changed.items, ID_B, 5000), true);
    assert.equal(grants.length, 3, '入参不被就地修改');
    assert.equal(grants[0].revokedAt, undefined, '入参授权未被就地改写');
  });

  test('D-02 revokeAllForInstance 是 typed / total：坏时间、坏 id、无匹配原表副本', async () => {
    const { grant: G } = await models();
    const grants = [grant('g-a1'), grant('g-old', { revokedAt: 4000 })];
    for (const bad of [NaN, 0, -1, Infinity, '5000']) {
      const result = G.revokeAllForInstance(grants, ID_A, bad);
      assert.equal(result.ok, false);
      assert.equal(result.problem, 'E_GRANT_NOW');
      assert.deepEqual(result.items, grants);
    }
    const badId = G.revokeAllForInstance(grants, 'not-an-id', 5000);
    assert.equal(badId.ok, false);
    assert.equal(badId.problem, 'E_GRANT_INSTANCE_ID');
    const ok = G.revokeAllForInstance(grants, ID_A, 6000);
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.items, [], '目标实例全部授权行被移除，不是写 revokedAt 留行');
    const none = G.revokeAllForInstance(grants, ID_B, 6000);
    assert.equal(none.ok, true);
    assert.deepEqual(none.items, grants, '没有匹配的授权则原表副本');
  });

  test('D-03 确认文案是纯函数：逐字抄规则、名字逐字、URL 打码、不丢仓库级项目', async () => {
    const { del: D } = await models();
    const view = {
      id: ID_A, name: '书房电脑', url: `http://h:3080/?token=${SECRET}&a=1`,
      mode: 'lan', tokenSet: true, reachable: 'unknown',
      capabilities: { webUI: true, rpc: false, chatExport: false, lease: false, sessionCreate: false }
    };
    const plan = D.deletePlanOf(view);
    assert.equal(plan.name, '书房电脑');
    assert.deepEqual(plan.lines, [
      '实例：书房电脑',
      `地址：${D.redactDisplayUrl(view.url)}`,
      '这条实例的记录（地址、保存的访问令牌、证书指纹）和它的授权记录（如果从未授权过，这里是空的）',
      '聊天缓存与同步队列属于仓库，不随实例删除',
      '已打开的页面在关闭前仍可使用；下次连接需要重新扫码配对'
    ]);
    assert.equal(D.DELETE_LOSS_LINE,
      '这条实例的记录（地址、保存的访问令牌、证书指纹）和它的授权记录（如果从未授权过，这里是空的）');
    assert.equal(D.DELETE_KEEP_LINE, '聊天缓存与同步队列属于仓库，不随实例删除');
    assert.equal(D.DELETE_LIVE_LINE, '已打开的页面在关闭前仍可使用；下次连接需要重新扫码配对');
    assert.equal(plan.confirmLabel, '删除实例');
    assert.equal(plan.cancelLabel, '取消');
    assert.equal(plan.title, '删除实例');
    assert.equal(JSON.stringify(plan).includes(SECRET), false, '确认文案结构上不含令牌');
    assert.match(plan.lines[1], /token=\*\*\*/);
    assert.deepEqual(D.deletePlanOf(null).lines,
      ['实例：', '地址：', D.DELETE_LOSS_LINE, D.DELETE_KEEP_LINE, D.DELETE_LIVE_LINE]);
  });

  test('D-04 墓碑编解码 / 合并 / 遗忘是 typed、幂等、确定性的', async () => {
    const { instances, remoteUrl: RU, del: D } = await models();
    assert.deepEqual(D.decodeTombstones('{bad'), []);
    assert.deepEqual(D.decodeTombstones(JSON.stringify({ v: 2, ids: [ID_A] })), []);
    const encoded = D.encodeTombstones([ID_B, ID_A]);
    assert.deepEqual(D.decodeTombstones(encoded), [ID_A, ID_B]);
    assert.equal(encoded, D.encodeTombstones([ID_A, ID_B, ID_A]));
    assert.deepEqual(D.mergeTombstones([ID_A], [ID_B, ID_A]), [ID_A, ID_B]);
    assert.deepEqual(D.forgetTombstones([ID_A, ID_B], [ID_A]), [ID_B]);
    const ids = D.tombstoneIdsOf(ID_A, URL_A);
    assert.ok(ids.includes(ID_A));
    assert.ok(ids.length >= 1);
    const legacy = { remoteUrl: '192.168.1.6:3080', remoteLastOk: '', remoteMode: '', remoteToken: 'x' };
    const id = D.legacySeedIdOf(legacy);
    assert.equal(id, instances.instanceIdFromUrl(RU.normalizeRemoteUrl('192.168.1.6:3080').url));
    assert.ok(id.length > 0);
    const suppressed = D.suppressLegacyForTombstones(legacy, [id]);
    assert.equal(suppressed.remoteUrl, '');
    assert.equal(suppressed.remoteLastOk, '');
    assert.equal(D.legacySeedIdOf(suppressed), '');
    assert.equal(D.suppressLegacyForTombstones(legacy, []), legacy);
  });
});

// ---------------------------------------------------------------- 真实播种路径（临时 prefs fixture）

/** 从真实 .ets 截出键常量 / 纯 helper / InstanceStore 类，在假 AppStorage 上执行生产方法本体。 */
function matchBrace(text, openAt) {
  let depth = 0;
  for (let i = openAt; i < text.length; i++) {
    if (text[i] === '{') depth++;
    if (text[i] === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error('未找到匹配的右花括号');
}

async function makeStore(prefsFile, writes = null) {
  const ts = (await load(join(APP, '..', '..', 'node_modules', 'typescript', 'lib', 'typescript.js'))).default;
  const { instances, grant: G, del: D, seed } = await models();
  const STORE = stripComments(src('services/instanceStore.ets'));
  const classAt = STORE.indexOf('export class InstanceStore');
  assert.ok(classAt >= 0, '必须读到真的 InstanceStore');
  const helpersAt = STORE.indexOf('const INSTANCE_STORAGE_KEY');
  assert.ok(helpersAt >= 0 && helpersAt < classAt, '必须读到存储键与 helper');
  const classEnd = matchBrace(STORE, STORE.indexOf('{', classAt));
  const classSrc = STORE.slice(classAt, classEnd).replace(/^export\s+/, '');
  const { addPairedInstanceWithProbe } = await load(join(BUILD, 'model', 'pairingPayload.js'));
  const js = ts.transpileModule(`${STORE.slice(helpersAt, classAt)}\n${classSrc}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.None }
  }).outputText;
  const readPrefs = () => {
    try {
      return JSON.parse(readFileSync(prefsFile, 'utf8'));
    } catch {
      return {};
    }
  };
  const AppStorageStub = {
    get: (key) => readPrefs()[key],
    setOrCreate: (key, value) => {
      if (writes !== null) {
        writes.push(key);
      }
      const prefs = readPrefs();
      prefs[key] = value;
      writeFileSync(prefsFile, JSON.stringify(prefs));
    }
  };
  const PersistentStorageStub = { persistProp: () => {} };
  const Factory = new Function(
    'AppStorage', 'PersistentStorage',
    'applyReachability', 'decodeInstances', 'encodeInstances', 'redactInstance',
    'removeInstance', 'sortInstances', 'upsertInstance', 'seedInstances', 'addPairedInstanceWithProbe',
    'decodeTombstones', 'encodeTombstones', 'mergeTombstones', 'forgetTombstones',
    'tombstoneIdsOf', 'suppressLegacyForTombstones',
    `${js}\nreturn InstanceStore;`
  );
  const Store = Factory(
    AppStorageStub, PersistentStorageStub,
    instances.applyReachability, instances.decodeInstances, instances.encodeInstances, instances.redactInstance,
    instances.removeInstance, instances.sortInstances, instances.upsertInstance, seed.seedInstances,
    addPairedInstanceWithProbe,
    D.decodeTombstones, D.encodeTombstones, D.mergeTombstones, D.forgetTombstones,
    D.tombstoneIdsOf, D.suppressLegacyForTombstones
  );

  // 同一份假 AppStorage 上跑真实 InstanceGrantStore（删除必须连带吊销的写入也可见）。
  const GS = stripComments(src('services/instanceGrantStore.ets'));
  const gClassAt = GS.indexOf('export class InstanceGrantStore');
  const gHelpersAt = GS.indexOf('const GRANT_STORAGE_KEY');
  assert.ok(gClassAt >= 0 && gHelpersAt >= 0 && gHelpersAt < gClassAt, '必须读到真的 InstanceGrantStore');
  const gClassEnd = matchBrace(GS, GS.indexOf('{', gClassAt));
  const gJs = ts.transpileModule(
    `${GS.slice(gHelpersAt, gClassAt)}\n${GS.slice(gClassAt, gClassEnd).replace(/^export\s+/, '')}`,
    { compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.None } }
  ).outputText;
  const GrantFactory = new Function(
    'AppStorage', 'PersistentStorage',
    'decodeGrants', 'encodeGrants', 'redactGrant',
    'revokeAllGrantsForInstance', 'revokeGrant', 'sortGrants', 'upsertGrant',
    `${gJs}\nreturn InstanceGrantStore;`
  );
  const GrantStore = GrantFactory(
    AppStorageStub, PersistentStorageStub,
    G.decodeGrants, G.encodeGrants, G.redactGrant,
    G.revokeAllForInstance, G.revokeGrant, G.sortGrants, G.upsertGrant
  );
  return { store: new Store(), grantStore: new GrantStore(), deps: { G, D }, readPrefs };
}

/**
 * `<filesDir>/git-repo/chats/**` 的路径集 + 逐文件 sha256。
 * 目录不存在返回 null（合法状态：删除前后都必须不存在），不是空对象。
 */
function snapshotChats(chatsDir) {
  if (!existsSync(chatsDir)) {
    return null;
  }
  const files = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const key = relative(chatsDir, full).split(sep).join('/');
        files[key] = createHash('sha256').update(readFileSync(full)).digest('hex');
      }
    }
  };
  walk(chatsDir);
  return files;
}

describe('D-05 复活回归：真实 store 播种路径 + 临时 prefs fixture', () => {
  test('D-05 删除后下次启动 ensureSeeded 不会从旧 remoteUrl / remoteLastOk 复活；未删的仍会播种', async () => {
    const { instances, remoteUrl: RU } = await models();
    const dir = mkdtempSync(join(tmpdir(), 'dsh-id-del-'));
    const prefsFile = join(dir, 'prefs.json');
    writeFileSync(prefsFile, JSON.stringify({}));
    try {
      const legacy = {
        remoteUrl: '192.168.1.6:3080',
        remoteLastOk: JSON.stringify({ url: '192.168.1.6:3080', at: 1700000000000 }),
        remoteMode: '', remoteToken: SECRET
      };
      const legacyId = instances.instanceIdFromUrl(RU.normalizeRemoteUrl('192.168.1.6:3080').url);
      assert.ok(legacyId.length > 0);
      // (a) 控制组：未删除的旧地址确实会被播种（证明 fixture 与断言是敏感的）。
      const control = await makeStore(prefsFile);
      control.store.ensureSeeded(legacy);
      assert.deepEqual(control.store.list().map((x) => x.id), [legacyId], '控制组必须复活成功');
      // (b) 删除以后重启：同一份 prefs + 同一份 legacy，实例不能回来。
      const first = await makeStore(prefsFile);
      first.store.ensureSeeded(legacy);
      assert.deepEqual(first.store.list().map((x) => x.id), [legacyId]);
      first.store.remove(legacyId);
      assert.deepEqual(first.store.list(), [], '删除后当前运行内为空表');
      // 墓碑 = 镜像的中和（mirror neutralised）：旧 remoteUrl / remoteLastOk 逐字仍在 fixture 里。
      assert.deepEqual(first.store.deletedIds(), [legacyId], '删除必须留下墓碑以中和旧镜像');
      const nextLaunch = await makeStore(prefsFile);
      const seeded = nextLaunch.store.ensureSeeded(legacy);
      assert.deepEqual(seeded, [], '下次启动的 ensureSeeded 不能从仍完整的旧镜像复活已删实例');
      assert.deepEqual(nextLaunch.store.list(), []);
      // 页面另一步把镜像本身清空（mirror cleared）：用清空后的 legacy 重启也不能生成第二行。
      const cleared = { ...legacy, remoteUrl: '', remoteLastOk: '' };
      const clearedLaunch = await makeStore(prefsFile);
      assert.deepEqual(clearedLaunch.store.ensureSeeded(cleared), [], '镜像清空后仍然不能复活');
      // (c) 用户重新配对 / 添加同一个地址后，墓碑清除，也不该被旧镜像二次覆盖。
      const reAdded = instance(legacyId, URL_A);
      nextLaunch.store.upsert(reAdded);
      const third = await makeStore(prefsFile);
      assert.deepEqual(third.store.ensureSeeded(legacy).map((x) => x.id), [legacyId],
        '重新添加后旧地址不得重复播种出第二条');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('X-chat-surface 不变：实例删除前后 chats/** 路径集与逐文件 sha256 相同', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-id-chats-'));
    const prefsFile = join(dir, 'prefs.json');
    const filesDir = join(dir, 'files');
    const chats = join(filesDir, 'git-repo', 'chats');
    mkdirSync(join(chats, 'chat-1'), { recursive: true });
    writeFileSync(prefsFile, JSON.stringify({}));
    writeFileSync(join(chats, 'index.jsonl'), '{"id":"chat-1"}\n');
    writeFileSync(join(chats, 'chat-1', 'meta.json'), '{"title":"周会"}\n');
    writeFileSync(join(chats, 'chat-1', 'session.jsonl'), '{"role":"user"}\n');
    try {
      const writes = [];
      const { store, grantStore, readPrefs } = await makeStore(prefsFile, writes);
      store.upsert(instance(ID_A, URL_A));
      grantStore.upsert(grant('g-a1'));
      grantStore.upsert(grant('g-b', { instanceId: ID_B, tools: ['session.prompt'] }));
      const before = snapshotChats(chats);
      assert.deepEqual(Object.keys(before).sort(),
        ['chat-1/meta.json', 'chat-1/session.jsonl', 'index.jsonl'], 'chat fixture 必须真实存在');

      // 一次真实删除：授权整组吊销 + 实例记录（含 token / 指纹 / 配对 id）移除 + 旧播种镜像清空。
      grantStore.revokeAllForInstance(ID_A, 5000);
      store.remove(ID_A);
      const prefs = readPrefs();
      prefs.remoteUrl = '';
      prefs.remoteLastOk = '';
      prefs.remoteToken = '';
      writeFileSync(prefsFile, JSON.stringify(prefs));

      const after = snapshotChats(chats);
      assert.deepEqual(after, before, 'chats/** 路径集与每个文件的 sha256 必须逐字不变');
      assert.deepEqual(store.list(), [], '实例记录确实被删（不是只查了 chat 目录）');
      assert.equal(grantStore.list().filter((x) => x.instanceId === ID_A).length, 0,
        '该实例授权行确实被移除（无 dangling instanceId）');
      assert.equal(grantStore.list().filter((x) => x.instanceId === ID_B).length, 1,
        '另一实例授权不受影响');
      // 写键守卫：只有本模块拥有的键，没有任何 chat / git-repo 路径进写 API。
      assert.deepEqual([...new Set(writes)].sort(),
        ['deleted-instances.json', 'instance-grants.json', 'instances.json'],
        '写 API 只能拿到本模块拥有的三个键');
      assert.equal(writes.some((key) => /chat|git-repo|\//i.test(key)), false,
        'chat 路径绝不能交给任何写 API');
      assert.equal(Object.keys(prefs).some((key) => /chat|git-repo|\//i.test(key)), false,
        '偏好写入也不能带 chat 路径键');

      // 合法边界：删除前 chats 目录不存在，删除后也必须不存在。
      const absentDir = mkdtempSync(join(tmpdir(), 'dsh-id-nochats-'));
      const absentPrefs = join(absentDir, 'prefs.json');
      writeFileSync(absentPrefs, JSON.stringify({}));
      try {
        const s2 = await makeStore(absentPrefs);
        s2.store.upsert(instance(ID_B, 'https://pc-b.example.com/'));
        const beforeAbsent = snapshotChats(join(absentDir, 'files', 'git-repo', 'chats'));
        assert.equal(beforeAbsent, null, '前置状态合法：chats 目录不存在');
        s2.store.remove(ID_B);
        assert.equal(snapshotChats(join(absentDir, 'files', 'git-repo', 'chats')), null,
          '删除后也必须保持不存在，不能顺手创建 chat 目录');
      } finally {
        rmSync(absentDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- 源码守卫

describe('D-06..D-09 源码守卫：删除入口的位置', () => {
  // 这一条在改动前必须红：当前 InstancesPane 有 label: '删除' / instanceStore.remove / deleteInstance。
  test('D-06 InstancesPane 不再有任何删除 affordance（滑动 / 长按 / 行尾删除都不许留在首页与配置页）', () => {
    const pane = stripComments(src('pages/panes/InstancesPane.ets'));
    for (const token of [
      "label: '删除'", "label: '删除实例'", 'instanceStore.remove(', 'this.deleteInstance(',
      "variant: 'danger'", 'swipeAction(', '.swipeAction(', 'LongPress', '.onLongPress(',
      'deleteInstance(view)', 'deleteGlyph'
    ]) {
      assert.equal(pane.includes(token), false, `InstancesPane 不得保留删除 affordance：${token}`);
    }
    // 保留既有能力：打开 / 配对 / 编辑必须在，且编辑改地址走 rekey（不是用户可见的删除）。
    for (const keep of [
      "label: '打开'", "label: '编辑'", 'this.submitForm()', 'this.showEdit(view)',
      'instanceStore.upsert(', 'instanceStore.rekey(', 'instanceStore.addByPairing(',
      'instanceStore.ensureSeeded('
    ]) {
      assert.ok(pane.includes(keep), `InstancesPane 必须保留既有能力：${keep}`);
    }
  });

  test('D-07 全应用只有 pages/SettingsInstances.ets 调用 instanceStore.remove(', () => {
    const hits = [];
    for (const file of walk(ETS)) {
      const code = stripComments(readFileSync(file, 'utf8'));
      if (code.includes('instanceStore.remove(')) {
        hits.push(relative(ETS, file).split(sep).join('/'));
      }
    }
    assert.deepEqual(hits.sort(), ['pages/SettingsInstances.ets'],
      `instanceStore.remove( 的唯一调用点必须是设置删除子页，实际：${hits.join(', ') || '无'}`);
    const page = stripComments(src('pages/SettingsInstances.ets'));
    assert.match(page, /instanceGrantStore\.revokeAllForInstance\(/, '删除必须同时吊销该实例授权');
    assert.match(page, /instanceStore\.remove\(/, '删除必须移除实例记录（含 token / 指纹 / 配对 id）');
    assert.match(page, /remoteUrl: '',\s*remoteLastOk: '',\s*remoteToken: ''/,
      '删除必须清空旧播种镜像与配对令牌本身');
    assert.equal(/git-repo|chats\//.test(page), false, '不得清仓库级聊天缓存 / 同步队列');
    assert.match(page, /bindSheet\(this\.showDeleteSheet/, '确认必须是 bindSheet，不是滑动手势');
    assert.match(page, /DELETE_CONFIRM|deletePlanOf\(/, '确认文案必须来自纯模型');
    assert.equal(/SwipeAction|swipeAction\(|onLongPress/.test(page), false, '删除页也不得用滑动 / 长按');
  });

  test('D-08 Settings 菜单新增「删除实例」行，名字与路由钉死；两份清单都登记', () => {
    const root = stripComments(src('pages/Settings.ets'));
    assert.match(root, /const ROUTE_INSTANCE_DELETE: string = 'pages\/SettingsInstances'/);
    assert.equal((root.match(/MenuSummaryRow\(\{/g) ?? []).length, 5, '根页恰好五行，新增行必须显式命名');
    const row = /title: '删除实例',\s*summary: this\.\w+,\s*retryable: (?:this\.\w+|false|true),\s*onTap: \(\) => \{\s*this\.push\(ROUTE_INSTANCE_DELETE\);\s*\}\)/;
    // 四项分列钉住，任一项缺失都红（比一个长正则更容易定位漂移点）。
    assert.match(root, /title: '删除实例'/, '第五行标题必须显式叫「删除实例」');
    assert.match(root, /summary: this\.instanceSummary/, '第五行摘要复用真实实例计数');
    assert.match(root, /retryable: false/, '第五行不是「读不到重试」行');
    assert.match(root, /this\.push\(ROUTE_INSTANCE_DELETE\);/, '第五行必须推新子页路由');
    for (const rel of [
      'entry/src/main/resources/base/profile/main_pages.json',
      'entry/src/harmony/resources/base/profile/main_pages.json'
    ]) {
      const doc = JSON.parse(readFileSync(join(APP, rel), 'utf8'));
      assert.ok(doc.src.includes('pages/SettingsInstances'), `${rel} 缺少 pages/SettingsInstances`);
    }
  });

  test('D-09 store 侧：播种抑制 / 墓碑 / 编辑 rekey 的真实接线', () => {
    const store = stripComments(src('services/instanceStore.ets'));
    assert.match(store, /seedInstances\(before, suppressLegacyForTombstones\(legacy, this\.loadTombstones\(\)\)\)/,
      'ensureSeeded 必须先按墓碑抑制旧镜像');
    assert.match(store, /mergeTombstones\(this\.loadTombstones\(\), tombstoneIdsOf\(/, 'remove 必须写墓碑');
    assert.match(store, /forgetTombstones\(this\.loadTombstones\(\), tombstoneIdsOf\(/, '重新添加必须清墓碑');
    assert.match(store, /rekey\(oldId: string, inst: DsInstance\): DsInstance\[\]/, '编辑改地址走 rekey 原语');
    const grantStore = stripComments(src('services/instanceGrantStore.ets'));
    assert.match(grantStore, /revokeAllGrantsForInstance\(this\.load\(\), instanceId, nowMs\)/,
      'store 必须调用纯吊销（import 化名指向 revokeAllForInstance）');
    const page = stripComments(src('pages/SettingsInstances.ets'));
    assert.match(page, /await settingsStore\.save\(\{ remoteUrl: '', remoteLastOk: '', remoteToken: '' \}, context\)/,
      '一次确认里必须真正清空旧播种镜像与配对令牌，不能只靠墓碑');
  });

  test('D-10 删除后即时刷新：Home show tick → 保活面板重读；设置页返回重读摘要', () => {
    const home = stripComments(src('pages/Home.ets'));
    assert.match(home, /onPageShow\(\): void \{/, 'Home 必须有 show 生命周期出口');
    assert.match(home, /this\.instancesShowTick = this\.instancesShowTick \+ 1/,
      '每次回前台必须推进实例面板 show tick');
    assert.match(home, /InstancesPane\(\{[\s\S]{0,200}showTick: this\.instancesShowTick/,
      '实例面板必须收到 show tick');
    const pane = stripComments(src('pages/panes/InstancesPane.ets'));
    assert.match(pane, /@Prop @Watch\('onShowTick'\) showTick: number = 0/,
      '保活面板必须用 @Watch 接住 show 信号');
    assert.match(pane, /onShowTick\(\): void \{[\s\S]{0,120}this\.reload\(\);/,
      'show 信号必须触发真实实例表重读，不是空操作');
    const settings = stripComments(src('pages/Settings.ets'));
    assert.match(settings, /onPageShow\(\): void \{[\s\S]{0,260}this\.bootstrap\(\)\.catch\(/,
      '从删除子页返回必须重读四/五行摘要');
  });
});
