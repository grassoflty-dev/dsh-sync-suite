// 凭据卫生的静态审计：token / AI key 绝不进日志、同步载荷、仓库 URL。
//
// 这些是 .ets / 插件 .ts 源码级不变量（Node 里跑不了 ArkTS 运行时），但「不打印、不拼 URL、
// 不写进 ScheduleRecord」都是纯文本可判定的事实，适合用测试固化，避免后续改动悄悄引入泄露。
//
// 依据：docs/CONTRACT.md §0「密钥永不进入同步载荷、日志、测试 fixture」；
//       docs/DATA-CONTRACT.md §3（jsonl 只有 ScheduleRecord 的字段）。
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readSettingsSources } from './settingsSources.mjs';

const APP = fileURLToPath(new URL('../../entry/src/main/ets/', import.meta.url));
const REPO_SRC = fileURLToPath(new URL('../../../../packages/dsh-git-config-sync/src/', import.meta.url));

// 因 A2 拆分移动：设置页界面现在在 `pages/Settings.ets` + `components/settings/*.ets`。
// 凭据卫生的审计对象是「设置页整体」，所以锚点改成合并源码（页面 + 五个 section + bits）；
// 断言本身不变（token/AI key 仍然只能出现在 Password 输入框里、不许进 Text）。
const SETTINGS_PAGE = readSettingsSources();
const GIT_SERVICE = readFileSync(join(APP, 'services/GitSyncService.ets'), 'utf8');
const SETTINGS_STORE = readFileSync(join(APP, 'services/settingsStore.ets'), 'utf8');
const SCHEDULE_STORE = readFileSync(join(APP, 'services/scheduleStore.ets'), 'utf8');
const DEEPSEEK = readFileSync(join(APP, 'services/deepseek.ets'), 'utf8');
const TYPES = readFileSync(join(APP, 'model/types.ts'), 'utf8');

/** 可能接触凭据的 App 源码（页面 + 服务 + 模型）。 */
const SECRET_TOUCHING_SOURCES = [
  ['pages/Settings.ets', SETTINGS_PAGE],
  ['services/GitSyncService.ets', GIT_SERVICE],
  ['services/settingsStore.ets', SETTINGS_STORE],
  ['services/scheduleStore.ets', SCHEDULE_STORE],
  ['services/deepseek.ets', DEEPSEEK],
  ['model/types.ts', TYPES]
];

/** 去掉整行注释（`//`、`*`、`/*`、`/**` 开头），只留代码行。 */
function codeLines(source) {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^(\/\/|\*|\/\*)/.test(line));
}

/** 递归收集目录下指定后缀的文件。 */
function collectFiles(dir, suffix, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const info = statSync(full);
    if (info.isDirectory()) {
      collectFiles(full, suffix, out);
    } else if (full.endsWith(suffix)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 唯一允许的日志行（B3 请求日志）：只有源/模型/耗时/成败四个字段。
 *
 * 白名单按「整行逐字相等」比对，任何改动（多带一个参数、换成模板串）都会让本测试失败，
 * 必须连同 `tools/test/aiReliability.test.mjs` 一起评审。
 */
const ALLOWED_AI_LOG_LINE =
  "console.info('[ai] provider=%s model=%s latency=%dms ok=%s', providerId, model, latencyMs, ok ? 'true' : 'false');";

describe('日志：App 侧不打印任何请求头/请求体（含 token / AI key）', () => {
  test('页面与服务里没有 console.* / hilog.* 调用（唯一例外是 deepseek 的 [ai] 日志）', () => {
    let allowed = 0;
    for (const [name, source] of SECRET_TOUCHING_SOURCES) {
      for (const line of codeLines(source)) {
        if (name === 'services/deepseek.ets' && line === ALLOWED_AI_LOG_LINE) {
          allowed++;
          continue;
        }
        assert.equal(/console\.(log|info|warn|error|debug)/.test(line), false, `${name} 里有 console 调用：${line}`);
        assert.equal(/hilog\.(debug|info|warn|error|fatal)/.test(line), false, `${name} 里有 hilog 调用：${line}`);
      }
    }
    assert.equal(allowed, 1, 'deepseek 的 [ai] 行为日志必须恰好一条');
  });

  test('token / aiKey 从未被拼进任何 Text(...) 展示（只能用 Password 输入框）', () => {
    for (const expression of ['this.token', 'this.aiKey']) {
      const escaped = expression.replace('.', '\\.');
      // 直接渲染：Text(this.token) / Text( this.token )
      const direct = new RegExp(`Text\\(\\s*${escaped}\\s*\\)`);
      // 模板串插值：Text(`…${this.token}…`)（只在 Text(...) 的参数范围内找，
      // 不误伤 `x-access-token:${this.token.trim()}` 这类 Authorization 头构造）
      const interpolated = new RegExp(`Text\\([^)]*\\$\\{[^}]*${escaped}\\b`);
      assert.equal(direct.test(SETTINGS_PAGE), false, `${expression} 不得直接渲染成文本`);
      assert.equal(interpolated.test(SETTINGS_PAGE), false, `${expression} 不得插值进展示文本`);
    }
    const passwordInputs = [...SETTINGS_PAGE.matchAll(/\.type\(InputType\.Password\)/g)];
    assert.ok(passwordInputs.length >= 2, `token/aiKey 输入框都必须是密码框，实际 ${passwordInputs.length} 个`);
  });
});

describe('token 只用于 Authorization 头，绝不进 URL', () => {
  test('源码里没有把 token 拼进 http(s) URL 的写法', () => {
    for (const [name, source] of SECRET_TOUCHING_SOURCES) {
      for (const line of codeLines(source)) {
        assert.equal(
          /https?:\/\/[^'"`\n]*\$\{[^}]*token/i.test(line),
          false,
          `${name} 把 token 拼进了 URL：${line}`
        );
        assert.equal(/(repoUrl|remote)[^=]*\+\s*[^;]*token/i.test(line), false, `${name} 把 token 拼进了仓库地址：${line}`);
      }
    }
  });

  test('同一行代码里不同时出现 repoUrl 与 token（避免 https://token@host 形态）', () => {
    for (const [name, source] of SECRET_TOUCHING_SOURCES) {
      for (const line of codeLines(source)) {
        const both = /repoUrl/i.test(line) && /token/i.test(line);
        // 允许的例外：配置对象里两个字段各占一行，不会命中；命中即需人工确认
        assert.equal(both, false, `${name} 同一行同时出现 repoUrl 与 token：${line}`);
      }
    }
  });

  test('token 的使用点确实是 Basic / Bearer 头（正向证据，防止「悄悄改走 URL」）', () => {
    assert.match(SETTINGS_PAGE, /headers\['Authorization'\] = `Basic \$\{this\.basicAuthHeader\(\)\}`/);
    assert.match(GIT_SERVICE, /headers\['Authorization'\] = 'Basic '/);
    assert.match(DEEPSEEK, /'Authorization': `Bearer \$\{apiKey\}`/);
    // 探测/请求地址来自配置里的仓库地址，而不是 Authorization 值
    assert.match(GIT_SERVICE, /const base: string = repoUrl\.replace\(/);
  });

  test('validateRepoUrl 拒绝带账号密码/token 的地址（用户也没机会把凭据存进 repoUrl）', () => {
    const MODEL = readFileSync(join(APP, 'model/repoUrl.ts'), 'utf8');
    assert.match(MODEL, /不要写用户名、密码或 token/);
  });
});

describe('同步载荷（jsonl）里没有凭据字段', () => {
  test('ScheduleRecord 接口不含 token / key / secret / password 字段', () => {
    const start = TYPES.indexOf('export interface ScheduleRecord {');
    const end = TYPES.indexOf('}', start);
    const block = TYPES.slice(start, end);
    assert.ok(block.length > 0);
    assert.equal(/token|secret|password|credential|api_?key|aiKey/i.test(block), false, `ScheduleRecord 出现凭据字段：${block}`);
  });

  test('encodeRecord 产出的 JSON 键名里没有凭据字段（未知字段也不该被塞进来）', async () => {
    const { encodeRecord } = await import('../.build/model/jsonl.js');
    const record = {
      id: 'r1',
      ts: '2026-11-15T09:00:00+08:00',
      title: '周会',
      body: '正文',
      author: '我',
      done: false,
      ai_processed: false,
      attachments: [{ sha256: 'a'.repeat(64), name: `${'a'.repeat(64)}.png`, pageIndex: 0 }]
    };
    const line = encodeRecord(record);
    const keys = Object.keys(JSON.parse(line));
    for (const key of keys) {
      assert.equal(/token|secret|password|credential|api_?key/i.test(key), false, `载荷里出现凭据键：${key}`);
    }
    assert.equal(line.includes('token'), false, '整行里不应出现 token 字样');
  });

  test('settingsStore 注释与实现都明确「仅存本机、不进同步载荷」', () => {
    assert.match(SETTINGS_STORE, /值不外泄，不进 Git 同步载荷/);
    assert.match(SCHEDULE_STORE, /schedules\/YYYY-MM-DD\.jsonl/);
  });
});

describe('插件侧（packages/dsh-git-config-sync）凭据处理', () => {
  const engineFiles = collectFiles(REPO_SRC, '.ts');

  test('插件源码不往控制台打印（引擎与 RPC 都靠返回结构化错误）', () => {
    for (const file of engineFiles) {
      const source = readFileSync(file, 'utf8');
      for (const line of codeLines(source)) {
        assert.equal(/console\.(log|info|warn|error|debug)/.test(line), false, `${file} 里有 console 调用：${line}`);
      }
    }
  });

  test('插件把 token 写在 0600 的 credentials 文件里（writeFilePrivate），不写进普通 settings', () => {
    const settings = readFileSync(join(REPO_SRC, 'engine/settings.ts'), 'utf8');
    assert.match(settings, /writeFilePrivate\(this\.paths\.credentialsFile/);
    assert.match(settings, /path: 'credentials\.json'|credentialsFile/);
  });
});
