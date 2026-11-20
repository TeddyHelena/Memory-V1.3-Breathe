# `scripts/` 索引（⛔ 别再把它当"孤儿脚本"）

> **为什么有这份**：2026-10-15 台账 §七 7.4 问"32 个孤儿脚本怎么处置"—— 查下去发现**口径错了**：
> 所谓"孤儿"只是**不在 `package.json` 的 `scripts` 里**，而它们**38 个里有 37 个被文档/其他脚本点名**。
> 不进 npm script 的**唯一原因**是**需要参数**（`--root <副本>`），不适合做成无参命令。

> **⭐ 纪律**：新增脚本时**必须**在本文件登记一行（用途 + 入口）。
> **判"孤儿"的口径**：**四处引用全为 0** 才算 —— ⛔ **不是"不在 package.json"**。

| 脚本 | 入口 | 用途 | npm | 文档 | 其他脚本 | 尺子 |
|---|---|---|---|---|---|---|
| `acceptance-audit.mjs` | **按名直调** | acceptance-audit.mjs —— Audit 版**发布前验收**：纪律件四条一次跑完出读数表 | · | 2 | · | 1 |
| `acceptance-sealed.mjs` | **按名直调** | acceptance-sealed.mjs —— S1（MemoryV1.2-Sealed）部署前验收 | · | 2 | 3 | 1 |
| `aliveness-check.mjs` | `npm run aliveness` | ⭐ 活性哨兵（L2 · 迁移第九件 · 2026-10-15 事故逼出来的） | 1 | · | · | · |
| `assert-backfill-audit.mjs` | **按名直调** | assert-backfill-audit.mjs —— 「断言回填」门（V1.3-A · G4） | · | 1 | · | 1 |
| `audit-growth.mjs` | `npm run audit-growth` | 【增长普查】把"这些只追加文件会不会长成债"变成**可重跑的数**。 | 1 | · | · | · |
| `audit-ui-parity.mjs` | **按名直调** | UI 对账：**原型（真源）↔ 我们实现** 的逐项数值比对。 | · | 1 | · | 1 |
| `audit-ui-truth.mjs` | **按名直调** | **UI 真值对账**：界面上显示的每个数，必须能在真容器数据里找到出处。 | · | 1 | · | · |
| `audit-wiring.mjs` | **按名直调** | 「机制 ↔ 界面」挂载对账（Teddy：怀疑有些机制没挂到页面上）。 | · | 1 | · | · |
| `b-red-probe.mjs` | **按名直调** | b-red-probe.mjs —— V1.3-B 先红证据（只读，跑副本） | · | 1 | · | 1 |
| `backfill-decay-fields.mjs` | **按名直调** | backfill-decay-fields.mjs —— 存量条目衰减字段回填（V1.3-A · G2） | · | 1 | · | 1 |
| `backfill-index.mjs` | **按名直调** | backfill-index.mjs —— 把条目 frontmatter 里的元数据回填进 index.json | · | 3 | 1 | 1 |
| `bench-search-cache.mjs` | **按名直调** | bench-search-cache.mjs —— 检索语料缓存的换挡对照台（2026-10-08） | · | 1 | · | 1 |
| `calibrate-route.mjs` | **按名直调** | calibrate-route.mjs —— 路由参数离线标定台（V1.2 正事 ②） | · | 1 | 2 | 1 |
| `check-client-wiring.mjs` | `npm run shoot`, `npm run check-client-wiring` | **客户端接线门禁**：用**真 HTTP + 真注入面**验每一个方法。 | 2 | 3 | · | · |
| `check-doc-refs.mjs` | `npm run check-doc-refs` | **文档自指检查**：⛔ 不许有落空的指向。 | 1 | · | · | · |
| `check-wizard.mjs` | `npm run shoot`, `npm run check-wizard` | 走完向导 **全部步骤**，逐条查"选项文案"——把原型踩过的那个坑变成门禁。 | 2 | · | · | · |
| `compact-index.mjs` | **按名直调** | compact-index.mjs —— 把增量索引日志折平回快照（Ledger · L-5 的回滚前置） | · | 2 | · | 1 |
| `crash-recovery.mjs` | **按名直调** | crash-recovery.mjs —— 崩溃恢复台子（Ledger · L-1） | · | 1 | 1 | 1 |
| `dead-exports.mjs` | `npm run scan:dead` | dead-exports.mjs —— 零调用点扫描（V1.2 工程纪律第二条的机械执行） | 1 | · | 1 | · |
| `decay-e2e.mjs` | `npm run e2e:decay` | **衰减端到端演练**（在**副本容器**上跑真代码 —— ⛔ 绝不碰生产）。 | 1 | · | · | · |
| `decay-health.mjs` | **按名直调** | 衰减机制体检（**只读**，不写容器）。 | · | 2 | · | 1 |
| `decay-monitor-report.mjs` | **按名直调** | 衰减扫描监测报告（V1.3 监测补丁 · 2026-10-12） | · | 1 | · | · |
| `decay-status.mjs` | `npm run decay-status` | **衰减机制体检**：一条命令回答"它还在转吗"。 | 1 | · | · | · |
| `drift-audit.mjs` | **按名直调** | drift-audit.mjs —— 全量对账（2026-10-07 建，借硅基拍档 10.6 的三条元规则） | · | 1 | · | 1 |
| `drift-ladder.mjs` | **按名直调** | drift-ladder.mjs —— 规模阶梯：**两千档不是极限**，往上找拐点/硬限 | · | 2 | 2 | 1 |
| `e3-calibrate.mjs` | **按名直调** | E3 标定台（网格版）—— 回答**两个可分别回答的问题**，并**如实标出哪个答不了**。 | · | 1 | 2 | 1 |
| `eval-ab.mjs` | **按名直调** | 评测台（C-1.1）—— 量的是「召回**好不好**」，不是「内部一致不一致」。 | · | 1 | · | 1 |
| `exp-write-attribution.mjs` | **按名直调** | exp-write-attribution.mjs —— 写入成本归因实验（S2 · 判定实验） | · | 1 | · | 1 |
| `gen-agent-css.mjs` | **按名直调** | 从原型**机械生成**样式表（⛔ 不是手抄）。 | · | 1 | 1 | 1 |
| `gen-onboarding-options.mjs` | **按名直调** | 从原型**机械生成**「认识一下」向导的选项数据（⛔ 不手抄）。 | · | 1 | · | · |
| `index-format-bench.mjs` | **按名直调** | index-format-bench.mjs —— 索引落盘格式的**判定实验**（Ledger · L-5） | · | 1 | · | 1 |
| `injection-bytes.mjs` | `npm run injection-bytes` | ⭐ **每轮注入字符/token 的测量器**（2026-10-15 建） | 1 | · | 1 | · |
| `lite-baseline.mjs` | `npm run lite-baseline` | **MemoryV1.3-Lite · 规模基线快照**（可复跑） | 1 | 6 | 1 | 3 |
| `lock-race.mjs` | **按名直调** | lock-race.mjs —— 跨进程写锁的**竞争台子**（Ledger · L-7） | · | 1 | 1 | 1 |
| `longrun-drift.mjs` | **按名直调** | longrun-drift.mjs —— 长任务漂移专项压测（2026-10-07 建） | · | 3 | 4 | 1 |
| `multi-writer-bench.mjs` | **按名直调** | multi-writer-bench.mjs —— 多进程并发写入的**业务级判据**（Ledger · L-2/L-7） | · | 1 | · | 1 |
| `post-deploy-check.mjs` | **按名直调** | 部署后验收 —— 重启之后跑这一支，一条命令出结论。 | · | 1 | · | 1 |
| `refresh-index-summary.mjs` | **按名直调** | refresh-index-summary.mjs —— 把条目文件 frontmatter 的 summary 回填进 i | · | 1 | · | 1 |
| `release-check.mjs` | **按名直调** | release-check.mjs —— 发布前的**版本口径一致性闸门**（S2 起） | · | 3 | 1 | 1 |
| `repair-index-projection.mjs` | **按名直调** | repair-index-projection.mjs —— 把索引投影按唯一真源回正（2026-10-07 建 · 202 | · | 1 | 1 | 1 |
| `repair-tombstone-titles.mjs` | **按名直调** | repair-tombstone-titles.mjs —— 存量墓碑脱敏（一次性修复，2026-10-07 Teddy 授 | · | 2 | · | 1 |
| `repair-v12-fields.mjs` | **按名直调** | repair-v12-fields.mjs —— 把索引里的 V1.2 五字段回填进条目文件（一次性修复） | · | 1 | · | 1 |
| `scan-title-leaks.mjs` | **按名直调** | scan-title-leaks.mjs —— 存量标题泄漏扫描（**只读，不改任何数据**） | · | 2 | · | 1 |
| `search-latency-probe.mjs` | **按名直调** | search-latency-probe.mjs —— 检索延迟台子：稳定态 vs 写后首检 | · | 2 | 2 | 2 |
| `shoot-prototype.mjs` | `npm run shoot` | 原型截图台 —— Teddy 2026-10-10 教的办法： | 1 | · | 1 | · |
| `shoot-sandbox.mjs` | `npm run shoot` | /** 拍**我们自己的面板**（沙箱页）——与 shoot-prototype.mjs 同款"验明正身"。 */ | 1 | · | 1 | · |
| `shoot-wake-variants.mjs` | **按名直调** | 【审美术对照表】把「唤醒」特效层的**审美参数**摆出来给人挑。 | · | 1 | · | 1 |
| `shoot-wake.mjs` | `npm run shoot`, `npm run shoot-wake` | 拍「唤醒」转场的**特效层**，并把 spec §五 第 1 点变成**像素判据**。 | 2 | · | · | · |
| `txn-window-probe.mjs` | **按名直调** | txn-window-probe.mjs —— 量「崩溃窗口有多宽」（Ledger · L-1 配套） | · | 1 | · | 1 |
| `v13-backup.mjs` | **按名直调** | **MemoryV1.3 备份器**（Lite 动刀前的安全网） | · | 8 | 1 | · |
| `v13-restore.mjs` | **按名直调** | **MemoryV1.3 恢复器**（配套 `v13-backup.mjs`） | · | 2 | 4 | · |

---

*自动生成 · 51 个脚本 · **真孤儿（四处引用全 0）= 0**：（无）*
