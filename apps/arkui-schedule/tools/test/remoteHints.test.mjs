// mod-remote-hints：「远程控制」前置条件提示按访问方式唯一（keyed-hint）守卫。
//
// 背景 bug：`RemoteSection.ets` 曾把「平板需与电脑在同一局域网；地址含 token，只存本机」
// 写死在方式选择器下方——选了「网易 UU 远程」也照样显示局域网前提，是错误且误导的。
// 现在唯一的文案来源是 `model/remoteAccess.ts` 的 `REMOTE_MODE_HINTS` 表，
// 组件只做 `remoteModeHint(this.remoteMode)` 查表渲染。
//
// 两条防线：
// 1. 纯函数表测试逐字断言六种方式的文案，且断言表**覆盖每一个枚举值**：
//    以后新增一种方式却忘了加提示 → 表不覆盖枚举 → 本测试失败（无法静默继承错误的提示）；
// 2. 静态断言源码里渲染走表查找、组件/页面没有写死的旧文案。
//
// 前置：先跑 `node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json`。
// `remoteAccess.ts` 运行期 import `./remoteUrl`（无扩展名），这里为测试进程补 `.js` 后缀。
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { ETS_ROOT, readSettingsFile, readSettingsPage } from './settingsSources.mjs';

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

const { REMOTE_MODE_HINTS, REMOTE_MODES, REMOTE_MODE_ORDER, remoteModeHint } = await import(
  '../.build/model/remoteAccess.js'
);

/** 契约文案（逐字）：与 `docs/REMOTE-ACCESS-OPTIONS.md` 的 2026-11-20 更新段一致。 */
const EXPECTED = {
  lan: '平板与电脑在同一 Wi-Fi/局域网，填电脑的局域网 IP:端口。',
  tailscale: '两端都加入同一个 tailnet；平板侧必须用鸿蒙原生 Tailscale 客户端（卓易通不可用），填对方 100.x IPv4 地址；不需要端口映射。',
  cloudflare: '电脑侧 cloudflared 隧道已启动，填分配的 *.trycloudflare.com（或自定义域名）地址。',
  ipv6: '电脑有公网 IPv6 且防火墙放行该端口，填 [地址]:端口；平板需支持 IPv6。',
  manual: '填完整可访问地址（含协议）；地址与令牌会被校验，失败原因见红字。',
  uu: '电脑与平板都安装并登录 网易UU远程；在 UU 客户端里把电脑上的 DSH 端口做「端口映射」，再把 UU 给出的入口地址填到这里；不是同一局域网（也不用在路由器上做端口映射）。'
};

/**
 * 每种方式的**正向**特征短语（只出现在自己的文案里）。
 *
 * 注意 UU 文案逐字含有「不是同一局域网（也不用在路由器上做端口映射）」——局域网与**路由器**端口映射
 * 在 UU 里是**否定**语义（UU 客户端内仍要做端口映射），所以 LAN 的特征短语取更具体的
 * 「同一 Wi-Fi/局域网」，避免把 UU 的否定句误判成串味；UU 自己的否定语义另有一条断言专门钉住。
 */
const SIGNATURE = {
  lan: '同一 Wi-Fi/局域网',
  tailscale: 'tailnet',
  cloudflare: 'trycloudflare.com',
  ipv6: '公网 IPv6',
  manual: '填完整可访问地址',
  uu: '网易UU远程'
};

/** 模拟组件渲染结果：查表为空就不渲染（与 `else if (remoteModeHint(...).length > 0)` 同口径）。 */
function renderedHint(mode) {
  const hint = remoteModeHint(mode);
  return hint.length > 0 ? hint : '';
}

describe('mod-remote-hints：前置条件提示表按方式唯一（纯函数）', () => {
  test('表覆盖 REMOTE_MODE_ORDER 的每一个枚举值，且没有多余/过期条目', () => {
    assert.deepEqual([...REMOTE_MODE_ORDER].sort(), Object.keys(EXPECTED).sort(), '测试契约本身须与枚举同步');
    assert.deepEqual(
      Object.keys(REMOTE_MODE_HINTS).sort(),
      [...REMOTE_MODE_ORDER].sort(),
      '新增方式没登记提示（或删了方式还留着提示）都会失败——这就是「新方式不能继承错误提示」的守卫'
    );
    for (const mode of REMOTE_MODE_ORDER) {
      const hint = REMOTE_MODE_HINTS[mode];
      assert.equal(typeof hint, 'string', `${mode} 的提示必须是字符串`);
      assert.ok(hint.length > 0, `${mode} 的提示不能是空串`);
    }
  });

  test('每种方式渲染出的提示逐字等于自己的契约文案', () => {
    for (const mode of REMOTE_MODE_ORDER) {
      assert.equal(renderedHint(mode), EXPECTED[mode], `${mode} 的提示与契约不一致`);
    }
  });

  test('keyed-hint：每种方式只含自己的特征短语，不含任何其它方式的特征短语', () => {
    for (const mode of REMOTE_MODE_ORDER) {
      const hint = renderedHint(mode);
      assert.ok(hint.includes(SIGNATURE[mode]), `${mode} 的提示应含自己的特征短语「${SIGNATURE[mode]}」`);
      for (const other of REMOTE_MODE_ORDER) {
        if (other === mode) {
          continue;
        }
        assert.equal(
          hint.includes(SIGNATURE[other]),
          false,
          `${mode} 的提示不得含 ${other} 的特征短语「${SIGNATURE[other]}」；实际：${hint}`
        );
      }
    }
  });

  test('任务点名的串味组合：UU 不冒充局域网/tailnet，LAN 不提 tailnet，Tailscale 不提局域网', () => {
    const uu = renderedHint('uu');
    assert.equal(uu.includes('同一 Wi-Fi/局域网'), false, 'UU 不得带局域网的正向前提');
    assert.equal(uu.includes('tailnet'), false);
    assert.equal(uu.includes('trycloudflare.com'), false);
    assert.equal(uu.includes('公网 IPv6'), false);
    assert.equal(uu.includes('填完整可访问地址'), false);
    assert.equal(renderedHint('lan').includes('tailnet'), false);
    assert.equal(renderedHint('tailscale').includes('局域网'), false);
  });

  test('UU 的否定语义逐字保留：不是同一局域网，也不需要端口映射', () => {
    assert.ok(renderedHint('uu').includes('不是同一局域网（也不用在路由器上做端口映射）'), 'UU 必须明确否认局域网前提，并说明 UU 侧仍需端口映射');
  });

  test('未知/非字符串方式返回空串（fail-closed，绝不继承别的方式的提示）', () => {
    for (const bad of ['', 'nope', 'LAN', ' lan ', undefined, null, 42]) {
      assert.equal(remoteModeHint(bad), '', `未知方式 ${JSON.stringify(bad)} 不得拿到任何提示`);
      assert.equal(renderedHint(bad), '');
    }
  });
});

// mod-settings-remote-dedupe（old→new）：RemoteSection 已删除，方式提示不再由设置页渲染。
// 旧断言（组件内联 Text(remoteModeHint(...))、一条提示一行、重连按钮形态）整段 retarget 到
// 「旧串绝迹 + 表仍是单一事实来源 + 实例页是唯一配置处」。纯函数表测试（本文件上半段）保持不变。
describe('mod-remote-hints（retarget）：提示表仍是唯一事实来源，设置页不再渲染方式提示', () => {
  const PAGE = readSettingsPage();
  const MODEL = readFileSync(new URL('../../entry/src/main/ets/model/remoteAccess.ts', import.meta.url), 'utf8');
  const INSTANCES = readSettingsFile('pages/Instances.ets');

  test('模型是单一事实来源：六条逐字文案都在 REMOTE_MODE_HINTS 表里', () => {
    const table = MODEL.slice(MODEL.indexOf('export const REMOTE_MODE_HINTS'), MODEL.indexOf('export function remoteModeHint'));
    for (const mode of REMOTE_MODE_ORDER) {
      assert.ok(table.includes(EXPECTED[mode]), `表里缺 ${mode} 的逐字文案`);
    }
    assert.match(MODEL, /export function remoteModeHint\(raw: string\): string/);
  });

  test('RemoteSection.ets 已删除；设置页没有 remoteModeHint 渲染点', () => {
    let exists = true;
    try {
      readSettingsFile('components/settings/RemoteSection.ets');
    } catch {
      exists = false;
    }
    assert.equal(exists, false, 'RemoteSection.ets 必须删除');
    assert.equal(/remoteModeHint\(this\.remoteMode\)/.test(PAGE), false, '设置页不该再渲染方式提示');
    assert.equal(/remoteSpec\(\)\.description/.test(PAGE), false, '第二渲染路径已删除');
  });

  test('旧写死的局域网提示 / manual 说明串全仓绝迹', () => {
    for (const stale of ['平板需与电脑在同一局域网', '地址含 token，只存本机']) {
      assert.equal(PAGE.includes(stale), false, `设置页不能再写死：${stale}`);
    }
  });

  test('唯一配置处是实例页：表单复用 REMOTE_MODE_ORDER 与归一规则', () => {
    assert.match(INSTANCES, /REMOTE_MODE_ORDER/, '实例页仍是方式枚举唯一展示处');
    assert.match(INSTANCES, /normalizeRemoteUrl\(this\.formUrl\.trim\(\)\)/, '实例页保存仍走归一');
  });
});
