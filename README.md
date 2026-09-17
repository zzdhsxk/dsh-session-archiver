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
| 活跃保护 | 无（可能移走正在写入的会话）| ✅ 10 分钟内被写入的会话默认拒绝操作 |
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
- **已归档**列表：归档时间 + **恢复** / 删除；自动归档的带绿色 `自动` 徽标
- **子会话标签**：dsh 的 subagent 子会话（目录名无 `session-` 前缀 / 投影里 `subagent.identity` 有值）自动加紫色 `子会话` 徽标并显示其名字
- **自动维护**：会话库超过阈值时自动归档最旧的闲置会话；到点清理回收站；可选清理超龄归档
- 顶部实时统计：当前会话数/体积、**其中子会话数**、已归档数/体积、活跃阈值

## 安全保证（设计即防丢数据）

1. **归档 = 同卷原子移动**（`fs.rename`）—— 绝不复制后再删，不存在中间态；归档区与 `sessions` 同卷
2. **活跃检测**：会话文件 10 分钟内被写过 → 默认拒绝（界面勾选「强制」可绕过）
3. **sha256 台账**：`~/dsh-session-archive/manifest.json` 记录每个归档会话的文件清单与哈希
4. **恢复前强制校验**：任一文件缺失或哈希不符 → 立即中止，绝不半途覆盖
5. **删除默认进回收站**：`~/dsh-session-archive/.trash`；永久删除走独立接口
6. **操作留痕**：`operations.log` 追加记录每一次归档/恢复/删除（自动操作记为 `archive:auto` 等）
7. **自动维护的边界**：候选**只会是「非活跃且闲置超过设定天数」的会话**；自动归档同样走 sha256 台账并在 manifest 里标记 `auto`；**归档区默认永不自动删除**（`archiveRetentionDays: 0`），必须显式设为正数才会清理

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

## 目录结构

```
lib/index.js     host 侧：文件操作 + HTTP 路由（原子移动 / 校验 / 台账）
lib/client.js    client 侧：侧栏按钮 + 面板 UI（无需构建，DSH 直接加载）
cordis.patch.yml bundle 声明
docs/            dsh web 反复重启的排查实录
```

## 相关文档

- [dsh web 为什么反复重启：一份排查实录](docs/dsh-web-restart-diagnosis.md) —— 从「每 6 分钟断连一次」到定位根因的完整过程，含可复用的排查手法（进程栈采样 + 日志交叉验证）。

## 许可

MIT
