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

| 能力 | 常见插件（如 dsh-session-manager 的归档）| **dsh-session-archiver（本插件）** |
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

> 说明：上表对比的是**归档语义与安全机制**。同类插件在会话迁移（Agent preset 迁移等）上也有各自的价值，本插件专注「安全地把会话移出/移回 + 不丢数据」。

## 功能

- 侧栏底部 **「会话仓库」** 按钮 → 打开面板（可拖动）
- **当前会话**列表：标题 / 大小 / 工作区 / 轮次 / 最近活动 / 是否活跃
- 每行操作：**归档**、**移动**（下拉选目标工作区，含 `[新建]` 候选）、**回收站**
- **已归档**列表：归档时间 + **恢复** / 删除
- 顶部实时统计：当前会话数/体积、已归档数/体积、活跃阈值

## 安全保证（设计即防丢数据）

1. **归档 = 同卷原子移动**（`fs.rename`）—— 绝不复制后再删，不存在中间态；归档区与 `sessions` 同卷
2. **活跃检测**：会话文件 10 分钟内被写过 → 默认拒绝（界面勾选「强制」可绕过）
3. **sha256 台账**：`~/dsh-session-archive/manifest.json` 记录每个归档会话的文件清单与哈希
4. **恢复前强制校验**：任一文件缺失或哈希不符 → 立即中止，绝不半途覆盖
5. **删除默认进回收站**：`~/dsh-session-archive/.trash`；永久删除走独立接口
6. **操作留痕**：`operations.log` 追加记录每一次归档/恢复/删除

## 安装

```bash
# 1) 获取代码
git clone https://github.com/zzdhsxk/dsh-session-archiver.git ~/dsh_workspace/plugins/dsh-session-archiver

# 2) 在 dsh web profile 的 package.json 中登记（link: 便于开发时改动即时生效）
#    "dependencies": { "dsh-session-archiver": "link:/Users/you/dsh_workspace/plugins/dsh-session-archiver" }
#    并在 "dsh.profile.bundles" 数组里追加 "dsh-session-archiver"

# 3) 安装依赖
cd ~/.dsh/profiles/web && pnpm install

# 4) 重启 dsh web（由你自行决定时机）
dsh-daemon restart
```

安装后在侧栏底部即可看到「会话仓库」。

## HTTP API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | `/session-archiver/api/list` | 会话 + 归档 + 工作区 + 统计 |
| GET  | `/session-archiver/api/workspaces` | 可用工作区列表 |
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
