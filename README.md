# dsh-session-archiver

> 在 DeepSeek Harness Web 中**真正把会话移出 `~/.dsh/sessions`** —— 归档、恢复、移动、删除，全程可逆、可校验、不丢数据。

## 为什么需要它

dsh 的会话文件（`session.v3.jsonl.zstd`）在打开/保存时，由**主线程**完成 zstd 压缩/解压 + `JSON.parse`/`stringify`。会话越大，阻塞越久：

| 会话大小 | 实测影响 |
|---------|---------|
| 1~2 MB | 无明显感知 |
| 7 MB | 偶发几百毫秒卡顿 |
| **25 MB** | **单次读写可阻塞主线程数十秒** → `/health` 连续超时 → watchdog 判定死亡并重启 web → 表现为「用着用着就断连」|

而且 dsh 会**扫描 `~/.dsh/sessions` 下的全部会话并持有其 lock**，所以只要文件还在目录里，它就一直在被扫描/加载。

**结论：唯一能让 dsh 不再扫、不再读某个会话的办法，就是把它的目录移出 `~/.dsh/sessions`。** 这正是本插件做的事。

## 与同类会话管理插件的对比

| 能力 | 其他会话管理插件的常见做法 | **dsh-session-archiver（本插件）** |
|------|------------------------------------------|-----------------------------------|
| 归档语义 | **软归档**：只在 `storages/workspace.json` 的 `archivedSessionIds` 里记一个 id，**磁盘文件原地不动** | **真归档**：`fs.rename` 原子移动整个会话目录到 `~/dsh-session-archive` |
| 能否减少 dsh 扫描/读写 | ❌ 完全不能（dsh 照扫照读，lock 照持有）| ✅ 移出后 dsh 完全看不到，lock 释放 |
| 能否缓解大会话卡顿 | ❌ 无效果（只影响 UI 分组）| ✅ 直接减少主线程读写总量 |
| 删除是否可逆 | 一般是不可逆删除 | ✅ 默认进 `.trash` 回收站，可恢复 |
| 完整性校验 | 无 | ✅ 归档时记录每个文件的 sha256；恢复前校验，不符立即中止 |
| 活跃保护 | 无（可能移走正在写入的会话）| ✅ **双重判据**：10 分钟内被写入 / 被 dsh 加载在内存中（持有 session.lock）都默认拒绝 |
| 误操作防护 | 依赖确认弹窗 | ✅ 活跃检测 + 同名冲突检测 + 哈希校验 + 台账审计 |
| 会话可读性 | 多数只显示 id / 时间 | ✅ 显示**标题**（读 dsh 投影缓存）、轮次、大小、工作区、相对时间、活跃状态 |
| 跨工作区移动 | ✅ 支持 | ✅ 支持（并拒绝移动活跃会话）|
| 面板可拖动 | ✗ | ✅ 按住标题栏拖动 |
| 子会话识别 | 一般无 | ✅ 自动识别 dsh subagent 子会话、加标签并显示其名字 |
| 超阈值自动维护 | 无 | ✅ 会话库超限时自动归档闲置会话、清理回收站（可选清理超龄归档）|

> 说明：上表对比的是**归档语义与安全机制**上的常见差异，不针对任何具体实现——各插件侧重不同。本插件专注「安全地把会话移出/移回 + 不丢数据」。

## 功能

- 侧栏底部 **「会话仓库」** 按钮 → 打开面板（可拖动）
- **当前会话**列表：标题 / 大小 / 工作区 / 轮次 / 最近活动 / 是否活跃
- 每行操作：**归档**、**移动**（下拉选目标工作区，含 `[新建]` 候选）、**回收站**
- **已归档**列表：标题 + 归档时间 + **恢复** / 删除；自动归档的带绿色 `自动` 徽标，归档时就没有标题的空会话带灰色 `无标题` 徽标
- **子会话标签**：dsh 的 subagent 子会话（目录名无 `session-` 前缀 / 投影里 `subagent.identity` 有值）自动加紫色 `子会话` 徽标并显示其名字
- **内存中徽标**（0.2.0 新增）：仍被 dsh 加载着的会话加橙色 `内存中` 徽标，并统计在顶部「内存中 N 个」—— 这些在重启 dsh web 之前无法真正归档干净
- **自动维护**：会话库超过阈值时自动归档最旧的闲置会话；到点清理回收站；可选清理超龄归档
- 顶部实时统计：当前会话数/体积、**其中子会话数**、已归档数/体积、活跃阈值

## 安全保证（设计即防丢数据）

1. **归档 = 同卷原子移动**（`fs.rename`）—— 绝不复制后再删，不存在中间态；归档区与 `sessions` 同卷
2. **活跃检测**：会话文件 10 分钟内被写过 → 默认拒绝（界面勾选「强制」可绕过）
2b. **「被持有」检测**（0.2.0 新增）：文件不新 ≠ 没人用。dsh 会把**已加载的会话常驻进程内存**并一直持有它的 `session.lock`，这类会话按 mtime 看是「闲置」的，归档后却仍会显示在会话列表里。插件现在同时问两处：① 进程内的 `sessions` 服务里还有没有这个会话（权威、跨平台、零成本）；② 操作系统层面有没有进程打开着 `session.lock`（Linux 读 `/proc/self/fd`，macOS/BSD 走 `lsof`，可覆盖其它 dsh 实例）。任一命中即拒绝，除非勾选「强制」。探测不可用时如实返回 `liveProbe: "unsupported"`，绝不假装「没被持有」
3. **sha256 台账**：`~/dsh-session-archive/manifest.json` 记录每个归档会话的文件清单与哈希
4. **恢复前强制校验**：任一文件缺失或哈希不符 → 立即中止，绝不半途覆盖
5. **删除默认进回收站**：`~/dsh-session-archive/.trash`；永久删除走独立接口
6. **操作留痕**：`operations.log` 追加记录每一次归档/恢复/删除（自动操作记为 `archive:auto` 等）
7. **自动维护的边界**：候选**只会是「未被 dsh 加载、且闲置超过设定天数」的会话**；自动维护**不会走「强制」绕过任何闸门**；自动归档同样走 sha256 台账并在 manifest 里标记 `auto`；**归档区默认永不自动删除**（`archiveRetentionDays: 0`），必须显式设为正数才会清理

## 归档为什么有时「看起来没生效」

dsh 的会话列表是 **磁盘持久化项 ∪ 内存中已加载项**，而 dsh 会把用过的会话**常驻内存**、并一直持有该会话目录里的 `session.lock`。
于是会出现这样一幕：会话日志已经几十分钟没写（mtime 判据认为「闲置」），但 dsh 进程其实还加载着它 —— 此刻把目录移走，**文件确实走了，界面上却照旧显示它**，用户看到的就是「归档没生效」。

更麻烦的是第二个后果：该会话之后若还有事件写入，dsh 会按 `header.cwd + id` 重新计算日志路径（那条路径已经不存在），可能在 `sessions` 目录里重建一个空壳，与归档副本分叉，日后 `/restore` 会卡在 sha256 校验。

所以 0.2.0 起：

- 归档前会问「这个会话还被 dsh 持有吗」（进程内 `sessions` 服务 + 操作系统层面的 `session.lock` 探测），命中即拒绝，并给出明确出路；
- 面板上这类会话带橙色 `内存中` 徽标，顶部统计显示 `内存中 N 个`；
- 归档成功后会把 sessionId 写进 `~/.dsh/storages/workspace.json` 的 `global.archivedSessionIds`（这正是 dsh **自己**的归档语义：列进去的会话从所有分组视图隐藏），恢复 / 从归档区删除时撤销这笔登记。

**要真正让归档生效，唯一办法是重启 dsh web 释放这些会话**（`dsh-daemon restart`）。重启后：内存中被加载的会话没了，`archivedSessionIds` 也会被读进内存——两条路都指向「侧栏不再显示它」。

想知道现在有哪些会话被持有，可以看面板顶部的「内存中 N 个」，或跑一次体检：

```bash
cd ~/.dsh/profiles/web/node_modules/dsh-session-archiver
node test/live-archive.test.mjs      # 隔离沙箱回归（不碰真实数据）
```

## 归档区标题（title）从哪来

归档区列表的标题是**归档那一刻的快照**，按下面三级来源取（先到先用），并把结果与来源写进 manifest：

| 优先级 | 来源 | 说明 |
|--------|------|------|
| 1 | 投影缓存 `~/.dsh/storages/session_projcache/sessions/<sessionId>.json` | dsh 视角下的最终标题（含用户手改、模型生成），读取最便宜 |
| 2 | 会话日志里的 `session/title` 事件 | 与日志同生共死（日志就在归档目录里）。同一会话会写多条：`fallback`（截取首条用户消息）→ `provider`（模型生成）→ `user`（用户手改），**只有最后一条是最终标题** |
| 3 | 确实没有标题 | 例如「打开就关」、从未产生对话的空会话 → 界面显示 id + 灰色 `无标题` 徽标 |

manifest 每条记录带 `titleSource`（`projection` / `log` / `none`）。**没有 `titleSource` 的历史条目会在打开面板时自动回填**：每轮最多 5 条（扫日志是同步 IO），其余排到后台续跑，不阻塞列表接口；写完即生效，不再重扫。

所以归档区显示成 `session-xxxx…` 一般只是历史数据少了字段 —— 刷新面板就会补齐。若重启 dsh web 后依旧如此，说明该会话归档时确实没有标题。

扫描成本：会话日志可达数百 MB，兜底只按**文件头部 32 MB（压缩）** 读取，逐帧解压并在累计解压 192 MB 或 2 万帧时停止，绝不全量读入内存。实测最坏一条（25 MB 日志、16154 帧）耗时约 0.4 秒，且只发生一次。

手工触发回填 / 排查（host 侧同一份代码）：

```bash
cd ~/.dsh/profiles/web/node_modules/dsh-session-archiver
node --input-type=module -e 'import("./lib/index.js").then(m=>m.fillArchivedMeta()).then(r=>console.log(r))'
```

## 自动维护（可选，默认关闭）

在面板底部「自动维护设置」里配置（持久化到 `~/dsh-session-archive/config.json`）：

| 配置项 | 默认 | 说明 |
|--------|------|------|
| `enabled` | `false` | 总开关，默认关闭 |
| `libraryLimitMB` | 500 | 会话库超过该体积 → 自动归档最旧的非活跃会话，直到降至阈值的 90% |
| `maxIdleDays` | 7 | **保护线**：只有闲置超过该天数的会话才会被自动归档 |
| `trashRetentionDays` | 7 | 回收站超过该天数自动清理 |
| `archiveRetentionDays` | **0** | 归档保留天数；**0 = 永不自动删除归档** |
| `checkIntervalMinutes` | 60 | 检查间隔（最小 5 分钟）|

面板上另有 **「立即执行一次」** 按钮可手工触发并查看结果；也可直接调 API。


## 安装与运行（macOS / Linux / Windows）

### 1. dsh 本体（三平台一致）

需要 Node.js 22+：

```bash
npm i -g @deepseek-ai/dsh
dsh --version
```

### 2. 装这个插件（三平台一致）

```bash
dsh plugin --profile web add github:zzdhsxk/dsh-session-archiver
```

该命令在 profile 目录里执行 `pnpm add`，并自动把声明了 `dsh.bundle` 的依赖同步进 `dsh.profile.bundles`。

### 3. 启动与守护（三平台同一组命令）

```bash
dsh-daemon install      # 注册开机自启 + 每 30s 探活自愈（macOS→LaunchAgent，Linux→systemd user，Windows→VBS + 任务计划）
dsh-daemon status       # 守护与 web 健康状态
dsh-daemon restart      # 重启 web 让新插件生效（会中断当前会话，先确认没在跑任务）
dsh-daemon stop         # 暂停守护并停掉 web
dsh-daemon uninstall    # 卸载守护
```

> 插件的界面代码在 dsh web 启动时载入内存，所以**装完/改完必须重启 web** 才会生效；只刷新页面不够。

### 4. 不装守护、临时前台跑（三平台一致）

```bash
dsh web --port 3080 --no-open
```

⚠️ **不要写 `--host 0.0.0.0`** —— dsh 出于安全考虑会**主动拒绝**（它会把远程代码执行能力暴露到网络上），并提示改用 `127.0.0.1`。需要跨机访问请用 SSH 隧道或反向代理，并把来源加进 `--trusted-host`。

### 平台差异一览

| 平台 | 命令 | dsh 数据目录 | 守护落地 |
|------|------|--------------|----------|
| macOS | 全部同上 | `~/.dsh` | `~/Library/LaunchAgents/com.deepseek-ai.dsh-watchdog.plist` |
| Linux | 全部同上 | `~/.dsh` | systemd user 服务（无 systemd 时退化为 cron） |
| Windows | 全部同上（PowerShell / cmd 均可） | `%USERPROFILE%\.dsh` | 任务计划程序（VBS 启动脚本） |




### 5. Docker 运行（可选，自建镜像）

官方没有现成镜像，用 Node 官方镜像自建即可。

⚠️ **容器里同样不能用 `--host 0.0.0.0`** —— dsh 会直接拒绝并退出（它会把远程代码执行能力暴露到网络上）。正确做法是：**让 dsh 只监听 `127.0.0.1`，再用 socat 把端口转到容器外**，最后由 `-p` 映射给宿主。

`Dockerfile`：

```dockerfile
FROM node:22-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends socat \
 && rm -rf /var/lib/apt/lists/* \
 && npm i -g @deepseek-ai/dsh
EXPOSE 3080
# 转发 0.0.0.0:3080 -> 127.0.0.1:13080（dsh 只肯监听回环地址）
CMD ["bash","-lc","socat TCP-LISTEN:3080,fork,reuseaddr TCP:127.0.0.1:13080 & exec dsh web --port 13080 --no-open"]
```

构建并运行（三个平台一致）：

```bash
docker build -t dsh-web .
docker run -d --name dsh-web -p 3080:3080 -v "$HOME/.dsh:/root/.dsh" dsh-web
```

Windows 的差别只在**挂载路径写法**：

```powershell
# PowerShell
docker run -d --name dsh-web -p 3080:3080 -v "$env:USERPROFILE\.dsh:/root/.dsh" dsh-web
```

```bat
REM cmd.exe
docker run -d --name dsh-web -p 3080:3080 -v "%USERPROFILE%\.dsh:/root/.dsh" dsh-web
```

首次访问需要带认证的 URL（token 由 dsh 启动时打印）：

```bash
docker logs dsh-web 2>&1 | grep -o "http://[^ ]*token[^ ]*"
```

> Linux 上还可以直接用 `--network host`，省掉 socat（容器与宿主共用网络栈）；
> Docker Desktop for macOS / Windows 需要先在设置里启用 host networking 才支持 `--network host`。
> 想改端口就同时改 `-p`、`--port` 与 socat 里的两个端口号。

## 手动安装（本地开发，改代码即时生效）

```bash
git clone https://github.com/zzdhsxk/dsh-session-archiver.git ~/dsh_workspace/plugins/dsh-session-archiver
```

然后在 `~/.dsh/profiles/web/package.json` 里：

- `dependencies` 加 `"dsh-session-archiver": "link:/绝对路径/dsh-session-archiver"`
- `dsh.profile.bundles` 数组里加 `"dsh-session-archiver"`

```bash
cd ~/.dsh/profiles/web && pnpm install
dsh-daemon restart
```

> 若包来自 git 且带 `prepare` 脚本，pnpm 会拦截构建并打印一个 key，按提示把它加到 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds` 下再重跑即可。本插件是纯 JS、无构建步骤，通常不会遇到。

## HTTP API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | `/session-archiver/api/list` | 会话 + 归档 + 工作区 + 统计 |
| GET  | `/session-archiver/api/workspaces` | 可用工作区列表 |
| GET  | `/session-archiver/api/config` | 读取自动维护配置 |
| POST | `/session-archiver/api/config` | `{auto:{...}}` 保存自动维护配置 |
| POST | `/session-archiver/api/maintain` | 立即执行一次自动维护 |
| POST | `/session-archiver/api/archive` | `{sessionId, force?}` 归档 |
| POST | `/session-archiver/api/restore` | `{sessionId}` 恢复（sha256 校验后）|
| POST | `/session-archiver/api/move` | `{sessionId, targetWorkspace}` 移动 |
| POST | `/session-archiver/api/trash` | `{sessionId}` 移入回收站 |
| POST | `/session-archiver/api/purge` | `{sessionId}` 永久删除 |

返回与错误约定（0.2.0）：

- `GET /list` 的每个会话带 `live`（是否仍被 dsh 持有）；`stats` 带 `liveCount` 与 `liveProbe`（`ok` / `unsupported`）。
- `POST /archive` 被闸门拦下时返回 `{ok:false, error}`，文案说明**原因 + 出路**（哪个 PID 持有、要不要重启 dsh web、以及「强制」的代价）。
- 成功时返回 `liveAtArchive` / `liveSource` / `liveProbe` / `registryUpdated` / `registryNote` / `hint`，其中 `hint` 提示需要重启 dsh web 界面才生效。
- `/restore` 与「已归档」页签的 `/trash` 会撤销 `archivedSessionIds` 登记，保持与 dsh 的归档语义对称。

## 目录结构

```
lib/index.js         host 侧：文件操作 + HTTP 路由（原子移动 / 校验 / 台账）
lib/client.js        client 侧：侧栏按钮 + 面板 UI（无需构建，DSH 直接加载）
lib/session-header.js 多帧 zstd 的帧扫描与 header.cwd 改写（「移动」必需）
lib/title-fill.js    归档标题兜底：从会话日志的 session/title 事件取最终标题
lib/live-lock.js     「会话是否仍被 dsh 持有」检测：进程内 sessions 服务 + 操作系统锁探测
test/                隔离沙箱回归测试（node test/live-archive.test.mjs）
cordis.patch.yml     bundle 声明
docs/                dsh web 反复重启的排查实录
```

## 回归测试

零依赖、全部在 `mkdtemp` 沙箱里跑（`DSH_HOME` 与归档区都指向临时目录），**绝不触碰真实 `~/.dsh`**：

```bash
cd ~/.dsh/profiles/web/node_modules/dsh-session-archiver
node test/live-archive.test.mjs
```

覆盖 42 条断言，分 12 组：未被持有 / 被持有的 `live` 判定、被持有时的归档拒绝且不动文件、强制归档并登记归档集合、闲置会话正常归档、恢复时撤销登记、删除与移动的拒绝、旧 `archived_at` 字段兼容、自动维护只挑「未被持有」的会话、归档区删除时撤销登记、跨工作区移动（目录 + header.cwd + 注册表登记三处同步）、以及最终无残留坏数据。

## 相关文档

- [dsh web 为什么反复重启：一份排查实录](docs/dsh-web-restart-diagnosis.md) —— 从「每 6 分钟断连一次」到定位根因的完整过程，含可复用的排查手法（进程栈采样 + 日志交叉验证）。

## 许可

MIT

## 重要：会话 header 与「移动」的约束

dsh 的会话日志（`session.v3.jsonl.zstd`）是**多帧 zstd**，**第一帧里存着 header**，
其中 `header.cwd` 决定这个会话属于哪个工作区。

dsh 启动时会用 `header.cwd` 重新计算期望路径，与文件实际位置比对，不一致就**直接抛错拒绝启动**：

```
Error: dsh: plugin tree failed to load: ... corrupt session log
  "~/.dsh/sessions/--A--/session-x/session.v3.jsonl.zstd":
  header id "session-x" and cwd identify "~/.dsh/sessions/--B--/session-x/session.v3.jsonl.zstd"
```

**也就是说：只 `mv` 目录会让整个 dsh web 起不来。**

因此本插件：

- `/move`（跨工作区移动）会**同步改写 header.cwd**，改写前备份到 `<归档区>/.header-backups/`；
  改写后移动失败会自动回滚 header。
- `/restore` 恢复前也会校验并对齐 header.cwd（防止归档期间工作区改名导致的错位）。
- 只 `session.*.jsonl.zstd` 文件名被识别；第一帧若不止 header 一行、或文件有残帧，**一律拒绝改写**（绝不冒险）。

### 启动已经失败时怎么救

用配套的独立工具（不需要 dsh 启动）：

```bash
node ~/dsh_workspace/dsh-session-move.mjs check                    # 扫描所有会话，列出位置/header 不一致的
node ~/dsh_workspace/dsh-session-move.mjs adopt <会话目录> --apply  # 按 header.cwd 把它放回正确工作区
node ~/dsh_workspace/dsh-session-move.mjs import <会话目录> <目标工作区cwd> --apply   # 导入到目标工作区并改 header
node ~/dsh_workspace/dsh-session-move.mjs move <sessionId> <目标工作区cwd> --apply   # 已在 sessions 里时迁移
```

> 凡涉及改 cwd 的操作都会在改动前留备份；不加 `--apply` 时只预演、不动文件。

### 跨工作区移动要同时改「三处」

| 层面 | 存放位置 | 不改的后果 |
|---|---|---|
| ① 会话文件位置 | `~/.dsh/sessions/<工作区目录>/<会话>` | dsh 找不到这个会话 |
| ② **header.cwd** | 会话日志（多帧 zstd）的**第一帧** | **dsh web 完全起不来**（corrupt session log） |
| ③ **分组登记** | `~/.dsh/storages/workspace.json` 的 `tables.workspaces[].sessionIds` | 会话掉进「**未分组**」 |

只改 ① 会触发 ② 的校验失败（服务起不来）；只改 ①② 会触发 ③ 的登记冲突（显示未分组）。

插件现在三处都改：移动前改写 ②（失败自动回滚），移动后同步 ③（best-effort，失败不阻断并返回原因）。

> **③ 的改动要重启 dsh web 才会反映到界面** —— 分组注册表的权威副本在 web 进程内存里，
> 磁盘修补只是保证「重启后读到的是对的」。响应里会带 `hint` 提醒。

配套独立工具（dsh 起不来时用，不需要它启动）：

```bash
node ~/dsh_workspace/dsh-session-move.mjs check                       # 会话文件层面体检
node ~/dsh_workspace/dsh-session-move.mjs import <会话目录> <目标cwd> --apply
node ~/dsh_workspace/dsh-workspace-regroup.mjs list                  # 工作区分组一览
node ~/dsh_workspace/dsh-workspace-regroup.mjs move <sessionId> <目标工作区路径> --apply
```

### 归档区的「删除」行为

「已归档」页签的删除按钮走同一个 `/trash` 接口，但归档会话已不在 sessions 目录，
所以后端会改为**从归档区删除**：

1. 目录先移进 `<归档区>/.trash/<工作区>/<会话>-<时间戳>`（同盘 rename，瞬时 —— 不直接 rm，留退路）
2. 清掉 manifest 里的登记

之后由 `trashRetentionDays`（默认 7 天）自动清理。

> 注意：`/restore` 依赖 manifest 登记，登记清掉后**界面不能再把它恢复回来**；
> 但文件仍在 `.trash` 里，需要的话可以手动 mv 回归档目录。
> 想走「可恢复」的删除，请先在「已归档」页签点「恢复」，再用「回收站」。

会话 ID 匹配做了归一化：归档记录里同时存在 `session-xxx` 与 `xxx` 两种写法，两者都能命中。

