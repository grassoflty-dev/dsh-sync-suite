// 设备编号自动分配 + `devices/registry.jsonl` 抢占（纯逻辑回归）。
//
// 锁死四件事（数据边界改动，任何一条退化都会写坏别人的日程目录）：
//   ① 编号 = **最大编号 + 1**（空洞不回填；非 device-N 不参与计数）；
//   ② registry 只追加、每行一个 JSON，坏行只计数不传染；
//   ③ 身份 = uuid（有本机 uuid 的行 → 直接沿用该行 deviceId，不重复登记）；
//   ④ 并发接入靠 push 抢占 + 重试：抢不到就 fail-closed（`E_DEVICE_ID_CONFLICT`），绝不乱用一个号。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const {
  DEVICE_ID_RE,
  DEVICE_ID_CONFLICT_CODE,
  DEVICE_ID_CONFLICT_MESSAGE,
  MAX_CLAIM_ATTEMPTS,
  REGISTRY_PATH,
  REGISTRY_UNREADABLE_CODE,
  appendRegistryLine,
  canReuseLocalDeviceId,
  claimDeviceId,
  describeClaimOutcome,
  findDeviceByUuid,
  isDeviceIdTaken,
  nextDeviceId,
  normalizeUuid,
  parseDeviceIds,
  parseRegistry,
  toRegistryLine
} = await import('../.build/model/deviceRegistry.js');

const UUID_A = '4f1c2b3d-8a6e-4c1f-9b2a-1c2d3e4f5a6b';
const UUID_B = '9a8b7c6d-5e4f-4a3b-8c1d-2e3f4a5b6c7d';
const AT = '2026-11-18T05:00:00.000Z';

// ---------------------------------------------------------------- 假仓库桩
//
// 模拟同一个远端被两台设备同时首次接入：每台设备只有「上次拉取时的快照」，
// 远端在快照之后变过 → push 被拒（非快进），必须重新 pull 才能重算编号。

class FakeRemote {
  constructor() {
    this.registry = '';
    this.dirs = [];
  }

  snapshot() {
    return { registry: this.registry, dirs: this.dirs.slice() };
  }

  /** 按 registry 行推导 `devices/` 目录名（真实仓库里目录由日程文件产生，这里等价推导）。 */
  dirsOf(text) {
    const names = new Set();
    for (const entry of parseRegistry(text).entries) {
      names.add(entry.deviceId);
    }
    return Array.from(names);
  }
}

class FakeGitRepo {
  constructor(remote, name) {
    this.remote = remote;
    this.name = name;
    this.view = remote.snapshot();
    this.pulls = 0;
    this.commits = 0;
    this.rejects = 0;
    /** true = 永远被拒（模拟「五台设备同时抢」）。 */
    this.alwaysReject = false;
  }

  readRegistry() {
    return this.view.registry;
  }

  listDeviceDirs() {
    return this.view.dirs.slice();
  }

  async pull() {
    if (this.pullFails === true) {
      throw new Error('网络请求失败：模拟离线');
    }
    this.pulls++;
    this.view = this.remote.snapshot();
  }

  async commitRegistry(text, message) {
    this.commits++;
    assert.equal(typeof message, 'string');
    assert.ok(message.length > 0, '提交信息不能为空');
    if (this.alwaysReject || this.remote.registry !== this.view.registry) {
      this.rejects++;
      throw new Error('推送被拒绝：远端已有新提交。请先执行「拉取」，本应用不会强制覆盖远端');
    }
    this.remote.registry = text;
    const dirs = this.remote.dirsOf(text);
    for (const name of dirs) {
      if (!this.remote.dirs.includes(name)) {
        this.remote.dirs.push(name);
      }
    }
    this.view = this.remote.snapshot();
  }
}

function claimInput(overrides = {}) {
  return { localDeviceId: '', uuid: UUID_A, at: AT, host: 'phone-a', ...overrides };
}

// ---------------------------------------------------------------- 编号计算

describe('deviceRegistry：编号格式与「最大编号 + 1」', () => {
  test('DEVICE_ID_RE 只认 device-<数字>', () => {
    assert.ok(DEVICE_ID_RE.test('device-1'));
    assert.ok(DEVICE_ID_RE.test('device-42'));
    assert.equal(DEVICE_ID_RE.test('phone-a'), false);
    assert.equal(DEVICE_ID_RE.test('device-'), false);
    assert.equal(DEVICE_ID_RE.test('device-x'), false);
    assert.equal(DEVICE_ID_RE.test('Device-1'), false, '目录名大小写敏感');
  });

  test('parseDeviceIds：只取 device-N，去重升序', () => {
    assert.deepEqual(parseDeviceIds(['device-1', 'device-3']), [1, 3]);
    assert.deepEqual(parseDeviceIds(['device-3', 'device-1', 'device-2']), [1, 2, 3]);
    assert.deepEqual(parseDeviceIds(['device-2', 'device-2']), [2], '重复编号去重');
    assert.deepEqual(parseDeviceIds(['phone-a', '.git', 'registry.jsonl']), []);
    assert.deepEqual(parseDeviceIds([]), []);
  });

  test('nextDeviceId：空洞案例（**不是个数 + 1**）', () => {
    assert.equal(nextDeviceId([]), 'device-1', '空仓库 → device-1');
    assert.equal(nextDeviceId(['device-1', 'device-3']), 'device-4', '空洞不回填 → 最大 3 + 1');
    assert.equal(nextDeviceId(['device-3']), 'device-4', '只剩 device-3 也要 +1（不是 device-2）');
    assert.equal(nextDeviceId(['phone-a']), 'device-1', '非 device-N 不参与计数');
    assert.equal(nextDeviceId(['device-1', 'phone-a', 'device-2']), 'device-3');
    assert.equal(nextDeviceId(['device-9']), 'device-10', '两位数进位');
    assert.equal(nextDeviceId(['device-1', 'device-1']), 'device-2');
  });
});

// ---------------------------------------------------------------- registry 解析

describe('deviceRegistry：registry.jsonl 解析（只追加、坏行不传染）', () => {
  test('好行 + 空行 + CRLF 都正常', () => {
    const text =
      toRegistryLine({ deviceId: 'device-1', uuid: UUID_A, at: AT }) +
      '\n\n' +
      toRegistryLine({ deviceId: 'device-2', uuid: UUID_B, at: AT, host: 'pad' }) +
      '\r\n';
    const parsed = parseRegistry(text);
    assert.equal(parsed.errors, 0);
    assert.equal(parsed.entries.length, 2);
    assert.equal(parsed.entries[0].deviceId, 'device-1');
    assert.equal(parsed.entries[0].uuid, UUID_A);
    assert.equal(parsed.entries[0].host, undefined, '没写 host 就不该凭空出现');
    assert.equal(parsed.entries[1].host, 'pad');
  });

  test('坏行只计数（坏 JSON / 缺字段 / 非法 deviceId / 非法 uuid）', () => {
    const good = toRegistryLine({ deviceId: 'device-1', uuid: UUID_A, at: AT });
    const text = [
      good,
      '{不是 JSON}',
      '[1,2,3]',
      JSON.stringify({ deviceId: 'device-2', at: AT }),
      JSON.stringify({ deviceId: 'device 3', uuid: UUID_B, at: AT }),
      JSON.stringify({ deviceId: 'device-4', uuid: 'short', at: AT }),
      ''
    ].join('\n');
    const parsed = parseRegistry(text);
    assert.equal(parsed.entries.length, 1, '只有第一行是好的');
    assert.equal(parsed.errors, 5, '其余 5 行全是坏行');
    assert.equal(parsed.entries[0].deviceId, 'device-1');
  });

  test('空文本 / 全空白 → 零行零错', () => {
    assert.deepEqual(parseRegistry(''), { entries: [], errors: 0 });
    assert.deepEqual(parseRegistry('\n \r\n'), { entries: [], errors: 0 });
  });

  test('uuid 统一小写（身份比较不受大小写影响）', () => {
    const text = toRegistryLine({ deviceId: 'device-1', uuid: UUID_A.toUpperCase(), at: AT });
    const parsed = parseRegistry(text);
    assert.equal(parsed.entries[0].uuid, UUID_A);
  });
});

describe('deviceRegistry：身份靠 uuid', () => {
  const entries = [
    { deviceId: 'device-1', uuid: UUID_A, at: AT },
    { deviceId: 'device-2', uuid: UUID_B, at: AT }
  ];

  test('findDeviceByUuid：命中 / 未命中 / 大小写 / 空 uuid', () => {
    assert.equal(findDeviceByUuid(entries, UUID_A), 'device-1');
    assert.equal(findDeviceByUuid(entries, UUID_B), 'device-2');
    assert.equal(findDeviceByUuid(entries, UUID_A.toUpperCase()), 'device-1', 'uuid 大小写不敏感');
    assert.equal(findDeviceByUuid(entries, '00000000-0000-4000-8000-000000000000'), null);
    assert.equal(findDeviceByUuid(entries, ''), null);
    assert.equal(findDeviceByUuid([], UUID_A), null);
  });

  test('normalizeUuid：非法值一律空串', () => {
    assert.equal(normalizeUuid(UUID_A.toUpperCase()), UUID_A);
    assert.equal(normalizeUuid('  ' + UUID_A + '  '), UUID_A);
    assert.equal(normalizeUuid('short'), '');
    assert.equal(normalizeUuid(''), '');
    assert.equal(normalizeUuid(null), '');
  });

  test('isDeviceIdTaken：自己的行不算占用', () => {
    assert.equal(isDeviceIdTaken(entries, 'device-1', UUID_B), true, '别人的号算占用');
    assert.equal(isDeviceIdTaken(entries, 'device-1', UUID_A), false, '自己的号不算占用');
    assert.equal(isDeviceIdTaken(entries, 'device-3', UUID_A), false);
  });
});

describe('deviceRegistry：单行 JSON（写进 jsonl 的形态）', () => {
  test('toRegistryLine：单行、无换行、可解析、键顺序固定', () => {
    const line = toRegistryLine({ deviceId: 'Device-2', uuid: UUID_A.toUpperCase(), at: AT, host: 'pad-7' });
    assert.equal(line.includes('\n'), false, '必须单行');
    assert.equal(line.includes('\r'), false);
    assert.deepEqual(JSON.parse(line), { deviceId: 'device-2', uuid: UUID_A, at: AT, host: 'pad-7' });
    assert.ok(line.startsWith('{"deviceId":'), '键顺序固定，便于 diff');
    assert.ok(line.indexOf('"at"') < line.indexOf('"host"'), 'host 在最后');
  });

  test('toRegistryLine：host 为空则不写该键（老行不会凭空多字段）', () => {
    const line = toRegistryLine({ deviceId: 'device-1', uuid: UUID_A, at: AT, host: '  ' });
    assert.equal('host' in JSON.parse(line), false);
  });

  test('appendRegistryLine：只追加、缺换行时补一个、空文本只写一行', () => {
    const first = toRegistryLine({ deviceId: 'device-1', uuid: UUID_A, at: AT });
    const second = toRegistryLine({ deviceId: 'device-2', uuid: UUID_B, at: AT });
    assert.equal(appendRegistryLine('', { deviceId: 'device-1', uuid: UUID_A, at: AT }), first + '\n');
    assert.equal(
      appendRegistryLine(first, { deviceId: 'device-2', uuid: UUID_B, at: AT }),
      first + '\n' + second + '\n',
      '上一行没换行结尾也要正确分行'
    );
    assert.equal(
      appendRegistryLine(first + '\n', { deviceId: 'device-2', uuid: UUID_B, at: AT }),
      first + '\n' + second + '\n'
    );
    const parsed = parseRegistry(appendRegistryLine(first, { deviceId: 'device-2', uuid: UUID_B, at: AT }));
    assert.equal(parsed.entries.length, 2);
    assert.equal(parsed.errors, 0);
  });

  test('REGISTRY_PATH 在 devices/ 下（与本机目录同级）', () => {
    assert.equal(REGISTRY_PATH, 'devices/registry.jsonl');
  });
});

describe('deviceRegistry：老设备不重编号', () => {
  const entries = [{ deviceId: 'device-1', uuid: UUID_A, at: AT }];

  test('目录已在仓库 + registry 无冲突 → 沿用（含 phone-a）', () => {
    assert.equal(canReuseLocalDeviceId('phone-a', entries, ['phone-a', 'device-1'], UUID_B), true);
    assert.equal(canReuseLocalDeviceId('device-2', entries, ['device-2'], UUID_B), true);
    assert.equal(canReuseLocalDeviceId('Phone-A', entries, ['phone-a'], UUID_B), true, '大小写归一');
  });

  test('默认值 phone-a 但目录不在仓库 → 不沿用（走自动分配，避免两台设备同名）', () => {
    assert.equal(canReuseLocalDeviceId('phone-a', entries, ['device-1'], UUID_B), false);
    assert.equal(canReuseLocalDeviceId('phone-a', [], [], UUID_B), false);
  });

  test('registry 里被别的 uuid 占着 → 不沿用（真冲突必须换号）', () => {
    assert.equal(canReuseLocalDeviceId('device-1', entries, ['device-1'], UUID_B), false);
    assert.equal(canReuseLocalDeviceId('device-1', entries, ['device-1'], UUID_A), true, '自己的号可以沿用');
  });

  test('非法标识不沿用', () => {
    assert.equal(canReuseLocalDeviceId('', [], ['phone-a'], UUID_B), false);
    assert.equal(canReuseLocalDeviceId('device 1', [], ['device 1'], UUID_B), false);
    assert.equal(canReuseLocalDeviceId('../etc', [], ['../etc'], UUID_B), false);
  });
});

describe('deviceRegistry：抢占（识别已有 uuid / 首次登记）', () => {
  test('registry 里已有本机 uuid 的行 → 直接用那个编号，不重复登记', async () => {
    const remote = new FakeRemote();
    remote.registry =
      toRegistryLine({ deviceId: 'device-2', uuid: UUID_A, at: AT }) + '\n';
    remote.dirs = ['device-2'];
    const repo = new FakeGitRepo(remote, 'A');
    const outcome = await claimDeviceId(repo, claimInput());
    assert.equal(outcome.ok, true);
    assert.equal(outcome.deviceId, 'device-2');
    assert.equal(outcome.registered, false, '不能重复追加一行');
    assert.equal(outcome.auto, true);
    assert.equal(repo.commits, 0, '不该发起提交');
    assert.equal(remote.registry.split('\n').filter((line) => line.trim().length > 0).length, 1);
  });

  test('空仓库首次接入 → device-1，写一行', async () => {
    const remote = new FakeRemote();
    const repo = new FakeGitRepo(remote, 'A');
    const outcome = await claimDeviceId(repo, claimInput());
    assert.equal(outcome.ok, true);
    assert.equal(outcome.deviceId, 'device-1');
    assert.equal(outcome.auto, true);
    assert.equal(outcome.registered, true);
    assert.equal(outcome.attempts, 1);
    const parsed = parseRegistry(remote.registry);
    assert.equal(parsed.entries.length, 1);
    assert.deepEqual(parsed.entries[0], { deviceId: 'device-1', uuid: UUID_A, at: AT, host: 'phone-a' });
  });

  test('空洞仓库（device-1 / device-3）→ 新设备拿 device-4', async () => {
    const remote = new FakeRemote();
    remote.registry = toRegistryLine({ deviceId: 'device-1', uuid: UUID_B, at: AT }) + '\n';
    remote.dirs = ['device-1', 'device-3'];
    const repo = new FakeGitRepo(remote, 'A');
    const outcome = await claimDeviceId(repo, claimInput());
    assert.equal(outcome.deviceId, 'device-4', '空洞不回填');
  });

  test('老标识目录已存在 → 沿用 phone-a（auto=false），但仍登记一行绑定 uuid', async () => {
    const remote = new FakeRemote();
    remote.dirs = ['phone-a'];
    const repo = new FakeGitRepo(remote, 'A');
    const outcome = await claimDeviceId(repo, claimInput({ localDeviceId: 'phone-a', host: '' }));
    assert.equal(outcome.ok, true);
    assert.equal(outcome.deviceId, 'phone-a');
    assert.equal(outcome.auto, false, '沿用老标识不是「自动分配」');
    assert.equal(parseRegistry(remote.registry).entries[0].deviceId, 'phone-a');
  });

  test('pulled:true 时不再多拉一次（调用方刚拉过）', async () => {
    const remote = new FakeRemote();
    const repo = new FakeGitRepo(remote, 'A');
    await claimDeviceId(repo, claimInput({ pulled: true }));
    assert.equal(repo.pulls, 0, '已经拉过就不该再拉');
  });
});

describe('deviceRegistry：并发接入（两台设备同时首次接入）', () => {
  test('先 push 的拿 device-1，被拒的一方重拉后拿 device-2；registry 各一行', async () => {
    const remote = new FakeRemote();
    // 两台设备同时「首次接入」：都先拉到空仓库快照，然后各自算号、提交
    const deviceA = new FakeGitRepo(remote, 'A');
    const deviceB = new FakeGitRepo(remote, 'B');
    const [outcomeA, outcomeB] = await Promise.all([
      claimDeviceId(deviceA, claimInput({ uuid: UUID_A, localDeviceId: '' })),
      claimDeviceId(deviceB, claimInput({ uuid: UUID_B, localDeviceId: '' }))
    ]);

    assert.equal(outcomeA.ok, true);
    assert.equal(outcomeB.ok, true);
    assert.notEqual(outcomeA.deviceId, outcomeB.deviceId, '两台设备最终编号必须不同');

    // 最终编号集合 = {device-1, device-2}（谁先抢到不确定，但必须是这两个）
    assert.deepEqual(
      [outcomeA.deviceId, outcomeB.deviceId].sort(),
      ['device-1', 'device-2'],
      `最终编号：${outcomeA.deviceId} / ${outcomeB.deviceId}`
    );

    // 重试语义：一次成功 + 一次「被拒后重试成功」
    assert.deepEqual(
      [outcomeA.attempts, outcomeB.attempts].sort((left, right) => left - right),
      [1, 2],
      '失败方必须重试（attempts=2），成功方一次就够'
    );
    assert.equal(deviceA.rejects + deviceB.rejects, 1, '只该有一次 push 被拒');

    // registry 恰好两行（只追加，不允许重复登记同一个 uuid）
    const lines = remote.registry.split('\n').filter((line) => line.trim().length > 0);
    assert.equal(lines.length, 2, `registry 行数：${lines.length}`);
    const parsed = parseRegistry(remote.registry);
    assert.equal(parsed.errors, 0);
    assert.deepEqual(
      parsed.entries.map((entry) => entry.uuid).sort(),
      [UUID_A, UUID_B].sort(),
      '两个身份各占一行'
    );
    // 被拒方重试时拉取过（至少 1 次额外 pull）
    assert.ok(deviceA.pulls + deviceB.pulls >= 3, `pull 次数：${deviceA.pulls + deviceB.pulls}`);
  });

  test('五台设备同时抢同一次 → 全部拿到不同编号，行数 = 设备数', async () => {
    const remote = new FakeRemote();
    const uuids = [];
    for (let index = 0; index < 5; index++) {
      uuids.push(`0000000${index}-1111-4222-8333-44445555666${index}`);
    }
    const repos = uuids.map((uuid, index) => {
      const repo = new FakeGitRepo(remote, 'D' + index);
      repo.uuid = uuid;
      return repo;
    });
    const outcomes = await Promise.all(
      repos.map((repo, index) =>
        claimDeviceId(repo, claimInput({ uuid: uuids[index], localDeviceId: '' }))
      )
    );
    const ids = outcomes.map((outcome) => {
      assert.equal(outcome.ok, true, `设备 ${outcome.uuid} 抢占失败：${outcome.message}`);
      return outcome.deviceId;
    });
    assert.equal(new Set(ids).size, 5, `编号必须互不相同：${ids.join(',')}`);
    const lines = remote.registry.split('\n').filter((line) => line.trim().length > 0);
    assert.equal(lines.length, 5);
    assert.equal(parseRegistry(remote.registry).errors, 0);
  });
});

describe('deviceRegistry：fail-closed（抢不到不许乱用一个号）', () => {
  test('push 一直被拒 → 5 次后 E_DEVICE_ID_CONFLICT，且不返回任何编号', async () => {
    const remote = new FakeRemote();
    const repo = new FakeGitRepo(remote, 'A');
    repo.alwaysReject = true;
    const outcome = await claimDeviceId(repo, claimInput());
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, DEVICE_ID_CONFLICT_CODE);
    assert.equal(outcome.code, 'E_DEVICE_ID_CONFLICT');
    assert.equal(outcome.message, '没能抢到设备编号，请稍后重试（已重试 5 次）');
    assert.equal(outcome.message, DEVICE_ID_CONFLICT_MESSAGE);
    assert.equal(outcome.attempts, MAX_CLAIM_ATTEMPTS);
    assert.equal('deviceId' in outcome, false, '失败结果里不能带可用编号');
    assert.equal(remote.registry, '', '仓库里不该留下半行');
  });

  test('拉取失败（仓库不可读）→ E_DEVICE_ID_UNREADABLE，不写任何东西', async () => {
    const remote = new FakeRemote();
    const repo = new FakeGitRepo(remote, 'A');
    repo.pullFails = true;
    const outcome = await claimDeviceId(repo, claimInput());
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, REGISTRY_UNREADABLE_CODE);
    assert.match(outcome.message, /拉取失败/);
    assert.equal(repo.commits, 0);
  });

  test('uuid 不合法 → 直接失败（不会写出半条 registry 行）', async () => {
    const remote = new FakeRemote();
    const repo = new FakeGitRepo(remote, 'A');
    for (const bad of ['', 'short', 'bad uuid!', '   ']) {
      const outcome = await claimDeviceId(repo, claimInput({ uuid: bad }));
      assert.equal(outcome.ok, false, `uuid「${bad}」必须被拒`);
      assert.equal(outcome.code, REGISTRY_UNREADABLE_CODE);
    }
    const outcome = await claimDeviceId(repo, claimInput({ uuid: 'not a uuid' }));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, REGISTRY_UNREADABLE_CODE);
    assert.equal(repo.commits, 0);
    assert.equal(repo.pulls, 0, '身份都不合法，连网络都不该碰');
  });

  test('maxAttempts 可调（1 = 被拒即失败，不重试）', async () => {
    const remote = new FakeRemote();
    const repo = new FakeGitRepo(remote, 'A');
    repo.alwaysReject = true;
    const outcome = await claimDeviceId(repo, claimInput({ maxAttempts: 1 }));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.attempts, 1);
    assert.equal(repo.commits, 1);
  });
});

describe('deviceRegistry：设置页那行只读文案', () => {
  test('describeClaimOutcome：自动 / 沿用 / 空', () => {
    assert.equal(describeClaimOutcome('device-2', true), '本机：device-2（自动分配）');
    assert.equal(describeClaimOutcome('phone-a', false), '本机：phone-a（沿用原标识）');
    assert.equal(describeClaimOutcome('', true), '');
  });
});
