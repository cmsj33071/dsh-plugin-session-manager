# dsh-plugin-session-manager

DSH 会话管理插件：给会话行「…」菜单加三项能力。
<https://github.com/cmsj33071/dsh-plugin-session-manager>

| 能力 | 性质 |
|---|---|
| 导出备份（ZIP／到 DSH 目录） | 只读，可反复执行 |
| 归档 | 可逆，走官方 API |
| 彻底删除 | 不可逆，先进回收站 |

DSH **刻意没有**删除 API（`dsh-session-persistence`：*No deletion or retention API*），所以删除由本插件在宿主侧按后端磁盘约定完成，默认**移进回收站**而不是 unlink。

## 安装

```powershell
$dsHome = "$env:USERPROFILE\.dsh"; $res = "<DSH 安装目录>\resources"
$node = "$res\runtime\primary-runtime\dependencies\node\bin\node.exe"
$pnpm = "$res\runtime\pnpm\bin\pnpm.cjs"

& $node $pnpm --dir "$dsHome\profiles\desktop" add "github:cmsj33071/dsh-plugin-session-manager"
```

再把 `"dsh-plugin-session-manager"` 追加到 `<profile>\package.json` 的 `dsh.profile.bundles`，重启 DSH。
`cordis.patch.yml` 不用改（插入行由本包自带的 patch 提供）。零运行时依赖、客户端无构建步骤。

生效确认：`<DSH_HOME>\session-manager\active.json` 出现，行菜单里出现「会话管理」。

## 安全设计

- **先预览后执行**：`token` 绑定「目录 id + 字节数 + revision + 子会话集合」，树一变即失配拒绝（`session/confirmation-mismatch`）。
- **活动会话 / 跨进程写锁拦下**：带 `force` 时先 `cancel()` 再 `whenIdle()`（默认 10s，超时即拒）；历史代际（v<4）日志不做 write-open 探测，因为后端会在 open 时发布迁移文件，而预览必须只读。
- **血缘闭包必须完整**：孤儿子会话、父链不可信、后端列出但磁盘定位不到的会话，一律拦截。
- **不 unlink**：`rename` 进 `~/.dsh/session-manager/trash/`，默认保留 30 天；先子后父；一并清 projection cache；**绝不碰附件**（跨会话共享）。

## 配置与接口

路由前缀 `/api/session-manager`：清单、`plan`（预览）、`remove`、`export`、`trash`、`trash/prune`；另有 `/sessions` 命令报告用量。

配置项（括号内为默认值）：`sessionsRoot`（`<home>/sessions`）、`home`、`storagesRoot`、`clearProjectionCache`(true)、`trashRetentionDays`(30)、`trackOwnership`(true)、`allowForceRemoveLive`(true)、`stopTimeoutMs`(10000)、`listLimit`(500)。

home 解析顺序：`config.home` → `homePaths`（若有）→ 非空 `$DSH_HOME` → `~/.dsh`。

## 自检与排查

```powershell
$node = "<DSH 安装目录>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"

& $node tests\run-all.mjs "$env:USERPROFILE\.dsh\sessions"   # 五个套件、200+ 断言；传 sessions 根启用真实数据套件
& $node tools\verify-installed-plugin.mjs                    # import 已安装副本并激活
& $node tools\real-store-smoke.mjs                           # 对运行中的真实存储跑 GUI 调用路径（只读）
```

什么都没出现时，先看 `<DSH_HOME>\session-manager\active.json`：**不存在 = 宿主半侧从未激活**。未知路径也返回 401，不要用 401/404 判断路由是否存在。

> **加载期硬约束**：宿主入口及其静态 import 只能 import `node:*` 与相对路径。任何 `@deepseek-ai/*` 顶层 import 都会 `ERR_MODULE_NOT_FOUND`，代价是**静默失效**。宿主服务一律运行时 `ctx.get()` 取。

## 限制

不读 `sessionPersistence.locate()`（后端私有方法）；会话 id 只从 header 读（目录名有损、不可逆）；回收站跨卷会失败并如实上报；历史代际日志不探测写锁（常量 `CURRENT_LOG_GENERATION = 4` 需随后端版本同步）；GUI 端到端确认需要重启一次。

MIT
