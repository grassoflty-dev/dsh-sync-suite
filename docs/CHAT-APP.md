# CHAT-APP：App 侧「云端对话」只读页面（P1）

> 范围：`apps/arkui-schedule` 的**列表 + 只读详情**。上位设计见 `docs/CHAT-SYNC.md`（§2 数据布局、
> §5 只读浏览、§8 P1 验收）。本文只记录 App 侧落地细节：页面结构、三态文案、消息提取口径、
> 以及「什么算空态、什么算错误」——这三件事最容易被后人改回去。

## 1. 入口与路由

| 位置 | 行为 |
| --- | --- |
| 设置页「数据」组之后、「关于」之前 | 一行「云端对话（只读 ›）」→ `router.pushUrl('pages/Chats')` |
| `pages/Chats` | 会话列表；点行 → `router.pushUrl('pages/ChatDetail', { params: { id } })` |
| `pages/ChatDetail` | 只读会话正文；返回按钮 → `router.back()` |

- **首页页头不动**：仍只有「今天」+「⚙ 设置」（`tools/test/indexHeader.test.mjs` 守着）。
- **设置页只加一行入口**：会话列表不塞进设置页（设置页是「改配置」，会话是「反复来读」）。
- 路由登记：`entry/src/main/resources/base/profile/main_pages.json` **与**
  `entry/src/harmony/resources/base/profile/main_pages.json` 都要加这两页。
  后者是鸿蒙构建的实际清单（`tools/overlay.mjs` 把 `entry/src/harmony/**` 覆盖到
  `entry/src/main/**`，同路径后写者胜），漏了它 → 真机上 `pages/Chats` 路由不存在，
  且 `tools/validate-app.mjs` 规则 3 直接红（「harmony 版 main_pages 必须是共享清单的超集」）。

## 2. 代码落点

| 文件 | 职责 |
| --- | --- |
| `model/chatList.ts` | 纯逻辑（零 SDK import）：`parseChatIndex` / `sortChats` / `filterChats` / `toMessages` / `chatSummaryLine` / `formatChatTime` |
| `services/chatStore.ets` | 只读 IO：`listChats()` / `loadChat(id)`，读 `<filesDir>/git-repo/chats/**`，**一个字节都不写** |
| `pages/Chats.ets` | 列表页：搜索、更新时间倒序、下拉刷新（先 Git 拉取再重读本地） |
| `pages/ChatDetail.ets` | 只读详情：顶部固定只读提示、消息流、**无输入框** |
| `tools/test/chatList.test.mjs` | 纯逻辑单测（52 个用例 / 109 条断言） |

数据来源（与 `docs/CHAT-SYNC.md` §2 一致）：

```
<filesDir>/git-repo/chats/index.jsonl          ← 列表页只读这个（只追加，同 id 取最后一行）
<filesDir>/git-repo/chats/<id>/meta.json       ← 标题 / updatedAt / messageCount
<filesDir>/git-repo/chats/<id>/session.jsonl   ← 明文事件流（行序即事件序，绝不折叠）
```

`git-repo` 就是 `GitSyncService.getRepoRoot()` 的那个工作副本。`chatStore` **不调用**
`getRepoRoot()`（它会 `mkdirp`，属写副作用），只用同一路径约定拼字符串 + 读文件。

## 3. 三态：空态 / 错误态 / 无匹配（文案逐字）

判据来自 `chatStore.listChats()`：**`ok:true` + 空数组 = 空态；`ok:false` = 错误态**。

### 3.1 空态（`chats/index.jsonl` 不存在，`ok:true`）

第一次进来的用户几乎必然是这个状态，所以必须**带操作指引**，不能只写「暂无数据」：

```
还没有云端会话。
在电脑的 DSH 上运行一次会话后，点插件「云端对话 → 导出全部」即可同步到这里。
导出并推送后，回到本页下拉刷新（或等 App 启动时自动拉取）就能看到列表。
```

### 3.2 错误态（读文件失败，`ok:false`）

`ErrorText`（`danger` 令牌）+「重试」按钮，另给一句可执行的排查方向：

```
读取会话索引失败          ← chatStore 的 reason（detail 里也带「：<底层错误>」）
会话列表读不出来时，先确认本机已经拉取过同步仓库（设置 → 同步 → 立即拉取）。
[重试]
```

- 只有「文件存在但读不出来」（权限/IO 错误）才是错误态；**文件不存在永远不是错误**。
- 详情页的错误原因统一为「会话文件不完整」（缺 `meta.json` / 缺 `session.jsonl` / 坏 JSON），
  并给「重试」+「返回列表」两个出口。

### 3.3 无匹配（有会话，但搜索词没命中）

```
没有匹配的会话
换个关键词，或清空搜索框看全部会话。
[清空搜索]
```

与空态分开写：否则用户会以为会话被删了。

### 3.4 其它弱状态

| 状态 | 文案 |
| --- | --- |
| 列表首次读取中 | 标题栏副标题「正在读取…」+ 一行灰字「正在读取云端会话…」 |
| 详情首次读取中 | 一行灰字「正在读取会话…」 |
| 详情没有可读消息 | 「这个会话没有可读的消息内容」+「工具输出、用量统计等事件不在只读视图里展示；换个会话看看。」 |
| 详情 id 参数丢失 | 「会话 ID 缺失：请从云端对话列表重新进入」 |

## 4. 列表页（`pages/Chats.ets`）

- 骨架 `PageLayout(title:'云端对话', subtitle:…)`：返回按钮可用；副标题是「只读 · 共 N 个会话」
  （有搜索词时补「筛选出 K 个」）。
- 搜索框：`filterChats`（**标题子串、大小写不敏感**；空/纯空白查询 = 全部），右侧「清空」。
- 列表行 = 标题（最多 2 行 + 省略号）+ 右侧「只读」徽章 + 摘要行
  `chatSummaryLine(entry)` → `2026-11-18 14:03 · 42 条消息`；行高 ≥ `TOUCH_MIN`，整行可点。
- 排序：`sortChats(entries, 'updated')`（新的在前；时间相同保持输入顺序；时间解析不到的排最后）。
- 下拉刷新（`Refresh` + `$$this.refreshing`）：**先** `syncController.pullNow()`（桥就绪时），
  **再** 重读本地文件。桥没就绪（没配仓库 / 同步内核没加载）时不报错、不 toast，
  只读本地已有内容——列表页不能因为「同步没配好」整页不可用。
- 数据全在 `@State`，`aboutToAppear` + `onPageShow` 各读一次（旋转不丢内容；从别处同步回来会变新）。

## 5. 详情页（`pages/ChatDetail.ets`）

- `PageLayout(title: 会话标题, subtitle: '只读 · <updatedAt>')`（`meta.title` 缺失回落「云端会话」，
  `updatedAt` 走 `formatChatTime`）。
- **顶部固定一条只读提示**（在滚动区之外，滚到哪都看得见）：
  「这是从 Git 同步来的只读会话，不能在这里继续对话」。
- **底部没有输入框 / 发送按钮**：P1 是只读视图（`docs/CHAT-SYNC.md` §1/§5：同一会话同一时刻
  只能有一个写者，平板在这里续写会产生两条分叉的事件流）。
- 排版：**统一左对齐 + 角色小字**（`我` / `助手` / `系统` / `其他`），不用「user 右 / assistant 左」
  的双侧气泡——气泡要给两侧各留边距与最大宽度，窄屏（竖屏平板 673vp、手机 360–430vp）会白丢
  20–30% 行宽，而会话正文常有代码块与长段落。
- 工具调用：一行灰字（`text_secondary`）+ 等宽字体摘要 `🔧 <name>`，**不渲染参数与结果**
  （参数里常含绝对路径/命令输出；脱敏是上传侧责任，见 `docs/CHAT-SYNC.md` §7）。
  工程里没有自带等宽字体文件，`fontFamily('monospace')` 走系统通用族名：认得就等宽，
  不认得回落默认字体（不崩，仍靠灰字 + 辅助字号与正文区分）。

## 6. 消息提取口径（`toMessages`）

`session.jsonl` 是 DSH session v4 的明文事件流（字段事实见 workspace 根
`docs/RESEARCH-session-import.md` §3.2），App 只挑「能读的东西」：

| 事件 `type` | 处理 |
| --- | --- |
| `user/message` | `data.content` → 角色 `user` |
| `assistant/message` | `data.message.content`（没有就回落 `data.content`）→ 角色 `assistant` |
| `tool/call` | 压成一行 `🔧 <name>`（缺 name → `🔧 未知工具`）→ 角色 `tool`，带 `toolName` |
| `system/message` | 角色 `system` |
| 其它 `*/message`（如 `developer/message`） | 角色 `other`（不丢内容，也不假装是助手） |
| `tool/result`、`usage`、`header(type:"session")`、`turn/*`、`step/*`、坏 JSON | **跳过**，计入 `skipped` |

**内容两种形态都支持**（同一份事件流里会混着出现）：

1. `content` 是 **string**（旧版本 / 单段文本）；
2. `content` 是**数组** `[{type:'text', text:'…'}, {type:'image', …}]`——只拼 `type==='text'` 的段
   （多段用 `\n` 连接），图片等非文本段跳过。

容错约定：**所有函数都不抛**。坏行只 `errors++` / `skipped++`；空行不算坏行；
`messageCount` 非法回落 `0`；时间解析不到时摘要写「时间未知」，不会出现 `NaN` / `undefined`。

## 7. 验证

```bash
cd apps/arkui-schedule
node ../../node_modules/typescript/bin/tsc -p tools/tsconfig.json   # 纯逻辑层编译（exit 0）
node --test tools/test/chatList.test.mjs                            # 52 用例 / 109 断言
node tools/validate-app.mjs                                         # 8/8（含 7 个页面）
```

真机验收（P1，见 `docs/CHAT-SYNC.md` §8）：平板设置页出现「云端对话」→ 列表出现该会话 →
详情能读全量（无需 zstd 解帧）→ 底部无输入框、顶部有只读提示。

## 8. 已知边界（P1 刻意不做）

1. **不扫描 `chats/*/meta.json` 兜底**：`docs/CHAT-SYNC.md` §2.4 允许「索引缺失时扫描 meta.json」，
   P1 只读 `index.jsonl`，缺失即空态（少一条慢路径 = 少一处不一致）。要做时在 `chatStore.listChats()`
   里加分支即可，纯逻辑无需改。
2. **不校验 `sha256` / 不校验租约**：P1 只展示；租约与 sha 只在「续接」时才有意义（§3）。
3. **时间展示分两种输入**（`formatChatTime`）：
   - 带时区标记（`Z` / `±HH:MM`）→ 真实时刻，**换算到本机时区**。插件侧
     `exportChats.ts` 用 `new Date().toISOString()` 写 `updatedAt`，所以线上数据基本都是这种；
     不换算会让东八区用户看到早 8 小时的时间；
   - 不带时区标记 → 视为「记录者墙钟」，原样展示（与 `common/date.ts` 的 `formatClock` 对
     日程 `ts` 的口径一致）。
4. **`messageCount` 直接展示插件的口径**：`exportChats.ts` 写的是 `user + assistant` 消息条数
   （不是全部事件行数），所以摘要行说「N 条消息」而不是「N 个事件」。
5. **不做「接管/继续对话」入口**：属 P2（导入回 DSH）之后的事；现在给入口等于给一个必然失败的按钮。
