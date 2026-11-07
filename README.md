# dsh-notify

为 DeepSeek Harness（DSH）的 Web 界面提供**静音**的桌面通知和页内卡片：

- 任务跑完时告诉你；
- 主 Agent 等待审批、提问、计划审批、或报错时告诉你；
- 子代理触发同样的事件也通知，标题前加 `↳ ` 区分层级，但**不静音**；
- 页面在前台时改用右下角页内卡片，避免和系统通知重复；
- 页面回到前台后不补发卡片。

通知本身永远带 `silent: true`，不播放声音。Windows 通知中心显示的应用名仍会是
Edge / Chrome，这是浏览器自身身份，不由本插件控制。

## 兼容性

- 本次实测：DSH `0.2.2-rc.1`，Web profile。2026-11-07 在 Linux 上用一次性 profile
  真实启动，`dsh-notify` 的 host bundle `fiberPhase` 为 `active`。客户端代码本次未改，
  浏览器侧仍沿用历史验证过的 Windows Edge / Chrome 环境结论（通知本身依赖浏览器
  Notification 权限，无法在无界面环境里完整复现）。
- `package.json` 的 `engines.dsh` 是 `>=0.2.1-rc.2 <0.3.0`，`peerDependencies` 也是
  同一区间，没有把 peer 锁死在某一个 rc 上。
- 插件只使用 Web 浏览器能力（Notification、DOM、localStorage），不依赖 React、
  不依赖任何第三方包，也不需要构建。

## 安装

在装有 DSH 的机器上执行：

```sh
dsh plugin --profile web add link:/home/buguoshixc/code/dsh/dsh-notify
# 重启 dsh web（bundle 成员只在启动时读取）
```

重启后刷新 `http://127.0.0.1:3080`。安装由用户执行；本插件没有修改 `node_modules`、
`$DSH` 安装目录或 profile 配置。

安装后 profile 的 `package.json` 应出现 `dsh-notify`，且 `dsh.profile.bundles` 数组里
也应有它。可以用下面的命令确认组合结果：

```sh
dsh --profile web --dump-config
```

### 首次使用与通知权限

浏览器不会允许页面在加载时直接弹权限提示。本插件在页面的**第一次**
`pointerdown` 或 `keydown` 时调用一次 `Notification.requestPermission()`，并在
`localStorage['dsh-notify.permission-requested']` 记录 `1`，之后不再请求。

- 点击页面任意位置或按一次键，浏览器会询问是否允许通知；选“允许”。
- 如果误点了“阻止”，打开浏览器的站点设置（地址栏左侧的网站信息 → 通知 → 允许），
  刷新页面后生效。
- 权限是 `default` 时，系统通知出口直接跳过，不会抛错；页内卡片仍然工作。
- 权限是 `denied` 时，控制台会输出一条 `console.warn`，明确提示去站点设置修改。
- 如果想让浏览器重新询问，可清掉 localStorage 的键后刷新：

```js
localStorage.removeItem('dsh-notify.permission-requested')
```

## 行为规格（决策表）

“前台”严格等于：

```js
document.visibilityState === 'visible' && document.hasFocus()
```

但这个布尔值只在加载时读一次 `hasFocus()`；之后由 `focus` / `blur` /
`visibilitychange` 三个事件维护，不轮询。这样 Windows 最小化后 `hasFocus()`
仍返回 `true` 也不会误判。

| 事件 | 页面在后台 | 页面在前台 |
|---|---|---|
| 完成（`running` 由 true 变 false 后 10 秒稳定窗口） | 系统通知（`silent`）：标题为会话标题，正文 `✅ 任务完成` | 仅当 `completionUnread === true` 时显示页内卡片；正在看的会话不弹 |
| `approval` | 系统通知（`silent`）正文 `⏳ 等待审批 · 工具名` | 页内卡片，正文相同 |
| `question` | 系统通知（`silent`）正文 `❓ 在等你回答` | 页内卡片，正文相同 |
| `plan-review` | 系统通知（`silent`）正文 `📋 计划待你批准` | 页内卡片，正文相同 |
| `api-session/error` | 系统通知（`silent`）正文 `✕ 出错 · message` | 页内卡片，正文相同 |
| 子代理的以上任何一种 | 系统通知（`silent`），标题前加 `↳ ` | 页内卡片，标题前加 `↳ ` |

- 所有系统通知都写死 `silent: true`，代码里没有关闭静音的分支。
- 子代理**不静音**；`↳ ` 只用于区分层级。
- 未知 `pendingInteraction.kind` 的正文兜底为 `需要你`。
- 会话标题读取 `ctx.sessions.list.getSnapshot().byId[id]?.title`；缺失或为空时退回
  `会话`。
- 子代理识别只使用 `ctx.sessions.subagentAddress(id) !== undefined`，只用于加
  `↳ `，不用于静音。

### 系统通知不可用时的降级

如果系统通知出口不可用（`Notification` 不存在、权限不是 `granted`、构造抛错），
后台事件会退化为**当时创建**的页内卡片。这是“权限被拒也要有可见降级”的兜底：

- 卡片不依赖 Notification 权限；
- 不会等回到前台后再补建（没有队列，也不违反“回到前台不补发”）；
- 卡片仍受 8 秒 TTL 和最多 3 张的限制；如果页面一直最小化，卡片到期后自然消失。

权限被拒绝时，控制台仍会提示去站点设置修改。

## 判定细节

1. **完成 = 10 秒稳定窗口**
   - `running` 从 `true` 变为 `false` 时启动 `setTimeout(..., SETTLE_MS)`；
   - 窗口内该会话又变回 `running === true`（goal 下一轮、排队消息）→ 取消；
   - 窗口内出现 `pendingInteraction` → 取消“完成”，改由等待逻辑立即通知；
   - 窗口结束时重新读取最新快照，只有仍为 `running === false` 且没有等待中的交互才出口；
   - 出口时再按决策表决定系统通知还是页内卡片。
2. **同会话同类闸门**：`sessionId + kind` 在 `SAME_KIND_GATE_MS`（10 秒）内最多触发一次。
   只有真的显示了系统通知或卡片才登记时间，避免“没显示也算用掉一次”。
3. **首帧快照只做基线**：第一次 `getSnapshot()` 不产生任何通知；如果首帧已有等待中的
   审批，也只把它的 `key` 记为已见。
4. **`connection/reset`**：清空基线、清空尚未触发的完成定时器、清空闸门和已见
   pending key，然后用当前快照重新做基线，避免重连一次弹出一堆旧事件。
5. **pendingInteraction 按 key 去重**：同一个 key 只发一次；首帧里已有的 key 也记账。
6. **未知 kind**：正文 `需要你`。
7. **页内卡片**：懒创建 `#dsh-notify-stack`，最多 `MAX_CARDS` 张，FIFO 挤掉最早的；
   `CARD_TTL_MS` 后淡出移除；点击卡片或系统通知都会先 `window.focus()`，再调用
   `ctx.get('uiWorkspace')?.openSession(sessionId)`；`uiWorkspace` 不存在时只聚焦窗口。

## 可调常量

所有可调参数集中在本文件 `client.js` 顶部：

| 常量 | 默认值 | 含义 |
|---|---:|---|
| `SETTLE_MS` | `10_000` | 完成事件的稳定窗口；窗口内重新运行则取消 |
| `SAME_KIND_GATE_MS` | `10_000` | 同会话同类通知的最小间隔 |
| `MAX_NOTIFICATIONS` | `5` | 一次后台连续运行中允许的单条系统通知上限 |
| `CARD_TTL_MS` | `8_000` | 页内卡片显示时长（之后 200ms 淡出） |
| `MAX_CARDS` | `3` | 页内卡片同时存在的最大数量 |

### 后台通知上限的细节

`MAX_NOTIFICATIONS = 5` 是“一次后台连续运行”的上限，不是全局永久计数：

- 回到前台时计数重置，下一次最小化从头算；
- 第 1–5 条是各自独立的系统通知；
- 第 6 条出现时，插件会关闭本插件当前打开的单条通知（通常就是本轮已显示的），
  只保留一条汇总通知 `还有 N 项更新`，其中 `N` 是本轮后台系统通知总数（包含刚触发的
  那一条；被 10 秒闸门挡掉的不算）；
- 后续每多一条，汇总通知用同一个 tag 替换，N 继续增加；
- 点击汇总通知只聚焦窗口，不带会话跳转（汇总没有单一会话）。

这样做的理由：字面要求是“超过时只保留一条汇总通知”，所以不能把 5 条单条通知
和 1 条汇总同时留在通知中心；`N` 用总数而不是溢出数，是为了让汇总本身表达
“这一轮一共有多少项更新”。

## 数据源与安全边界

- **会话状态的唯一事件源**是 `uiSession.sessionStatus` 的 `getSnapshot()` / `subscribe()`。
  错误流是唯一的另一条只读订阅（见下一条）。
- **绝不订阅** `approval/request` 或 `user-questions/request`。它们在客户端是 waterfall；
  任何监听器只要返回结果，就等于替用户做了决定，审批面板会永远不出现。
- 错误流只读 `ctx.remote.$on('api-session/error', ...)`，不向 host 返回任何值。
- 客户端 bundle 顶层 `inject = ['sessions', 'uiSession']`；`uiWorkspace` 和
  `remote` 都通过 `ctx.get()` 可选获取。
- `uiSession` 是内部服务名；如果未来 rc 改名，插件会静默不工作，不会抛错拖垮页面。
- 所有卡片文字都通过 `textContent` 赋值，没有 HTML 字符串注入面。

## 未验证项

以下行为在当前 headless Ubuntu 环境无法实际验证，已用防御式写法实现；请在 Windows
浏览器里按“验收清单”确认：

1. Windows 最小化后 `document.hasFocus()` / `visibilityState` 的具体行为。代码依赖
   `focus` / `blur` / `visibilitychange` 事件，不依赖轮询；但仍然需要 Windows 实测
   事件顺序。
2. Windows 通知中心是否正确显示 `silent: true`（不响铃）。代码中所有 `Notification`
   构造都写死了 `silent: true`，没有其他出口。
3. 点击通知后 `window.focus()` 是否把 Edge / Chrome 现有窗口拉到前台；不同浏览器
   对“从通知点击聚焦已有窗口”的策略可能不同。
4. `uiWorkspace.openSession(sessionId)` 在 rc 版本中的实际行为（当前版本存在该服务）；
   服务缺失时只聚焦窗口，不会报错。
5. `completionUnread` 是否精确对应“不是正在看的会话”。当前版本中它对
   `retainedBy.mainView > 0` 的会话不置位，和规格一致；未来 rc 若改语义，卡片
   可能多弹或漏弹。系统通知出口不受这个字段影响。
6. Windows 专注助手（Focus Assist）吞掉通知。这不是代码能检测的，见排错。
7. 汇总通知在 Windows 通知中心里的替换/关闭行为。代码先 `close()` 单条再建汇总，
   同一个 tag 也用于后续替换；浏览器可能对程序化关闭有延迟。
8. 客户端 bundle 缓存与 HMR：见排错中的刷新/重启步骤。
9. 权限提示在 `127.0.0.1` 上是否被浏览器策略允许。`127.0.0.1` 通常视为安全上下文。
10. 首帧加载时页面恰好处于后台，初始 `hasFocus()` 读数是否可靠；事件开始后会被纠正。
11. `uiSession` 是 DSH 的内部服务名。目标 rc.5 提供该服务；若后续 rc 改名，插件需要同步修改
    `inject` 与 `ctx.get()` 的名称。否则该 client entry 可能停在 pending，不会产生通知。

## 排错

### 完全没有通知

1. **确认页面在后台**。系统通知只在页面后台（`visible && hasFocus` 为 false）时发；
   前台走页内卡片。
2. **确认通知权限**。在地址栏站点设置里看通知是否为“允许”。如果权限是 `default`，
   先点一下页面或按一次键触发请求。
3. **确认 localStorage 标记**。如果曾经点过“阻止”，浏览器不会再次自动请求；到站点
   设置改权限，或清掉 `dsh-notify.permission-requested` 后刷新重试。
4. **检查 Windows 专注助手 / 通知设置**。Focus Assist 会静默吞掉浏览器通知，系统
   “通知和操作”里也要允许 Edge / Chrome。
5. **确认插件已加载**：
   - profile 的 `package.json` 有 `dsh-notify`；
   - `dsh.profile.bundles` 有 `dsh-notify`；
   - 重启过 `dsh web`（bundle 成员只在启动时读取）；
   - 刷新页面。
6. 打开浏览器控制台，看是否有 `[dsh-notify]` 权限警告或加载错误。

### 有页内卡片但没有系统通知

- 这是预期行为：页面在前台时不会发系统通知，避免重复。
- 如果页面在后台仍然没有系统通知，优先检查权限和 Focus Assist。
- 卡片在 8 秒后淡出；系统通知在通知中心里保留时间由 Windows 决定。

### 修改后没有生效

客户端 bundle 可能被缓存：

1. 先刷新页面（普通刷新；必要时 Ctrl+F5）；
2. 如果仍无效，重启 `dsh web`；
3. 确认 `client.js` 的 `id` 仍是 `dsh-notify`，并且与 `package.json` 的 `name`
   逐字节一致。

### 应用名显示 Edge / Chrome

预期行为。系统通知由 Windows 浏览器渲染，应用身份是浏览器，本插件不修改这一点。

### 子代理和主 Agent 同时结束会连弹几条

这是有意的：主 Agent 和子代理都通知。插件用 `MAX_NOTIFICATIONS` 汇总兜底；同一
会话的同类通知还有 10 秒闸门。汇总出现时，通知中心里只会保留一条“还有 N 项更新”。

### 点击通知没有切到对应会话

- 代码执行顺序是 `window.focus()` → `ctx.get('uiWorkspace')?.openSession(sessionId)`；
- 如果当前 rc 的 `uiWorkspace` 服务缺失或改名，只会聚焦窗口；
- 如果会话在通知发出后被删除，`openSession` 可能无效；
- 浏览器可能因策略拒绝程序化聚焦，需要用户手动切回窗口。

## 验收清单

安装、重启、刷新页面后，按顺序手工过一遍：

1. **后台完成**：最小化窗口 → 发一个长任务 → 任务完成 10 秒后，Windows 通知中心
   出现一张卡片，标题是会话标题，正文含 `✅ 任务完成`，**没有声音**。
2. **点击跳转**：点这张通知 → 浏览器到前台，并切到该会话。
3. **等待类事件立即通知**：在后台触发工具审批 / 提问 / 计划审批 → 立即出现对应
   通知（不受 10 秒完成窗口影响），正文分别是 `⏳ 等待审批 · 工具名`、
   `❓ 在等你回答`、`📋 计划待你批准`。
4. **前台不打扰**：页面可见且有焦点、正看着该会话 → 完成时不弹任何东西；看别的
   会话时它完成了 → 右下角出现页内卡片。
5. **子代理**：子代理完成或提问 → 同样有通知 / 卡片，标题带 `↳ ` 前缀。
6. **goal 多轮**：连续 3 轮 goal → 中间轮次重新变 running 时取消完成计时，只在最终
   停下时出现一条通知。
7. **断网重连**：断开再恢复网络连接后，不会一次弹出一堆旧通知；重连后的第一帧只做
   基线。

## 文件结构

```text
package.json        # type: module；host/client exports；dsh.bundle.patch；dsh.client
cordis.patch.yml    # 插入 host 侧的空插件行（id: notify, name: dsh-notify）
index.js            # 空的 host apply，只为让 bundle 行合法
client.js           # 全部逻辑：前台跟踪、稳定窗口、闸门、系统通知、页内卡片、权限
README.md           # 本文
```

## 静态自检

```sh
node --check client.js
node --check index.js
```

代码中没有控制台日志、待办标记、HTML 字符串赋值或第三方 `require` 调用；唯一的
`console.warn` 用于通知权限被拒绝。

## 明确不做

- 不播放任何音效（也没有非静音分支）；
- 不做 LLM recap、设置页、托盘、手机 / IM 推送、关窗后通知；
- 不碰 `document.title` / favicon（`DocumentTitle` 独占 title）；
- 不做多窗口选主、i18n（中文硬编码）、goal projection 读取、最后一条助手消息抓取；
- 不订阅审批 / 提问 waterfall，不替用户回答。
