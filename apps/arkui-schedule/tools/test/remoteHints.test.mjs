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
import { ETS_ROOT, readRemoteSection, readSettingsFile, readSettingsPage } from './settingsSources.mjs';

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

describe('mod-remote-hints：渲染走表查找，源码里没有写死的提示', () => {
  const REMOTE_GROUP = readRemoteSection();
  const PAGE = readSettingsPage();
  const MODEL = readFileSync(new URL('../../entry/src/main/ets/model/remoteAccess.ts', import.meta.url), 'utf8');

  test('RemoteSection 通过 remoteModeHint(this.remoteMode) 渲染（不是硬编码字符串）', () => {
    assert.match(REMOTE_GROUP, /import \{[\s\S]*?remoteModeHint[\s\S]*?\} from '\.\.\/\.\.\/model\/remoteAccess';/);
    // mod-uu-hint-device：必须内联 Text 才能随 @Prop remoteMode 刷新；
    // 经 @Builder 按值传 str 会停在上一次的方式（真机 item 5 根因）。
    assert.match(REMOTE_GROUP, /Text\(remoteModeHint\(this\.remoteMode\)\)/);
  });

  test('RemoteSection / Settings 里都没有写死的旧局域网提示文案', () => {
    for (const [name, source] of [['RemoteSection', REMOTE_GROUP], ['Settings', PAGE]]) {
      assert.equal(source.includes('平板需与电脑在同一局域网'), false, `${name} 不能再写死局域网提示`);
      assert.equal(source.includes('地址含 token，只存本机'), false, `${name} 不能再写死旧的 token 附注`);
    }
  });

  test('模型是单一事实来源：六条逐字文案都在 REMOTE_MODE_HINTS 表里', () => {
    const table = MODEL.slice(MODEL.indexOf('export const REMOTE_MODE_HINTS'), MODEL.indexOf('export function remoteModeHint'));
    for (const mode of REMOTE_MODE_ORDER) {
      assert.ok(table.includes(EXPECTED[mode]), `表里缺 ${mode} 的逐字文案`);
    }
    assert.match(MODEL, /export function remoteModeHint\(raw: string\): string/);
  });
});

// ---------------------------------------------------------------------------
// mod-uu-hint-device：真机 item 5 的第二渲染路径守卫。
// 历史 bug：选 UU 时页面显示 manual 的 spec.description（另一条状态路径），
// 且 table hint 因为 `else if (remoteUrlError)` 在错误态下被吞掉；强制重渲染也没用。
// 本组把「只有一条路径、逐字等于表、旧串绝迹、错误分支不能吞提示」钉死。
// ---------------------------------------------------------------------------
describe('mod-uu-hint-device：每种方式恰好一条提示且逐字等于 REMOTE_MODE_HINTS[mode]', () => {
  const REMOTE_GROUP = readRemoteSection();
  const PAGE = readSettingsPage();
  const MODEL = readFileSync(new URL('../../entry/src/main/ets/model/remoteAccess.ts', import.meta.url), 'utf8');
  const REMOTE_CONTROL = readSettingsFile('pages/RemoteControl.ets');
  /** 真机 item 5  observed string（manual 的旧 spec.description）。 */
  const COMPETING = '你自己已有一条能访问这台电脑的地址，App 只负责保存与归一。';

  /** 递归收集 app 侧全部 ArkTS 源（只含源码，不含 build 缓存），用于全仓 grep。 */
  function collectSources(dir) {
    let out = '';
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        out += collectSources(full);
      } else if (/\.(ets|ts)$/.test(entry.name)) {
        out += `${readFileSync(full, 'utf8')}\n`;
      }
    }
    return out;
  }
  const ALL_APP_SOURCE = collectSources(ETS_ROOT);

  test('组件里只有一处方式提示渲染调用，六种方式都逐字等于表里的文案', () => {
    const sites = REMOTE_GROUP.match(/Text\(remoteModeHint\(this\.remoteMode\)\)/g) ?? [];
    assert.equal(sites.length, 1, `方式提示渲染点必须恰好 1 处，实际 ${sites.length}`);
    assert.equal(REMOTE_GROUP.includes('this.HintLine(remoteModeHint('), false, '不能经 @Builder 按值传 str（真机停在上一次方式）');
    for (const mode of REMOTE_MODE_ORDER) {
      assert.equal(renderedHint(mode), REMOTE_MODE_HINTS[mode], `${mode} 的唯一提示必须等于表`);
    }
  });

  test('每条方式提示文案在 app 源码里只出现一次（就是表本身）', () => {
    for (const mode of REMOTE_MODE_ORDER) {
      const occurrences = ALL_APP_SOURCE.split(EXPECTED[mode]).length - 1;
      assert.equal(occurrences, 1, `${mode} 的逐字文案出现 ${occurrences} 次；只允许表里那一份`);
    }
  });

  test('竞争串与 spec.description 全仓绝迹（grep 断言）', () => {
    assert.equal(ALL_APP_SOURCE.includes(COMPETING), false, 'manual 的旧说明串不得再出现在任何 app 源里');
    assert.equal(MODEL.includes('description:'), false, 'RemoteModeSpec / REMOTE_MODES 不得再有 description 字段');
    assert.equal(REMOTE_GROUP.includes('Text(this.remoteSpec().description)'), false, '第二渲染路径已删除');
    for (const mode of REMOTE_MODE_ORDER) {
      assert.equal('description' in REMOTE_MODES[mode], false, `${mode} 的 spec 不得携带 description`);
    }
  });

  test('渲染优先级不能复活旧串：错误红字与方式提示是两条独立的行', () => {
    assert.equal(REMOTE_GROUP.includes('else if (remoteModeHint('), false, '提示不得挂在红字分支的 else if 上');
    const errorIdx = REMOTE_GROUP.indexOf('if (this.remoteUrlError.length > 0)');
    const errorTextIdx = REMOTE_GROUP.indexOf('this.ErrorText(this.remoteUrlError)', errorIdx);
    const errorCloseIdx = REMOTE_GROUP.indexOf('}', errorTextIdx);
    const hintIdx = REMOTE_GROUP.indexOf('if (remoteModeHint(this.remoteMode).length > 0)');
    assert.ok(errorIdx >= 0 && errorTextIdx > errorIdx && errorCloseIdx > errorTextIdx, '红字分支结构变了，重新核对');
    assert.ok(hintIdx > errorCloseIdx, '方式提示必须在红字分支闭合后独立渲染，错误态不许吞掉提示');
  });

  test('最近成功记录只做带标签的重连按钮，不当方式提示', async () => {
    assert.match(REMOTE_GROUP, /label: this\.reconnectText,/, '重连文案是 ActionButton 的 label');
    assert.equal(REMOTE_GROUP.includes('HintLine(this.reconnectText'), false, '重连文案不得走 HintLine');
    assert.equal(PAGE.includes('HintLine(this.reconnectText'), false, '页面也不得把重连文案当提示');
    assert.equal(REMOTE_CONTROL.includes(COMPETING), false, '远程控制页不得出现旧说明串');
    const { reconnectLabel } = await import('../.build/model/remoteUrl.js');
    const label = reconnectLabel({ url: 'http://a:1/', at: Date.now() }, Date.now());
    assert.equal(
      REMOTE_MODE_ORDER.some((mode) => REMOTE_MODE_HINTS[mode] === label),
      false,
      '重连按钮文案绝不能与任何方式提示相同'
    );
  });
});
