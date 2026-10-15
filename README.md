# dsh-plugin-session-manager

仓库：<https://github.com/cmsj33071/dsh-plugin-session-manager>

DSH 会话管理插件：给会话行「…」菜单加上**导出备份**、**归档**、**彻底删除**三项能力，并在宿主侧自带一套安全门与回收站。提供三件事：

| 能力 | 性质 | 入口 |
|---|---|---|
| **导出备份** | 只读，可反复执行 | 会话行菜单 → 下载备份（ZIP）／备份到 DSH 目录 |
| **归档（软删除）** | 可逆，走官方 API | 会话行菜单 → 归档 |
| **彻底删除** | 不可逆（可回收站恢复） | 会话行菜单 → 彻底删除… → 确认框 |

> **当前状态：可用。** 曾因宿主半侧解析 DSH home 失败而长期「休眠」（装了但界面无任何入口），另有一个必崩的客户端 hook 顺序错误；两者均已修复并验证，见下一节。
>
> 本文档里的 `C:\Users\33071\...` 是作者机器路径，作为实测证据保留；自己动手时把 `$env:USERPROFILE` 那一层换成你的用户目录即可。

---

## 快速开始

```powershell
# 1. 装进 profile（pnpm/node 用 DSH 自带的那份；DSH 安装位置按自己的改）
$dsHome   = "$env:USERPROFILE\.dsh"
$resource = "C:\Users\33071\AppData\Local\Programs\DeepSeek Harness\resources"
$node = "$resource\runtime\primary-runtime\dependencies\node\bin\node.exe"
$pnpm = "$resource\runtime\pnpm\bin\pnpm.cjs"

# 从 GitHub 装（公开仓库）
& $node $pnpm --dir "$dsHome\profiles\desktop" add "github:cmsj33071/dsh-plugin-session-manager"
# 或从本地源码目录装
& $node $pnpm --dir "$dsHome\profiles\desktop" add "file:<本目录的绝对路径>"
```

```jsonc
// 2. 在 <profile>\package.json 的 dsh.profile.bundles 末尾追加；不要手写 cordis.patch.yml
"dsh-plugin-session-manager"
```

3. 重启 DSH，确认 `<DSH_HOME>\session-manager\active.json` 出现、会话行「…」里出现「会话管理」一组。

插件**零运行时依赖**（宿主半侧只 import `node:*`），客户端无构建步骤，clone 下来即可用。

---

## 本次修复（2026-10-15）

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| 1 | 插件「装了但什么都没出现」，`~/.dsh/session-manager/active.json` 始终不存在 | `resolveHome()` 只认 `ctx.get('homePaths')` 和 `$DSH_HOME`。但 **`homePaths` 不是 cordis 服务**：在 121 MiB 的 `app.asar` 全文里搜 `homePaths` 命中 **0** 次，`@deepseek-ai/dsh-home-paths` 是纯函数库（其 README 原文：*Use it as a direct library dependency, not through `cordis.yml`*）；而桌面宿主进程的 `DSH_HOME` 是空的（实测 boot 探针 `dshHomeEnv: null`）。两个候选全部落空 → home 为 `undefined` → 插件保持空闲 | 按 `dsh-home-paths` 的优先级自行解析：`config.home` → `homePaths`（若真存在）→ **非空** `$DSH_HOME` → `os.homedir()/.dsh`。只 import `node:os`，不引入任何 `@deepseek-ai/*` 依赖 |
| 2 | 「彻底删除…」确认框永不出现（点了像没反应） | 确认框组件在第二个 `useSessionManager` **之前**就 `return null`。React 按位置识别 hook：无待确认时 1 个 hook、有待确认时 2 个 → 抛 `Rendered more hooks than during the previous render` | 两个 hook 调用提到所有提前 return 之前；无待确认时 selector 返回 `undefined` |
| 3 | 预览（plan）可能写盘 | 写锁探测用 `open(id,'write')`，而 JSONL 后端在**历史代际**日志上会在 write-open 时发布迁移后的后继文件 | 代际低于当前格式（v4）时跳过写锁探测（计划项记为 `lockProbe: 'not-probed'`）；删除前仍有 `flush` + revision 比对兜底 |
| 4 | 诊断噪音 | `lib/index.js` 每次加载写 3 个 `probe-*.json` | 删掉分阶段探针，只保留 `active.json`，并让它记录 `home` / `homeSource` / `routes` / `failures` |
| 5 | 部分文件带 GBK/UTF-8 混编乱码（`鈥?`、`閳?`） | 早期写入编码错误 | 全部改回正确的 `—` |
| 6 | 清单指向不存在的 `lib/types/index.d.ts` | `types` / `exports["."].types` 声明了但文件从未创建 | 补上该声明文件 |
| 7 | 删除成功后侧边栏仍留着那一行（点开报错） | 侧边栏渲染的是客户端 Session Controller 的**缓存基线**，而基线只在拉取时从持久化后端重建；删掉磁盘上的日志不会通知它 | 确认删除成功后调用 `ctx.get('sessions').refresh()` 重新拉基线（`refresh` 不在 `sessions` 服务文档契约里，因此按调用时探测 + `typeof` 守卫处理，缺失即静默跳过），失败不改变「删除已成功」的结论 |

**为什么自检没发现第 1 条**：`check-manifest.mjs` 的桩上下文**自己伪造了 `homePaths.dshHome`**，于是「插件取不到 home」这条真实路径从未被覆盖——测试通过、插件照旧休眠。该桩已删除，并新增一组断言直接覆盖「没有任何服务、也没有 `$DSH_HOME`」时的默认 home。

---

## 为什么这个插件必须自己实现删除

DSH **在设计上刻意没有会话删除能力**，这不是遗漏：

- `dsh-session-persistence` 的已知限制原文：`No deletion or retention API — pruning stored sessions is out-of-band backend maintenance.`
- JSONL 后端原文：`Nothing deletes session files — logs accumulate under root until removed externally.`
- workspace 包把 `session deletion` 列为 absent capability。
- 客户端 `session.*` 的 19 个 Remote 方法里没有删除/归档；归档在 `workspace.*`。
- 桌面 profile 的 `cordis.patch.yml` 里也没有任何相关覆盖。

所以「删除」只能由插件在宿主侧按后端的磁盘约定自己完成。本插件把这件事做成**默认可逆**（移入回收站），并加了一组硬性安全门。

---

## 目录结构

```
dsh-plugin-session-manager/
  package.json            # 清单：main / exports["./client"] / dsh.bundle.patch / dsh.client
  cordis.patch.yml        # 把插件插入 profile 层叠的 bundle patch
  README.md
  LICENSE                 # MIT
  .gitignore
  lib/
    index.js              # 宿主入口：home 解析、配置、6 条 HTTP 路由、/sessions 命令、激活标记
    operations.js         # 核心：list / plan / remove / export / trash / prune
    session-tree.js       # 会话目录发现（只从 header 取 id，不解析目录名）
    log-reader.js         # 日志读取：持久化句柄（权威）+ Zstandard 帧直读（回退）
    ownership.js          # 插件自有会话的 sidecar 所有权索引（原子写）
    trash.js              # 回收站：移动、清单、保留期清理、恢复
    client.js             # 浏览器入口：**单个 bundle**，内含 locale + 控制器 + 行菜单 + 确认框 + 两个 slot 注册
    types/index.d.ts      # 宿主半侧类型声明（清单的 types 指向这里）
  tools/
    verify-installed-plugin.mjs  # 用真实组合 import 已安装副本并激活
    real-store-smoke.mjs         # 对运行中的真实存储跑 GUI 的调用路径（只读）
    asar-packages.txt            # 捕获的宿主包清单，供清单测试核对依赖可解析性
  tests/
    run-all.mjs           # 一键跑全部自检（可传 sessions 根启用真实数据套件）
    check-manifest.mjs    # 清单契约 + patch 文件 + 客户端模块 id + 真实 import/激活 + home 解析规则
    check-client.mjs      # 浏览器仿真：模块加载、slot 注册、控制器行为、hook 调用次数一致性
    check-lineage.mjs     # 血缘闭包、token 绑定、删除顺序、拦截规则、写锁探测矩阵
    check-log-reader.mjs  # 对真实会话日志验证读取器
    check-operations.mjs  # 在真实会话的临时副本上跑完整流程
```

> 浏览器半侧刻意只有 `lib/client.js` 一个模块：loader 只把 bundle 自身注册进模块表，`require("dsh-plugin-session-manager/…")` 这类包内相对请求必然「missed the module table」并让整个 entry 激活失败。所以控制器、组件、样式全部写在同一个 factory 闭包里。

同工作区里还有两项配套产物，**刻意没有打进这个仓库**：

- asar 提取工具（`extract-dsh-package.mjs`、`index-dsh-asar.mjs`、`asar-paths.json`）——本机用来从 `app.asar` 抽取官方包的工具与索引。
- `reference/@deepseek-ai/` —— 87 个 DSH 官方包的已提取源码，用于逐个核对真实接口（slot 契约、locale 契约、primitives 组件签名、persistence 方法语义）。**它是从 asar 反解出来的，不是原始仓库，也不随本仓库分发**；本仓库只保留结论（见下文各处引用的原文与行号）。
- 仓库里的 `tools/asar-packages.txt` 只是从上述索引里摘出的**包名清单**（9871 B），供清单测试核对「声明的依赖确实可解析」。

---

## 界面接入点

按官方插件的做法，只做**加法**，不替换任何现有 UI：

| slot | 类型 | 用途 |
|---|---|---|
| `sidebar.workspaces.session.menu.item` | `list` | 会话行「…」菜单里新增一组「会话管理」。同席已有官方 pin(100)/rename(200)/fork(300)/archive(400)，本插件取 `order: 500`。 |
| `shell.overlay` | `list` | 确认框挂载点，与官方 `workspace.session-archive` 等确认框同一层。 |

行菜单的 owner props 是 `{ sessionId, displayTitle }`，并额外注入 `useMenuOpenState()`（动作前必须先关菜单，否则会被行自身的 dismiss 吞掉）与 `useShortcuts()`。

删除成功后，操作会再调用一次 `ctx.get('sessions').refresh()`：侧边栏的行来自客户端 Session Controller 的基线快照（宿主每次都从持久化后端重读，见 `session-query` 的 `listSessions`），不重新拉取的话被删的行会继续显示。该调用是可选的（`refresh()` 不在服务文档契约里），缺失或被拒都不影响「删除已完成」的结论。

删除同时清掉两类衍生状态：`~/.dsh/storages/session_projcache/sessions/<id>.json`（projection cache，列表的冷会话摘要会读它）与插件自己的所有权索引条目。会话搜索索引（`dsh-session-query-sqlite`）不需要插件插手——它会在下一次搜索时按持久化快照对账，自行剔除已消失的源。

导出 ZIP 复用官方已交付的 `/api/session.export`（`dsh-session-log-export`），它已经能导出「会话 + 子会话 + 全部附件」。备份到 DSH 目录走本插件自己的路由，落规范 JSONL，不依赖浏览器下载目录。

---

## 宿主路由

全部注册在 `connection.fetch`（精确路由、同源鉴权 cookie，客户端无需附加凭据），前缀 `/api/session-manager`。客户端一律使用**文档相对路径**（无前导 `/`）。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` / `HEAD` | `/` | 会话清单：`items`、`warnings`、`storage`、`truncated` |
| `POST` | `/plan` | 删除预览：返回将要移除的目录集合（每项含 `bytes` / `files` / `revision` / `logGeneration` / `lockProbe`）、总字节数、血亲子集、**拦截原因**、一次性 `token` |
| `POST` | `/remove` | 执行删除：必须携带 `token`，可选 `force` |
| `POST` | `/export` | 导出到 DSH 目录（`~/.dsh/session-manager/exports/<时间戳>-<label>/`） |
| `GET` | `/trash` | 回收站条目 |
| `POST` | `/trash/prune` | 按保留期清理回收站 |

命令：`/sessions` 报告存储与回收站用量，不产生模型轮次。

---

## 安全设计

删除是本插件里唯一破坏性操作，因此它被设计成「默认拦下来，只有明确确认才动」。代码中的硬性保证：

1. **先预览，后执行，token 绑定。** `token` 是对「本次将删除的目录 id + 字节数 + 存储 revision + 子会话集合」的 SHA-256 摘要。预览之后任何会话新增、消失或被重写，token 都会失配并拒绝执行（`session/confirmation-mismatch`）。
2. **活动会话不放行。** `ctx.sessions.get(id)` 命中则计入拦截。带 `force` 时会先 `agents.get(id).cancel({kind:'user'})` 再 `await whenIdle()`（默认上限 10s，超时即拒绝）。
   > 这一条不是洁癖：删除一个仍有活写句柄的会话，会让该句柄在下一次 append 时用 `open(path,'a')` 重建一个**没有 header 帧**的残片，此后该会话永久 `SessionPersistenceCorruptionError`。
3. **跨进程写锁不放行。** 通过 `sessionPersistence.open(id,'write')` 探测 `SessionAlreadyOwnedError`（Windows 上是内核租约，零超时等待，不会卡住预览），命中即拒绝（`session/writer-held`）。**但历史代际日志不探测**：JSONL 后端在 write-open 一个非当前格式的后代时会在 open 内发布迁移文件（`publishStoredMigration`），而预览必须只读；这类会话的计划项记 `lockProbe: 'not-probed'`，删除前由 flush + revision 比对兜底。
4. **血缘闭包必须完整。** 删除会递归覆盖全部子孙（`header.parentSession` 传递闭包）。以下情形一律拦截：存在被排除在计划外的子会话（会产生孤儿）、计划内会话的父会话不可见（血缘链不可信）、后端列出但磁盘无法定位的会话落在计划内。
5. **不 unlink，先进回收站。** 目录用 `rename` 移入 `~/.dsh/session-manager/trash/<ISO时间>-<id>/`，并写 `manifest.json`。同一卷上 `rename` 是原子的，因此不会出现「删一半」的破损目录，也留下了恢复路径（`restoreTrashEntry`）。保留期默认 30 天，`trashRetentionDays: 0` 关闭清理。
6. **删除顺序：先子后父。** 即使中途失败也不会留下「记录中的子会话已消失」的父目录。
7. **同步清理衍生状态。** 删除日志后一并删 `~/.dsh/storages/session_projcache/sessions/<id>.json`。该缓存是派生数据且**没有任何驱逐机制**（本机已积累 6 个孤儿），不清就是长期脏数据。
8. **绝不碰附件。** 附件是内容寻址、去重、可跨会话共享的，按会话删会破坏**其他**会话的历史读取。

---

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `home` | 未设置 | 显式 DSH home；优先级最高，覆盖 `$DSH_HOME` 与 `~/.dsh` |
| `sessionsRoot` | `<DSH_HOME>/sessions` | 会话存储根；后端 `root` 是配置项，非默认部署需显式指定 |
| `storagesRoot` | `<DSH_HOME>/storages` | 派生状态根，用于定位 projection cache |
| `clearProjectionCache` | `true` | 删除时一并清理该会话的 projection cache 记录 |
| `trashRetentionDays` | `30` | 回收站保留天数；`0` 关闭清理 |
| `trackOwnership` | `true` | 维护插件自有的会话所有权索引 |
| `allowForceRemoveLive` | `true` | 是否允许在停稳活动会话后强制删除 |
| `stopTimeoutMs` | `10000` | 等待活动会话 `whenIdle()` 的上限 |
| `listLimit` | `500` | 单次清单返回上限 |

`SessionsRoot` 未显式提供时按 `<DSH_HOME>/sessions` 推断；home 的解析优先级是 `config.home` → `homePaths` 服务（若组合里真有）→ 非空 `$DSH_HOME` → `~/.dsh`。全部落空时插件保持空闲并打一条 warn，而不是抛错。

---

## 安装（三步）

作者这台机器已经装好了（`profiles/desktop/package.json` 的 `dependencies` 与 `dsh.profile.bundles` 都包含本包，`node_modules/dsh-plugin-session-manager` 是指向源码目录的 junction）。修复没有增删依赖，所以**不需要重跑 pnpm**，重启 DSH 即可。

从零安装（换机器 / 换 profile）：

```powershell
# 1. 把插件包放进 profile 的 node_modules（pnpm 与 node 都用 DSH 自带的那份）
$dsHome   = "$env:USERPROFILE\.dsh"
$resource = "C:\Users\33071\AppData\Local\Programs\DeepSeek Harness\resources"    # 按自己的安装位置改
$node = "$resource\runtime\primary-runtime\dependencies\node\bin\node.exe"
$pnpm = "$resource\runtime\pnpm\bin\pnpm.cjs"
& $node $pnpm --dir "$dsHome\profiles\desktop" add "file:<本目录绝对路径>"
# GitHub 上装：& $node $pnpm --dir "$dsHome\profiles\desktop" add "github:cmsj33071/dsh-plugin-session-manager"
```

```jsonc
// 2. 在 <profile>\package.json 的 dsh.profile.bundles 末尾追加
"dsh-plugin-session-manager"
```

第 3 步：重启 DSH。

安装本插件的 `insert` 行**不需要**手写：它由本包自己的 `cordis.patch.yml`（经清单里的 `dsh.bundle.patch` 引用）提供，加载器会自动插入。用户 patch 层是给你覆盖配置用的；手动再加一份会造成重复 id。

**验证方式**（不依赖 GUI，推荐先跑这个）：

```powershell
$node = "C:\Users\33071\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
& $node "<repo>\tools\verify-installed-plugin.mjs"                      # profile 目录默认 ~/.dsh/profiles/desktop
```

它会 import **profile 里那份已安装副本**（加载器实际使用的路径），用一个**不提供 `homePaths`、也不设 `DSH_HOME`** 的上下文激活宿主半侧——即桌面宿主的真实组合——检查依赖可解析性、6 条路由、`/sessions` 命令、解析出的 sessions root 是否等于真实存储，以及客户端 bundle 的注册 id。重启后也可运行 `/sessions` 看存储与回收站用量。

再进一步，`tools/real-store-smoke.mjs` 会对**运行中的真实存储**跑一遍 GUI 实际调用的路径（只读；唯一的写交互是「开一个写句柄再立刻关闭」的写锁探测，后端在这种关闭下不写任何东西）：

```powershell
& $node "<repo>\tools\real-store-smoke.mjs"
```

作者本机实测输出：7 个会话、4.8 MiB；`7129fe11…` 与 `807f8727…` 的 `parentSession` 指向 `session-1dca9004…`（真实血缘）；最新会话的计划 1 个目录 / 879 KB / 32 位 token；错误 token 被 `session/confirmation-mismatch` 拦下且回收站不变；导出 883 行、seq 连续。

> 客户端未附加构建步骤：`lib/client.js` 已是 module-loader bundle 形态（`window.__ModuleLoader__.load({id, factory})`），与隔壁已安装的 `dshmarket` 一致，可直接被 `/plugins` 路由提供。宿主半侧**零外部依赖**（只 import `node:*`）。

---

## 排查：装好了却什么都没出现

这条症状出现过两次，根因不同，都值得记住。

### 根因 A（本次）：等一个不存在的服务 → 插件「休眠」

`lib/index.js` 的 `resolveHome()` 只认 `ctx.get('homePaths')` 与 `$DSH_HOME`。但：

- **`homePaths` 不是 cordis 服务。** 在 `app.asar` 全文（121 MiB、约 260 个包）里搜 `homePaths` **命中 0 次**；官方的 `@deepseek-ai/dsh-home-paths` 只是一个纯函数库，README 原文写着 *"Use it as a direct library dependency, not through `cordis.yml`"*。
- **桌面宿主进程的 `DSH_HOME` 是空的**（boot 探针实测 `dshHomeEnv: null`）。

于是 home 解析为 `undefined`，`apply` 在注册任何东西**之前**就 `return`——不抛错、不写标记、界面上什么都没有，看起来和「插件没被加载」完全一样。

**修法**：不依赖任何服务，按 `dsh-home-paths` 的优先级自己解析（`config.home` → `homePaths`（若存在）→ 非空 `$DSH_HOME` → `os.homedir()/.dsh`）。

**教训**：宿主服务用 `ctx.get()` 取是对的，但**必须先证明它真的存在**；一个「拿不到就静默空闲」的早退分支，等于把插件变成薛定谔的。现在这条路径由 `check-manifest.mjs` 直接覆盖（桩上下文不再伪造 `homePaths`）。

### 根因 B（更早，已修复）：加载期 import 了宿主内部包

`lib/index.js` 第一行曾 `import Schema from '@deepseek-ai/schemastery'` 声明配置 schema，但**代码里从未调用它**。pnpm 只把插件**自己 `dependencies` 里声明的包**装进 profile 的 store，`@deepseek-ai/*` 是宿主内部包名，**不会**出现在那里（实测：profile 的 `node_modules\@deepseek-ai` 不存在、`.pnpm` 为空、插件自己的 `node_modules\@deepseek-ai` 是空目录）。解析链全部落空 → 宿主入口 **import 即抛 `ERR_MODULE_NOT_FOUND`** → 插件根本没进组合树。

**修法**：删掉该 import，改为导出 `CONFIG_DEFAULTS` 普通对象 + `resolveConfig()`。

**由此得到一条硬约束**，已在清单测试里强制守护（并带有真实的 import + 激活测试）：

> 插件的**加载期**路径（`lib/index.js` 及它静态 import 到的全部模块）**不得 import 任何 `@deepseek-ai/*` 或第三方包**，只能 import `node:*` 与相对路径。宿主服务一律运行时用 `ctx.get('…')` 取。

违反的代价是**静默失效**：没有任何可见报错，只有「装好了但没生效」。

### 诊断手段

`%APPDATA%\@deepseek-ai\dsh-desktop\logs` 只在**启动期未捕获异常**时才写（`crash-*.log`）；「点击无反应」这类运行时失败不会出现在那里。

| 手段 | 说明 |
|---|---|
| `~/.dsh/session-manager/active.json` | **首选。** 宿主半侧每次激活都写这个文件：`activatedAt`、`home` 与 `homeSource`（home 是按哪条规则解析出来的）、生效的 `sessionsRoot`、注册成功的 `routes` 数量、`failures` 数组，以及激活时 `sessionPersistence` / `connection` 是否可用。**文件不存在 = 宿主插件从未激活**（多半是被缺失的服务挂起，或 home 解析失败），删除自然不会有任何反应。 |
| 旧的 `probe-*.json` | `~/.dsh/session-manager/` 下可能有 `probe-module-imported.json` / `probe-apply-entered.json` / `probe-home-unresolved.json` 三个文件，是上一版的分阶段探针留下的（本次已删除写探针的代码）。它们只记录历史，可以随手删掉。 |
| `tools/verify-installed-plugin.mjs` | 直接 import 已安装副本、用真实组合（无 `homePaths`、无 `DSH_HOME`）激活——依赖不可解析、激活抛错、home 解析错误都在此暴露 |
| `tools/real-store-smoke.mjs` | 对**运行中的真实存储**跑 GUI 的调用路径（清单 / 计划 / 错误 token 拒绝 / 导出）。不删除、不追加，可随时重复跑 |
| 未鉴权 HTTP 探活 —— **不可用** | 未知路径同样返回 401（鉴权在路由之前）。我据此误判过「路由已注册」，**不要**用 401/404 判断路由存在性 |
| `dsh --profile desktop --dump-config` | 被独占保护拒绝：`profile "desktop" is managed exclusively by the Electron application` |

**源码改动何时生效**：profile 里的 `node_modules/dsh-plugin-session-manager` 是指向源码目录的 junction，**文件内容改动重启 DSH 即生效**（宿主半侧在启动时被加载一次，没有热重载）；只有**依赖清单变更**才需要重跑 pnpm 重建 manifest：

```powershell
$dsHome   = "$env:USERPROFILE\.dsh"
$resource = "C:\Users\33071\AppData\Local\Programs\DeepSeek Harness\resources"
$node = "$resource\runtime\primary-runtime\dependencies\node\bin\node.exe"
$pnpm = "$resource\runtime\pnpm\bin\pnpm.cjs"
& $node $pnpm --dir "$dsHome\profiles\desktop" add "file:<本目录绝对路径>"
```

本次修复**没有**增删依赖，因此只需重启 DSH。

---

## 自检

```powershell
$node = "C:\Users\33071\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
& $node "<repo>\tests\run-all.mjs" "$env:USERPROFILE\.dsh\sessions"
```

五个套件、共 200+ 项断言（实测 206 OK / 0 FAIL），当前全部通过（不传 `sessions` 根时，后三个依赖真实数据的套件会跳过）：

- `check-manifest.mjs` — 清单契约：`main`/`exports` 指向的文件存在、客户端 bundle 的模块 id 与入口 `require` 一致、声明的依赖确实存在于归档清单中、宿主注入的 4 个服务与注册的 6 条路由自洽；并**在没有任何 `homePaths` 服务、也没有 `$DSH_HOME` 的上下文里真实激活一次**，断言 sessions root 落在解析出的 home 下、激活标记写在正确位置且记录了 route 数量与空失败列表、以及 home 解析的完整优先级矩阵（显式配置 / `homePaths` / 非空 `$DSH_HOME` / 空白 `$DSH_HOME` / 默认 `~/.dsh`）。
- `check-client.mjs` — 用桩替换 `window.__ModuleLoader__` / `react` / primitives / `fetch`，按宿主的方式真实加载 bundle：验证 factory 注册形态、`apply`/`inject` 导出、两个 slot 注册内容，以及控制器的 plan→confirm→refuse 流程、文件下载 404 上报、归档「需先停止」判定；并用 hook 调用计数器强制**确认框在有无待确认时调用同样数量的 hook**（这正是上一版确认框打不开的原因，桩化的 hook 不会自己报错，所以必须显式计数）；同时断言**删除成功后重新拉取会话基线、删除被拒时不拉取**（否则侧边栏会留下幽灵行）。
- `check-lineage.mjs` — 合成三代血缘树：闭包传递、孤儿拦截、token 失效、**外部改动新鲜度回归**、删除顺序（子先于父）、无关会话不受影响、回收站可恢复、原始帧导出；外加**写锁探测矩阵**：持有租约 → 计划被 `writer-held` 拦截且删除被拒、空闲 → 不拦截、历史代际 → 根本不 write-open。
- `check-log-reader.mjs` — 对**真实**会话日志验证 Zstandard 多帧解析：seq 连续、header 与目录名一致、撕裂尾部计数。
- `check-operations.mjs` — 把真实 `sessions` 根复制到临时目录，在副本上跑 list / storage / export / plan / token 失配 / remove / restore 全流程，并按真实血缘分组校验计划覆盖。**不会写原始存储。**

---

## 已知限制（如实说明）

1. **`sessionsRoot` 是从 home 推断的。** home 的解析顺序见上文（`config.home` → `homePaths` → 非空 `$DSH_HOME` → `~/.dsh`）。非默认部署请显式配置 `home` 或 `sessionsRoot`。
2. **不读 `sessionPersistence.locate()`。** 该方法是后端私有实例方法（不在 README 的 5 方法契约内），换后端即失效，因此没有依赖它。
3. **目录名不可逆。** 后端的 `projectKey` 是**有损截断**编码、id 是 `~XXXX` 转义，所以会话 id 一律从 header 读取，从不从目录名反解。
4. **强制删除活动会话是「先停再删」而非「等待安全窗口」。** `workspace/session-stop` 只发停止请求、不等停稳；本插件改用 `cancel() + whenIdle()` 并设超时，超时即拒绝。仍有极小的竞态窗口（停止与删除之间若被外部唤醒），由第 1 条的 revision 校验兜底。
5. **回收站跨卷不可移动。** `rename` 在同一卷上原子；若 `DSH_HOME` 与 `sessionsRoot` 跨卷，删除会失败并如实上报，不会退化成先拷贝后删除。
6. **`/sessions` 命令与路由只读存储，不校验 `ctx.sessionQuery`。** `sessionQuery` 已注入但当前只用于可选增强；清单以「持久化快照 ∪ 目录扫描」两源合并，两源不一致会记入 `warnings` 并在删除计划中拦截。
7. **历史代际（v<4）日志不做写锁探测。** 见「安全设计」第 3 条：write-open 会触发后端自己的格式迁移，而预览必须只读。这类会话的 `lockProbe` 记为 `not-probed`，跨进程写者的检测退回 flush + revision 比对（仍然会在删除前拒绝）。`CURRENT_LOG_GENERATION = 4` 是刻意复制的常量；后端升级到 v5 后本插件会**跳过对新代际的探测**（更保守，不会写错），届时需要同步这一常量。
8. **宿主半侧已在真实组合与真实存储上验证；浏览器半侧的端到端确认仍需重启一次。** 证据：`tools/verify-installed-plugin.mjs` 用真实组合激活成功并解析到 `~/.dsh/sessions`；`check-operations.mjs` 在真实存储副本上跑通全部流程；客户端注册形态、slot 契约、locale 契约、primitives 组件签名均按官方源码逐个核对并用仿真测试覆盖。但「重启后 GUI 里真的出现菜单」这一步只能由重启来确认。
9. **`command/executed` 这类未声明事件没有使用。** 本插件不依赖它做任何事，UI 入口全部走 slot 注册。
