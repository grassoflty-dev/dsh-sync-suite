// 同步作用域（`model/syncScope.ts`）测试：提交路径只写 `devices/<deviceId>/`。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 重点（Lead 的 P0-3 回归点）：`devices/pc-a-evil/` 这类「前缀相同但设备不同」的路径必须被拒，
// `../` 穿越与绝对路径必须被拒；过滤保持输入顺序。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  DEVICE_ID_PATTERN,
  assertWithinDevice,
  devicePathPrefix,
  filterPathsForDevice,
  normalizeDeviceId,
  normalizeRepoPath
} from '../.build/model/syncScope.js';

describe('normalizeDeviceId', () => {
  test('合法设备标识：去首尾空白、转小写，边界长度 1 / 32', () => {
    assert.equal(normalizeDeviceId('phone-a'), 'phone-a');
    assert.equal(normalizeDeviceId('  Phone-A  '), 'phone-a');
    assert.equal(normalizeDeviceId('PC-A'), 'pc-a');
    assert.equal(normalizeDeviceId('a'), 'a');
    assert.equal(normalizeDeviceId('a1'), 'a1');
    assert.equal(normalizeDeviceId('a' + 'b'.repeat(31)), 'a' + 'b'.repeat(31), '32 位合法');
    assert.match('a1-b2', DEVICE_ID_PATTERN);
  });

  test('非法设备标识直接抛错（不静默回退）', () => {
    for (const raw of ['', '   ', '-phone', '_phone', 'phone_a', 'phone a', 'a'.repeat(33), '设备', '../pc-a']) {
      assert.throws(() => normalizeDeviceId(raw), /设备标识不合法/, `应拒绝：${JSON.stringify(raw)}`);
    }
    assert.throws(() => normalizeDeviceId(null), /设备标识不合法/);
    assert.throws(() => normalizeDeviceId(undefined), /设备标识不合法/);
  });
});

describe('devicePathPrefix', () => {
  test('固定为 devices/<id>/（带结尾斜杠，避免前缀误匹配）', () => {
    assert.equal(devicePathPrefix('phone-a'), 'devices/phone-a/');
    assert.equal(devicePathPrefix(' Phone-A '), 'devices/phone-a/');
    assert.throws(() => devicePathPrefix('phone_a'), /设备标识不合法/);
  });
});

describe('normalizeRepoPath', () => {
  test('归一化反斜杠 / ./ / 重复斜杠 / 尾斜杠', () => {
    assert.equal(normalizeRepoPath('devices/phone-a/schedules/a.jsonl'), 'devices/phone-a/schedules/a.jsonl');
    assert.equal(normalizeRepoPath('devices\\phone-a\\schedules\\a.jsonl'), 'devices/phone-a/schedules/a.jsonl');
    assert.equal(normalizeRepoPath('./devices/phone-a//a.jsonl'), 'devices/phone-a/a.jsonl');
    assert.equal(normalizeRepoPath('devices/phone-a/'), 'devices/phone-a');
  });

  test('绝对路径与 ../ 穿越返回 null', () => {
    for (const raw of ['', '   ', '/devices/phone-a/a', 'C:/repo/a', 'C:\\repo\\a', '../devices/phone-a/a', 'devices/../a', 'devices/phone-a/../pc-a/a']) {
      assert.equal(normalizeRepoPath(raw), null, `应判非法：${JSON.stringify(raw)}`);
    }
  });
});

describe('filterPathsForDevice', () => {
  test('只保留本设备路径、保持输入顺序，拒绝类似前缀与越界写法', () => {
    const paths = [
      'devices/pc-a/schedules/2026-11-14.jsonl',
      'devices/phone-a/schedules/2026-11-14.jsonl',
      'devices/phone-a-evil/schedules/2026-11-14.jsonl',
      'devices/phone-a/attachments/ab12.png',
      '../devices/phone-a/schedules/2026-11-15.jsonl',
      '/devices/phone-a/schedules/2026-11-16.jsonl',
      'notes.md',
      'devices/phone-a'
    ];
    assert.deepEqual(filterPathsForDevice(paths, 'phone-a'), [
      'devices/phone-a/schedules/2026-11-14.jsonl',
      'devices/phone-a/attachments/ab12.png',
      'devices/phone-a'
    ]);
  });

  test('输出为规范化路径（反斜杠 / ./ / 重复斜杠），设备标识先规范化', () => {
    assert.deepEqual(
      filterPathsForDevice(['devices\\phone-a\\a.jsonl', './devices/phone-a//b.jsonl'], ' PHONE-A '),
      ['devices/phone-a/a.jsonl', 'devices/phone-a/b.jsonl']
    );
    // 路径大小写不同不是同一目录（设备目录名小写，Linux/远端区分大小写）
    assert.deepEqual(filterPathsForDevice(['devices/PHONE-A/a.jsonl'], 'phone-a'), []);
  });

  test('空输入 / 非数组输入返回空数组；非法 deviceId 抛错', () => {
    assert.deepEqual(filterPathsForDevice([], 'phone-a'), []);
    assert.deepEqual(filterPathsForDevice(null, 'phone-a'), []);
    assert.throws(() => filterPathsForDevice(['devices/phone-a/a'], 'phone_a'), /设备标识不合法/);
  });
});

describe('assertWithinDevice', () => {
  test('接受本设备目录内的路径（含目录本身、反斜杠与重复斜杠写法）', () => {
    for (const path of [
      'devices/phone-a/schedules/2026-11-14.jsonl',
      'devices/phone-a/attachments/ab12.png',
      'devices/phone-a/sub/deep/x.png',
      'devices/phone-a',
      'devices/phone-a/',
      'devices\\phone-a\\schedules\\2026-11-14.jsonl',
      './devices/phone-a//schedules/2026-11-14.jsonl'
    ]) {
      assert.doesNotThrow(() => assertWithinDevice(path, 'phone-a'), `应通过：${path}`);
    }
  });

  test('拒绝类似前缀 devices/pc-a-evil/ 与其它设备目录', () => {
    assert.throws(() => assertWithinDevice('devices/pc-a-evil/schedules/a.jsonl', 'pc-a'), /越界|不在/);
    assert.throws(() => assertWithinDevice('devices/pc-a2/schedules/a.jsonl', 'pc-a'), /越界|不在/);
    assert.throws(() => assertWithinDevice('devices/pc-b/schedules/a.jsonl', 'pc-a'), /越界|不在/);
    assert.throws(() => assertWithinDevice('devices', 'pc-a'), /越界|不在/);
    assert.throws(() => assertWithinDevice('devices/PHONE-A/a.jsonl', 'phone-a'), /越界|不在/);
  });

  test('拒绝 ../ 穿越与绝对路径', () => {
    assert.throws(() => assertWithinDevice('../devices/phone-a/a.jsonl', 'phone-a'), /非法/);
    assert.throws(() => assertWithinDevice('devices/phone-a/../pc-b/a.jsonl', 'phone-a'), /非法/);
    assert.throws(() => assertWithinDevice('devices\\phone-a\\..\\pc-b\\a.jsonl', 'phone-a'), /非法/);
    assert.throws(() => assertWithinDevice('/devices/phone-a/a.jsonl', 'phone-a'), /非法/);
    assert.throws(() => assertWithinDevice('C:/repo/devices/phone-a/a.jsonl', 'phone-a'), /非法/);
    assert.throws(() => assertWithinDevice('C:\\repo\\devices\\phone-a\\a.jsonl', 'phone-a'), /非法/);
    assert.throws(() => assertWithinDevice('', 'phone-a'), /非法/);
  });

  test('非法 deviceId 时抛错（连前缀都不成立）', () => {
    assert.throws(() => assertWithinDevice('devices/phone_a/a', 'phone_a'), /设备标识不合法/);
  });
});

describe('filter 与 assert 的一致性（不变量）', () => {
  test('过滤结果逐条都能通过 assert；被 assert 拒绝的路径不会出现在过滤结果里', () => {
    const candidates = [
      'devices/phone-a/schedules/2026-11-14.jsonl',
      'devices/phone-a/attachments/ab12.png',
      'devices/phone-a',
      'devices/phone-a-evil/schedules/x.jsonl',
      'devices/pc-b/schedules/x.jsonl',
      '../devices/phone-a/x.jsonl',
      '/devices/phone-a/x.jsonl',
      'devices/phone-a/../pc-b/x.jsonl',
      'README.md',
      ''
    ];
    const kept = filterPathsForDevice(candidates, 'phone-a');
    for (const path of kept) {
      assert.doesNotThrow(() => assertWithinDevice(path, 'phone-a'), `过滤结果必须合法：${path}`);
    }
    // 被过滤掉的路径里，凡能被 assert 接受的都不应被丢（保持一致）
    for (const path of candidates) {
      if (kept.includes(path)) {
        continue;
      }
      let accepted = false;
      try {
        assertWithinDevice(path, 'phone-a');
        accepted = true;
      } catch {
        accepted = false;
      }
      assert.equal(accepted, false, `被过滤但 assert 认为合法的路径说明两者不一致：${path}`);
    }
  });
});
