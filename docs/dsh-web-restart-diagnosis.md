# dsh web 为什么反复重启：一份排查实录

> 记录一次真实故障：2026-09-16 晚到 09-17 上午，dsh web **每 6~30 分钟断连重启一次**。
> 本文保留完整的排查手法与证据，便于复现同类问题。

## 一、症状

`~/.dsh/daemon/logs/watchdog.log` 里反复出现同一模式：

```
[watchdog] health check failed (1/3)
[watchdog] health check failed (2/3)
[watchdog] health check failed (3/3)
[watchdog] failure threshold reached, restarting web server
[watchdog] stopping previous web server (PID xxxxx)
[watchdog] launched dsh web (PID yyyyy)
```

**19.5 小时内的统计**：web 启动 57 次、强制重启 50 次、健康检查失败 250 次。用户感受就是「一直断连、不断重连」。

## 二、先理解 watchdog 的判定逻辑（关键前提）

dsh daemon 的 watchdog 行为是：

| 参数 | 值 |
|------|-----|
| 检查间隔 | 每 30 秒 `GET http://127.0.0.1:3080/health` |
| 单次超时 | 5 秒 |
| 重启阈值 | 连续失败 3 次（约 90 秒）就 kill 并重新拉起 |

**推论**：dsh web 的「反复重启」绝大多数**不是进程崩溃**，而是**进程活着、但主线程被长时间占住**，导致 `/health` 连续超时。
这条推论直接决定了排查方向：不要去翻崩溃堆栈，而要**抓「卡死瞬间」的主线程栈**。

## 三、排查手法（可复用）

1. **读守护日志定节奏**：从 `launched / stopping / health check failed` 的序列换算出重启间隔与发作时段（是每小时一次，还是连续 90 秒循环）。
2. **区分两类症状**：
   - 进程崩溃 → 在 `dsh-web.log` 找堆栈（`EADDRINUSE`、`uv_cwd ENOENT`、`fatal load failure` 等），针对性修配置；
   - 进程活着但健康检查超时 → 主线程被占用，进入第 3 步。
3. **在卡死瞬间抓进程栈**（本案例的决定性手段）：
   ```bash
   # 0.3 秒探测一次，超过 2 秒就认为卡死
   while true; do
     T=$(curl -s -o /dev/null -w '%{time_total}' --max-time 5 http://127.0.0.1:3080/health)
     if [ "$(echo "$T > 2" | bc -l)" = "1" ]; then
       WP=$(cat ~/.dsh/daemon/.dsh-web.pid)
       sample "$WP" 5 > /tmp/hang-$(date +%H%M%S).txt   # macOS 自带 sample
     fi
     sleep 0.3
   done
   ```
   坑点：macOS 没有 `timeout` 命令；`ps`/`top` 在沙箱里常被拒，而 `sample`、`lsof`、`vm_stat` 通常可用。
4. **用栈顶符号反查是哪个插件**：栈里的库特征非常明确（见下）。
5. **用插件自身日志交叉验证**：`grep` 该插件的重复错误，按失败对象分组统计。

## 四、根因一：索引插件 × 一批坏文件 = 每 15 秒一轮的解析风暴

抓到的栈（第一次卡死，PID 87944）：

```
node::AsyncWrap::MakeCallback
 └─ v8::internal::MicrotaskQueue::RunMicrotasks
     └─ node::CompressionStream<ZstdDecompressContext>::Write      ← 主线程在做 zstd 解压
     └─ v8::internal::Runtime_SetGrow
     └─ v8::internal::JSArray::ArrayJoinConcatToSequentialString   ← 大字符串拼接
```

同时 `dsh-web.log` 在疯狂刷：

```
[dsh-project-memory] re-index failed for .../发票.pdf: Invalid PDF structure.
Warning: Indexing all PDF objects
```

**统计结果**：`re-index failed` 累计 **21792 次**，每个文件失败 **48 次**，失败对象是工作区里 **454 个 6~48 字节的坏占位 PDF**。

**机制**：
- `dsh-project-memory` 插件默认 `watch: true`、`watchInterval: 15`，即**每 15 秒全量轮询工作区**；
- 轮询发现"未成功索引"的文件就重试 → 这批坏 PDF 每次都被交给 pdfjs → 每次都失败 → 15 秒后再来一遍；
- 单次解析很轻，但几百个文件 × 每 15 秒一轮，叠加 pdfjs 的初始化解压与内存分配，主线程被持续占住；
- 进程内存峰值冲到 **4.5 GB**，而 Node 默认 V8 老生代上限是 **4.09 GB** —— 顶爆上限后频繁全量 GC，停顿进一步拉长。

## 五、根因二：会话文件在主线程全量读写

即使清掉坏 PDF，仍有较慢的周期性卡顿。抓栈（第 9 次卡死）显示：

```
JsonParser      2447 次采样
Scavenge         853
MarkCompact      263
Zstd              98
CompressionStream 77
Serialize         71
JsonParse         53
```

这是 **zstd 解压 + JSON.parse 读会话**、**JSON.stringify + zstd 压缩写会话**。

相关事实：
- dsh 会话文件是**自定义多帧 zstd**（首帧仅 header、每 500 行一帧），普通 `zstd -dc` 或 `node:zlib` 解压会报 `Unknown frame descriptor`；
- 这些读写都在**主线程**完成；
- 当时会话库 **141 MB**，最大的单个会话 **25 MB** —— 单次读写即可阻塞主线程数十秒，足以打满 watchdog 的 90 秒阈值。

## 六、放大机制

- **EADDRINUSE 雪崩**：旧进程尚未完全退出时 watchdog 又拉起新进程 → 新进程 `listen EADDRINUSE` 立刻失败 → 再重启…… 日志里出现过 112 次 `plugin tree failed to load`。
- **阈值过敏感**：连续 3 次失败（90 秒）就重启，把「数十秒的卡顿」直接判成死亡。

## 七、解决方案（按性价比排序）

1. **清除坏数据源** —— 但必须**移出扫描根**：
   - 把 454 个坏 PDF 移到 `<watch根>/_quarantine/` **无效**（实测移出后 45 秒又新增 1804 次失败，因为扫描器遍历整棵树）；
   - 移到扫描根之外（如 `/tmp`）或直接删除才有效（实测 50 秒 **+0**）。
2. **归档大会话**（本插件的用途）：把不用的会话目录移出 `~/.dsh/sessions`，会话库 141 MB → 8.6 MB。
3. **调高 watchdog 重启阈值**：`~/.dsh/daemon/watchdog.js` 里 `const FAIL_THRESHOLD = 3;` 改为 `10`（连续失败 90 秒 → 5 分钟才重启），让数十秒的卡顿不再触发重启。
   ⚠️ 该文件由 dsh 生成，**`dsh-daemon reinstall` 或 dsh 升级会覆盖**，需要重做。
4. **不要在 dsh 运行时做大批量 IO**：实测一次性移动 37 MB 会话目录 + 计算 sha256 + 全盘 `find`，会与 dsh web 争抢磁盘/CPU，引发约 7 分钟的卡死风暴（操作一停立刻恢复）。要么分批做，要么先停止 web。

## 八、结果

| 指标 | 修复前 | 修复后 |
|------|--------|--------|
| 会话库体积 | 141 MB | **8.6 MB** |
| 索引失败 | 21792 次且每 15 秒增长 | **零增长** |
| 断连重启 | 每 6~30 分钟一次 | 长时间稳定（短卡顿自愈，不再重启）|
| 内存峰值 | 4.5 GB（顶爆默认堆上限）| 正常 |

## 九、可迁移的经验

1. **「服务反复被守护进程重启」时，先抓卡死瞬间的进程栈**，而不是先怀疑内存或崩溃 —— 栈顶的库符号（zstd / pdfjs / JSON）能直接指向冒烟插件。
2. **watch 类插件的「坏文件」是定时炸弹**：任何长期存在的、每次解析都失败的文件，都会变成每 `watchInterval` 秒一次的固定开销。
3. **隔离目录必须在扫描根之外**，否则「移走」在语义上等于没动。
4. **大会话是隐藏成本**：全量读写 + 主线程压缩/解析，会话体积直接决定卡顿长度。
5. **调阈值能止血但不能治病**：它让短卡顿不再被误判为死亡，根因仍要清理数据源。
6. **沙箱环境下的排查工具选择**：`sample`、`lsof`、`vm_stat`、`memory_pressure` 可用；`ps`/`top` 常被拒；采样脚本交给用户在自己的终端跑最稳。

---

*本文来自一次真实排查，相关工具：[dsh-session-archiver](../README.md)（安全归档会话，减少 dsh 主线程读写总量）。*
