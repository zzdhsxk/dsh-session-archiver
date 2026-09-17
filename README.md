# dsh-session-archiver

在 [DeepSeek Harness](https://github.com/deepseek-ai) Web 中**安全地归档 / 恢复 / 移动 / 删除会话**。

与常见的"软归档"（只在 UI 上打标记、文件不动）不同，本插件**真正把会话目录移出 `~/.dsh/sessions`** —— 这是唯一能减少 dsh 扫描与读写负担的方式。dsh 打开/保存会话时会在主线程做 zstd 压缩/解压 + JSON 解析，会话越大卡得越久（25MB 的会话可卡数十秒并触发健康检查失败重启），把不用的会话移走能直接消除这类卡顿。

## 功能

- 侧栏底部 **「会话仓库」** 按钮 → 打开面板
- **当前会话**：显示标题、大小、工作区、轮次、最近活动时间、是否活跃
- 操作：**归档** / **移动**到其它工作区 / **回收站**（可恢复）/ 永久删除
- **已归档**：显示归档时间，支持 **恢复** / 删除
- 归档区与当前会话的体积统计
- 面板**可拖动**（按住标题栏）

## 安全保证

1. **归档 = 同卷原子移动**（`fs.rename`），绝不删除数据；归档区与 `sessions` 同卷
2. **活跃检测**：10 分钟内被写入的会话默认**拒绝操作**（界面可勾选"强制"绕过）
3. **sha256 台账**：归档时把每个文件的哈希写入 `~/dsh-session-archive/manifest.json`
4. **恢复前强制校验**：哈希不符立即中止，绝不半途覆盖
5. **删除默认进回收站**（`~/dsh-session-archive/.trash`），永久删除需显式调用 `/purge`
6. 所有操作追加写入 `operations.log`

## 安装

```bash
# 1) 放到任意目录，例如
git clone <this-repo> ~/dsh_workspace/plugins/dsh-session-archiver

# 2) 在 dsh web profile 的 package.json 里加依赖（link: 便于开发）
#    "dependencies": { "dsh-session-archiver": "link:/绝对路径/dsh-session-archiver" }
#    并在 "dsh.profile.bundles" 数组里追加 "dsh-session-archiver"

# 3) 安装并重启 web
cd ~/.dsh/profiles/web && pnpm install
dsh-daemon restart
```

## HTTP API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | `/session-archiver/api/list` | 会话 + 归档 + 工作区 + 统计 |
| GET  | `/session-archiver/api/workspaces` | 可用工作区列表 |
| POST | `/session-archiver/api/archive` | `{sessionId, force?}` 归档 |
| POST | `/session-archiver/api/restore` | `{sessionId}` 恢复（带 sha256 校验）|
| POST | `/session-archiver/api/move` | `{sessionId, targetWorkspace}` 移动 |
| POST | `/session-archiver/api/trash` | `{sessionId}` 移入回收站 |
| POST | `/session-archiver/api/purge` | `{sessionId}` 永久删除 |

## 目录结构

```
lib/index.js     host 侧：文件操作 + HTTP 路由（原子移动 / 校验 / 台账）
lib/client.js    client 侧：侧栏按钮 + 面板 UI（无构建步骤）
cordis.patch.yml bundle 声明
```

## 许可

MIT
