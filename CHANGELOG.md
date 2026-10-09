# Changelog

## 0.5.26 — 2026-10-09

- Keep historical sequence recovery aligned with the full SuperLcm adapter, including unsupported migrations that wrap a sequence gap.
- Read accepted live events before an unflushed persistence log, and treat only missing delegation-depth metadata as the default value.

## 0.5.25 — 2026-10-09

- Recover retained historical logs with overlapping or interleaved event numbers as physical-order evidence archives. Preserve every decoded event, its original sequence, the physical row, and the full immutable compressed source.
- Recall and search expose explicit archive positions and original sequence numbers; conflicting records remain separately readable. Recovered logs are excluded from summary and compaction reconstruction.
- Recovery commits source evidence and all records together, verifies any existing prefix, and rejects changed sources, malformed rows and stale fallback when a current-format artifact exists.

## 0.5.24 — 2026-10-09

- 宿主无法恢复的极旧日志可作为历史原文归档：使用官方旧格式解码器严格读取所有压缩帧，不修写原始日志，不伪造结束事件。
- 保存完整物理字节和校验值，保留原始事件编号与内容。旧格式归档只供精确召回，不重建活动上下文或压缩节点，也不自动调用摘要模型。
- 当前格式文件存在、来源冲突、帧损坏或事件缺口时拒绝读取过期或不完整记录。

## 0.5.23 — 2026-10-09

- 修复旧会话的格式版本和缺失预设信息补齐后，归档误判来源改变并停在旧游标的问题。继续保护原文校验、真实来源和预设冲突。
- 后台归档与摘要分别显示安全的失败原因。对应任务恢复后清除提醒，用户更新设置导致的主动取消不再误报失败。
- 增加真实历史会话回放、来源冲突、错误信息脱敏和重试恢复测试。

## 0.5.22 — 2026-10-08

- 增加 DSH 专用的后台摘要与原文召回、可选压缩接管动画，提供中英文及浅色深色版本。

- 重写 DSH 专用的中英文介绍页，沿用 SuperLcm 标识，并在介绍与插件设置页提供完整主项目入口。

- 修复自定义数据库文件名被压缩组件忽略的问题，原文、摘要、压缩节点与运行状态统一使用用户选择的文件。
- 恢复旧版分库中的准备摘要与节点，保留原文件；冲突或来源损坏不会覆盖现有数据。
- 增加真实宿主的安装和更新测试，覆盖中文、空格与特殊字符目录，并核对设置、摘要及模型列表保留。
- Windows、Linux 与 macOS 自动测试执行实际发布包的安装和启动，不只运行源码测试。

## 0.5.21 — 2026-10-08

- Deploy native DSH settings UI in place of the external console bridge.
- Import DSH originals and existing summary trees from the shared archive without model calls; reject conflicting node content or references instead of overwriting them.
- Correct native ready-node visibility, semantic levels and session summary counts.
- Show only summary and compaction settings in the plugin UI; retain archive recall tools.
- Read persisted cold tails incrementally and preserve real session activity times.

## 0.5.20 — 2026-10-07

- Rebuild as a DSH-only plugin with native conversations, summary and optional compaction settings.
- Port the latest ratio-based compaction engine and detached hierarchical summary policy.
- Preserve the old database path and recall tools; archive complete structured originals.
- Default to native DSH compaction, with independent explicit summary and compaction models.
- Fix actual nested tool messages, source-budget boundaries, pending capture scheduling and cross-process settings writes.
- Validate on real DSH 0.2.1-alpha.1 and add standalone runtime, archive and UI regression tests.

## Historical releases



## 未发布 / Unreleased

- 新增 `scripts/preflight-upgrade.mjs`:dsh 升级前的试飞闸。把候选版本装进隔离目录(不动现役),用「契约面 + 差分测试 + 组合挂载」三层检查,只报候选相对现役**新增**的问题。方法核心是差分:同一套检查同时跑基线与候选,绝对判定会把「测试原本配桩写」的环境性失败误报成 breaking change(实测假警报两次)。
- 试飞顺带查出并清掉 acp profile 里 codex-connect 删除后遗留的悬空补丁(`- id: llm-openai-codex`,15 行),该补丁此前每次启动都报 `patch: entry "llm-openai-codex" not found`。
- Added `scripts/preflight-upgrade.mjs`, a differential pre-upgrade gate: contract surface, differential tests, and composition, with the baseline run as the reference so environment-only failures are never reported as regressions.

## 0.3.0-alpha.13 — 2026-09-22 — 2026-09-22

- 修复设置页字号与官方不一致（控件偏大）：`inputStyle`/`buttonStyle` 同时写了 `fontSize: 13` 和 `font: "inherit"`，而 `font` 简写排在后面，会把字号重置成继承值（主题的 `--dsh-content-font-size`，本机为 15px）。控件于是按 15px 渲染，比周围官方文字大一圈。
- 控件一律改为只写长属性（`fontFamily: "inherit"` + 显式 `fontSize`），并按官方口径对齐：行标签 14px/600、输入与按钮 14px、次级链接 13px、说明 12px。
- 新增两条渲染期断言：样式对象不得混用 `font` 简写与字号长属性；`input`/`select`/`button` 必须同时固定字族与字号且不超过官方控件字号（14px）。两条断言在 alpha.12 上均失败。
- Fix the settings page typography: the `font: "inherit"` shorthand came after `fontSize`, resetting controls to the inherited size (15px). Controls now use longhands only and match the official sizes.

## 0.3.0-alpha.12 — 2026-09-22 — 2026-09-22

- 修复设置页完全不工作、参数不显示：`configForms.describe()` 返回的是 describe 镜像（`getSnapshot`/`subscribe`/`ensure`），不是命名空间数组；alpha.11 把它当数组遍历，直接抛 `namespaces is not iterable`，导致整个组合包配置页挂掉。
- 引擎条目改为在镜像快照就绪后按 schema 字段特征发现，并用 `subscribe` + 重渲染跟随；镜像尚无答案时显示「加载中」，不再误报「设置服务不可用」。
- 新增 `test/client-contract.test.js`：用最小 React 运行时把浏览器组合包真正渲染一遍，覆盖条目发现、未就绪态与摘要视图；该用例在 alpha.11 上稳定复现线上故障。
- Fix the bundle configuration page rendering nothing: `configForms.describe()` returns the describe mirror, not a namespace array, so alpha.11 threw `namespaces is not iterable`. The engine entry is now discovered from the mirror snapshot with schema-based matching.

## 0.3.0-alpha.11 — 2026-09-22 — 2026-09-22

- 适配 DSH 0.1.7：宿主侧 `settings.installSection()` 已被官方删除，改为在引擎 `Config` 上声明 `.volatile()` 字段并监听 `loader/volatile-update`，设置变更继续热更新运行中的引擎实例。
- Web 客户端 `settingsScope` 服务改名为 `configForms`，`bind({namespace})` 改为 `get(entryId)`；表单按引擎条目 id（约定 `SuperLcm-engine`）寻址，路由字段拆为宿主 Config 的标量 `summarizationProvider/Model` 与 `fallbackSummarizationProvider/Model`，主/备用路由切换改用一次 `mutate()` 原子提交。
- 注意：`z.intersect` 会拆散 volatile 引用（实测 schemastery 3.18.3），引擎 Config 改为单层平铺 `z.object`，继承自 BasicCompactionEngine 的字段同形重声明。
- Migrate to the DSH 0.1.7 settings model: volatile Config fields plus `loader/volatile-update` replace the removed `installSection` API, and the web form targets the engine entry through `configForms.get()` with atomic route mutations.

## 0.3.0-alpha.10 — 2026-09-22 — 2026-09-22

- 新增可选的备用摘要 provider/model：主路由失败后最多重试一次，取消时不触发备用请求，两个路由都不会回退到主 Agent。
- 主/备用路由按调用隔离并固定快照，不修改共享 engine config；Web 设置支持从同一模型目录选择、热更新或清空备用路由。
- Add an optional backup summarizer route with one-shot failover, cancellation preservation, per-call route isolation, and live Web settings.

## 0.3.0-alpha.9 — 2026-09-21

- 仓库与插件市场展示名统一为英文 `SuperLcm — Lossless Context`；市场提交说明采用中文优先、英文补充的双语格式。
- 仓库根 README 改为默认中文的详细项目介绍：直接展示 LCM 官方预览并链接交互式动态讲解，同时加入仓库原生 LCM 流程动画。
- 详细说明异步压缩为什么不阻塞回复、较小活动上下文的收益、冻结前缀 Prompt Cache 策略、缓存成本边界，以及 DSH Event Log + SQLite DAG 的无损召回链。
- 公共安装文档改用 DSH profile 命令；保留完整英文版、平台兼容矩阵与安全报告策略，不再部署独立项目站。
- 移除测试中的 POSIX `/tmp` 假设，CI 扩展到 Windows、Linux、macOS；运行时继续只使用 Node.js 跨平台路径解析，不包含本机 `/Users/...` 硬编码。
- Make the repository README the bilingual project home, embed an original LCM flow animation, link the official interactive explainer, and document async compaction, cache economics, exact recall, and SQLite storage.

## 0.3.0-alpha.8 — 2026-09-21

- 高级 rolling 参数改为一次 `scope.mutate()` 原子提交，关联字段不再因逐项校验而产生假失败或部分落盘。
- 派生索引新增普通事件扫描高水位；无新压缩时不再反复扫描相同尾部，同时为未完成事务和索引失败保留安全重试边界。
- `:memory:` 现在真正使用 SQLite 内存库，不再在仓库根目录生成持久文件；同步 schema-v2 游标迁移、文档和部署锁文件。

## 0.3.0-alpha.7 — 2026-09-21

- 测试 runner 改为纯内存 ESM loader，不再创建、替换或删除项目的 `node_modules`；手动压缩完整继承宿主 `compactNow(agent, signal, sourceCommandId)` 合同。
- 派生索引只接纳完整成功的 start/summary/checkpoint/end 生命周期，并以成功 end seq 增量推进；失败、不完整或 marker/source 不匹配的事务不会入库。
- DAG 子边只来自 DSH 认证的 checkpoint source，阻断用户文本 marker 注入；修复共享子图层级、全量 doctor、只读 doctor 和多节点展开共享字符预算。
- 移除无效 ratio/TTL 设置；旧配置键仍作为无操作兼容项被安全忽略，设置热更新改为一次同步切换完整运行配置，并同步更新 WebUI、示例和架构文档。
- Replace the destructive test harness, restore the host manual-compaction contract, harden committed-lifecycle indexing and marker trust, and make diagnostics/budgets/settings match their public contracts.

## 0.3.0-alpha.6 — 2026-09-21

- 缓存策略改为真正的前缀稳定：system 与已提交 checkpoint 连续冻结，后续只压其后的原文；常规摘要提前在后台准备，到上下文压力线才换入，不再猜缓存 TTL。
- hard cap 且后段无法继续缩减时，才低频合并冻结 checkpoint；原文仍由事件日志与 DAG 精确召回。
- Preserve an exact immutable system/checkpoint prefix, prepare raw-history summaries early, and mutate the surface only under context pressure; frozen checkpoints merge only as a hard-cap fallback.

## 0.3.0-alpha.5 — 2026-09-21

- 将缓存门从后台摘要启动阶段移到 active-prefix 提交阶段：cache-hot 时可以预生成摘要，但常规批次保持 ready，直到 cold-cache pre-step 才替换前缀；soft/hard/overflow 仍可越过延迟。
- Move the cache gate from detached preparation to prefix mutation: prepare while hot, commit routine work only before a cold-cache request.

## 0.3.0-alpha.4 — 2026-09-21

- 恢复并明确缓存友好准入：最前面的 system message 永不进入压缩选区；cache-hot 时暂缓普通 64k 批次，soft/hard pressure 仍可越过缓存保护。
- Restore and document cache-aware admission while retaining fully asynchronous execution.

## 0.3.0-alpha.3 — 2026-09-21

- 自动压缩改为全面非阻塞后台管线：固定选区、独立模型摘要、稳定性校验后原子提交；soft-cap、hard-cap 与常规批次均不再等待摘要。
- Background compaction is now fully non-blocking: stage a stable range, summarize through an independent configured route, then atomically commit only if the range is still valid.
- 拒绝 `foldTiming: sync`、`mode: threshold` 与空摘要路由，且不会回退到当前 Agent/custom-subagent 模型。

## 0.3.0-alpha.2 — 2026-09-21

- 修复 WebUI 设置命名空间使用大写名称导致设置服务不可用的问题；显示名称仍为 `SuperLcm`，内部键改为 `superlcm`。
- Fixed the WebUI settings namespace: the display name remains `SuperLcm`, while the settings key is now the valid lowercase `superlcm`.
- 升级补丁版本以避免本地压缩包缓存复用旧内容。/ Bumped the patch version to avoid reusing stale local tarball contents.

## 0.3.0-alpha.1 — 2026-09-21

- 将包名和 WebUI 配置界面统一改名为 SuperLcm。/ Rename the package and WebUI configuration surface to SuperLcm.
- 通过当前 `plugins.bundle.config` 宿主槽注册浏览器配置。/ Register browser configuration through the current `plugins.bundle.config` host slot.
- 迁移期间保留旧导出和旧 SQLite 路径。/ Preserve legacy exports and the old SQLite location during migration.

## 0.2.0-alpha.9 — 2026-09-14

- Read DSH rc.2 session events through `snapshotEvents()`, retaining the legacy array API for older hosts. Indexing, raw-event search, exact expansion and diagnostics use the same reader.
- Reject unsupported session APIs before rebuilding an index; never silently treat unavailable logs as empty. Doctor reports stale index entries as unhealthy without deleting them.
- Verified against this deployment's real v3 session using the installed rc.2 Session implementation: all 182 cited original events recovered exactly across eight pages. Original session and production SQLite index were not changed by this isolated verification. New automatic compaction is not covered by that replay.

## 0.2.0-alpha.8 — 2026-09-02

- The WebUI plugin card now offers the summarizer route as one dropdown fed by
  the Host model catalog (`remote.session.modelCatalog`, the same directory the
  main model picker reads), grouped by provider with a “follow the main Agent”
  entry that shows the current default. Choosing an entry saves the route
  atomically; unknown routes render as “custom”, and a manual provider/model
  form remains as a fallback when the catalog is unavailable.
- Rolling and cache-policy fields moved under a collapsed “advanced” section,
  regrouped into context limits / compaction rhythm / fallback compaction, with
  plain-language labels and shorter hints in both locales.
- `dsh.client.inject` now lists `@deepseek-ai/dsh-api-remotes` and
  `@deepseek-ai/dsh-api-session-controller`; the client entry injects
  `remote` and `remote.session`. Engine and settings keys are unchanged.

## 0.2.0-alpha.7 — 2026-09-01

- 通过 `SuperLcm` 设置区域暴露 DSH 原生的 `summarizationProvider` / `summarizationModel` 路由；两项留空表示“跟随当前 Agent 路由”。/ Expose DSH's native `summarizationProvider` / `summarizationModel` route through the `SuperLcm` settings section; both blank means “follow the current Agent route”. A dedicated summarizer requires both fields and applies live to later compactions without plugin reload.
- The WebUI plugin card now exposes the summarizer provider/model as free-form
  adapter IDs, plus the complete cache-aware rolling policy. It deliberately
  avoids binding the session-scoped conversation ModelSelect to this global
  compaction setting.
- Align WebUI fallbacks with the alpha.6 engine defaults: 32k fresh-token floor,
  20k pressure reduction, 64k routine batch, 160k/220k soft/hard caps, and a
  1800-second cache heuristic. The old browser-only 20k routine default is gone.
- Reject half-configured summarizer routes and add live-settings tests. The test
  schema stub now supports strings, and syntax validation includes `lib/` so a
  broken browser bundle fails CI before packaging.

## 0.2.0-alpha.6 — 2026-09-01

- Rolling mode is now cache-aware instead of rewriting the active prefix for
  every small batch. The persistent-worker defaults keep 24 recent surface
  nodes plus at least 32k recent tokens verbatim, use a 64k routine commit
  batch, and defer routine mutation while the provider cache is likely hot.
- New pressure boundaries: `softActiveTokens=160000` admits a useful fold once
  at least `pressureFoldTokens=20000` can be removed; `hardActiveTokens=220000`
  forces any balanced useful reduction. Under the hard cap only, the 24-node
  tail preference may relax to one recent node while the 32k token floor and
  tool-pairing guard remain intact.
- New `cacheTtlSeconds` heuristic (default 1800): the first observed step is
  conservatively treated as cache-hot; later inter-step gaps inside the TTL
  defer routine prefix mutation. `0` disables cache deferral.
- `foldTiming: "background"` is now limited to opportunistic `cold-batch`
  folds. Soft/hard pressure folds are synchronous even in background mode so
  the active-context caps are guaranteed to land before the next model
  request. Background folds remain fail-closed if DSH's whole-surface
  stability check observes a concurrent append.
- Rolling logs include the admission reason, active token estimate, retained
  tail estimate, and hot/cold cache heuristic.
- Added `docs/CACHE_POLICY.md` and an explicit GPT-5.6 Sol persistent-worker
  example. This alpha deliberately does not fake detached 20k leaf summaries;
  DSH currently exposes one summarizer transaction per `compactRegion()`.
- Declare the directly imported `@deepseek-ai/dsh-compaction` and
  `@deepseek-ai/dsh-llm` packages as optional peers, matching the existing
  duplicate-core avoidance policy.

## 0.2.0-alpha.5 — 2026-09-01

- Fix a browser load crash ("exports is not defined" → "Failed to load
  plugins"): the module-loader convention is for the `factory(require)` body
  to build its own CJS export object, and the packaged bundle omitted the
  declarations. The factory now opens with `var module = { exports: {} };
  var exports = module.exports;` (plus a `Symbol.toStringTag` Module tag) so
  the trailing `exports.*` assignments and `return module.exports` resolve.
  Merged back from the hot-patched profile copy after alpha.4 took the webui
  down at first load.

## 0.2.0-alpha.4 — 2026-09-01

- Web settings page: the plugin now appears as a card under Plugin
  configuration (Plugin configuration) with the rolling-compaction
  tunables — tail message count, fold batch tokens, fold timing, compaction
  threshold and retention ratio — editable with Save/Discard staging.
  Host side, the engine registers a `SuperLcm` settings section via `settings.installSection`; 宿主侧引擎通过 `settings.installSection` 注册 `SuperLcm` 设置区域；changes apply live to `rollingConfig`, and the
  threshold/retention ratios are spread-replaced onto the frozen base config
  (a token-based retention form is dropped so the ratio takes effect). A
  validate hook rejects `retainRatio >= thresholdRatio` both on the host and
  in the card.
- `mode` is intentionally not exposed on the card: switching it requires
  re-registering the pressure hooks, so it stays host-config-only and applies
  on plugin reload.
- New `./client` browser bundle (plain React.createElement, no build tooling)
  with `dsh.client` web-platform metadata; runtime injects are the locale and
  settings-scope services only — UI primitives are not imported so the
  client-plugin purity gate holds.

## 0.2.0-alpha.3 — 2026-09-01

- New rolling option `foldTiming: "background"` (default): lossless-claw style
  asynchronous folding. The pre-step hook no longer blocks the agent step on a
  fold — a pending fold from the previous step is settled first (so two
  summarizer calls never race for the session's single compaction lock), then
  the new pass runs unawaited, hiding its latency under the current model
  request and tool execution. DSH's span-stability assertion still rejects the
  commit if anything disturbs the selected region, and a failed background
  fold is logged and retried on the next pre-step instead of breaking the turn.
- `foldTiming: "sync"` restores the previous blocking behavior where the step
  awaits the fold before the next model request.

## 0.2.0-alpha.2 — 2026-09-01

- Fix a constructor-timing crash that broke webui startup in a launchd restart
  loop: the DSH base constructor invokes the automatic-compaction hook during
  `super()`, before the subclass `rollingConfig` field is assigned, so reading
  `rollingConfig.mode` threw `TypeError`. Registration is now deferred to a
  microtask that fires after construction; semantics are unchanged.
- The test-harness stub base now mirrors the real DSH timing (hook invoked
  during `super()`) and a regression test covers the deferral.

## 0.2.0-alpha.1 — 2026-09-01

- New `mode: "rolling"` compaction policy (default): lossless-claw style
  steady-state maintenance. Every agent step keeps a fresh verbatim tail of
  `tailCount` surface nodes and folds the older head into the running summary
  once it exceeds `foldBatchTokens`, so the active surface stays inside its
  budget instead of growing until a one-shot threshold fires.
- Repeated rolling folds chain summary markers into the multi-level recall DAG
  automatically; `lcm_describe` now reports the computed `level` of each node.
- `mode: "threshold"` preserves the 0.1.x behavior verbatim (official
  thresholdRatio/retainRatio pressure compaction).
- Context-overflow recovery (fold on provider context-window errors, then
  retry the request) is preserved in both modes.
- Selection reuses the official tool-pairing balance guard, so a rolling fold
  never splits a tool call/result pair.

## 0.1.0-alpha.1 — 2026-08-31

- First DSH-native lossless-context alpha.
- DSH session log retained as the sole raw-history authority.
- Hierarchical checkpoint markers and SQLite summary DAG.
- Six recall, expansion, repair and health tools.
- Exact pagination through oversized individual events.
- Fork-safe `(session_id, node_id)` storage.
- Safe bundle mounts tools only; compaction replacement is explicit per Agent preset.