# dsh-plugin-session-manager

DSH 会话管理插件：给会话行「…」菜单加三项能力。

仓库：<https://github.com/cmsj33071/dsh-plugin-session-manager>

| 能力 | 性质 | 入口 |
|---|---|---|
| **导出备份** | 只读，可反复执行 | 行菜单 → 下载备份（ZIP）／备份到 DSH 目录 |
| **归档（软删除）** | 可逆，走官方 API | 行菜单 → 归档 |
| **彻底删除** | 不可逆（先进回收站） | 行菜单 → 彻底删除… → 确认框 |

DSH **刻意不提供**会话删除能力（`dsh-session-persistence` 已知限制原文：*No deletion or retention API — pruning stored sessions is out-of-band backend maintenance.*；JSONL 后端：*Nothing deletes session files*），所以删除由本插件在宿主侧按后端的磁盘约定完成，默认**移入回收站**而不是 unlink。

---

## 安装

```powershell
$dsHome   = "$env:USERPROFILE\.dsh"
$resource = "<DSH 安装目录>\resources"
$node = "$resource\runtime\primary-runtime\dependencies\node\bin\node.exe"
$pnpm = "$resource\runtime\pnpm\bin\pnpm.cjs"

& $node $pnpm --dir "$dsHome\profiles\desktop" add "github:cmsj33071/dsh-plugin-session-manager"
```

在 `<profile>\package.json` 的 `dsh.profile.bundles` 末尾追加 `"dsh-plugin-session-manager"`，然后重启 DSH。

- `cordis.patch.yml` **不用手改**：插入行由本包自带的 patch（`dsh.bundle.patch`）提供，手写一份会造成重复 id。
- **零运行时依赖**（宿主半侧只 import `node:*`），客户端无构建步骤，clone 即可用。
- 宿主半侧只在启动时加载，改源码要重启；只有**依赖清单**变更才需要重跑 pnpm。
- 生效确认：`<DSH_HOME>\session-manager\active.json` 出现，会话行「…」里出现「会话管理」。

---

## 安全设计

删除是本插件唯一的破坏性操作，默认拦下，只有明确确认才动。

1. **先预览、后执行，token 绑定。** `token` 是「目录 id + 字节数 + 存储 revision + 子会话集合」的 SHA-256 摘要；预览之后树新增/消失/被重写都会失配并拒绝（`session/confirmation-mismatch`）。
2. **活动会话拦下。** 带 `force` 时先 `agents.get(id).cancel({kind:'user'})` 再 `await whenIdle()`（默认 10s，超时即拒绝）。理由：删除一个仍有活写句柄的日志，该句柄下次 append 会用 `open(path,'a')` 重建**没有 header 帧**的残片，此后该会话永久 `SessionPersistenceCorruptionError`。
3. **跨进程写锁拦下。** 用 `sessionPersistence.open(id,'write')` 探测（Windows 上是内核租约，零超时等待）。**历史代际（v<4）日志不探测**：后端会在 write-open 时发布迁移文件，而预览必须只读；这类会话的计划项记 `lockProbe: 'not-probed'`，删除前由 flush + revision 比对兜底。
4. **血缘闭包必须完整。** 递归覆盖全部子孙（`header.parentSession` 传递闭包）；孤儿子会话、不可信的父链、后端列出但磁盘定位不到的会话，一律拦截。
5. **不 unlink。** 目录用 `rename` 移入 `~/.dsh/session-manager/trash/<ISO时间>-<id>/` 并写 `manifest.json`：同卷原子，不会留下删一半的破损目录，且可恢复。保留期默认 30 天。
6. **先子后父**，失败也不会留下「子会话已消失」的父目录；同时清理 `storages/session_projcache/sessions/<id>.json`（无驱逐机制的派生数据）。
7. **绝不碰附件**：附件内容寻址、去重、跨会话共享，按会话删会破坏**其他**会话的历史读取。

---

## 宿主路由

注册在 `connection.fetch`（精确路由 + 同源鉴权 cookie，客户端用文档相对路径），前缀 `/api/session-manager`。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET`/`HEAD` | `/` | 会话清单：`items`、`warnings`、`storage` |
| `POST` | `/plan` | 删除预览：目录集合（含 `bytes`/`revision`/`logGeneration`/`lockProbe`）、血亲子集、拦截原因、一次性 `token` |
| `POST` | `/remove` | 执行删除：必须携带 `token`，可选 `force` |
| `POST` | `/export` | 导出到 `~/.dsh/session-manager/exports/<时间戳>-<label>/` |
| `GET` | `/trash` | 回收站条目 |
| `POST` | `/trash/prune` | 按保留期清理回收站 |

命令 `/sessions` 报告存储与回收站用量，不产生模型轮次。

---

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `home` | — | 显式 DSH home；优先于 `$DSH_HOME` 与 `~/.dsh` |
| `sessionsRoot` | `<home>/sessions` | 会话存储根 |
| `storagesRoot` | `<home>/storages` | 派生状态根（projection cache） |
| `clearProjectionCache` | `true` | 删除时一并清 projection cache |
| `trashRetentionDays` | `30` | 回收站保留天数；`0` 关闭清理 |
| `trackOwnership` | `true` | 维护插件自有的会话所有权索引 |
| `allowForceRemoveLive` | `true` | 允许停稳活动会话后强制删除 |
| `stopTimeoutMs` | `10000` | `whenIdle()` 等待上限 |
| `listLimit` | `500` | 单次清单返回上限 |

home 解析顺序：`config.home` → `homePaths` 服务（若组合里真有）→ 非空 `$DSH_HOME` → `~/.dsh`；全部落空时插件保持空闲并打一条 warn，不抛错。

---

## 自检与排查

```powershell
$node = "<DSH 安装目录>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"

& $node tests\run-all.mjs "$env:USERPROFILE\.dsh\sessions"  # 传 sessions 根即启用真实数据套件
& $node tools\verify-installed-plugin.mjs                   # import 已安装副本并激活（默认 ~/.dsh/profiles/desktop）
& $node tools\real-store-smoke.mjs                          # 对运行中的真实存储跑 GUI 的调用路径（只读）
```

五个套件 200+ 项断言全部通过；后三个套件在临时副本上跑，**不写原始存储**。排查顺序：先看 `<DSH_HOME>\session-manager\active.json`（**不存在 = 宿主半侧从未激活**），再跑上面两个脚本。未知路径也返回 401，**不要**用 401/404 判断路由是否存在。

> **加载期硬约束**：宿主入口及其静态 import **只能** import `node:*` 与相对路径。profile 只安装插件自己声明的依赖，任何 `@deepseek-ai/*` 顶层 import 都会 `ERR_MODULE_NOT_FOUND`，代价是**静默失效**（插件根本不进组合树、不报错）。宿主服务一律运行时 `ctx.get()` 取。

---

## 结构

```
lib/index.js         宿主入口：home 解析、6 条路由、/sessions、激活标记
lib/operations.js    list / plan / remove / export / trash / prune
lib/session-tree.js  会话目录发现（会话 id 只从 header 读，不从目录名反解）
lib/log-reader.js    持久化句柄（权威）+ Zstandard 帧直读（回退）
lib/trash.js         回收站；lib/ownership.js 所有权索引
lib/client.js        浏览器半侧：单个 module-loader bundle（locale + 控制器 + 行菜单 + 确认框）
tests/               5 个自检套件
tools/               两个部署验证脚本 + 宿主包名清单
```

> 浏览器半侧刻意只有一个模块：loader 只把 bundle 自身注册进模块表，包内相对 `require` 会以「missed the module table」让整个 entry 激活失败。

---

## 已知限制

1. 宿主侧接口按官方包源码逐个对齐（slot/locale/primitives/persistence 契约），客户端注册形态经仿真验证；GUI 端到端确认需要重启一次。
2. 不读 `sessionPersistence.locate()`——后端私有实例方法，不在 5 方法契约内。
3. 收件目录名不可逆：`projectKey` 是有损截断编码、id 是 `~XXXX` 转义，所以 id 一律从 header 读。
4. 回收站跨卷不可移动：`rename` 同卷原子；跨卷会失败并如实上报，不退化成先拷贝后删除。
5. 强制删除活动会话是「先停再删」而非「等待安全窗口」，仍有极小竞态窗口，由 revision 校验兜底。
6. 历史代际（v<4）日志不探测写锁（见安全设计第 3 条）。`CURRENT_LOG_GENERATION = 4` 是刻意复制的常量；后端升到 v5 后需同步，未同步只会更保守（不探测），不会写错。

---

2026-10-15 的修复（宿主半侧 home 解析失败导致插件静默休眠、确认框 hook 顺序崩溃、预览写盘风险、删除后幽灵行）见 commit `13b3bb6` 的提交说明。

MIT
