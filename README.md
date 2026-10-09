<p align="center"><img src="docs/images/icon.svg" width="88" alt="SuperLcm"></p>

<h1 align="center">SuperLcm for DSH</h1>

<p align="center"><b>完整原文留在本机，历史细节随时找回。</b><br>后台分层摘要 · 精确召回 · 可选上下文压缩</p>

<p align="center"><b>中文</b> · <a href="README.en.md">English</a> · <a href="https://github.com/yu381792/superlcm">完整 SuperLcm 项目 →</a></p>

SuperLcm for DSH 为 **DeepSeek Harness（DSH）** 保存完整对话，在后台整理分层摘要，让智能体需要历史细节时能找到并读取原文。摘要和压缩都在 **DSH 插件设置页**管理，使用 DSH 已配置的供应商和模型。

这是 SuperLcm 的 DSH 独立版。需要在 Claude Code、Codex、Hermes、Pi 和 DSH 之间共享归档、接续任务，或了解完整设计，请看 **[SuperLcm 主项目](https://github.com/yu381792/superlcm)**。

## 给 DSH 留一份完整记忆

- **原话一直可查。** 用户消息、智能体回复和工具记录按事件编号保存，需要核对某个决定时，直接读回当时的记录。
- **后台把长对话整理成目录。** 一段原文生成一个摘要，相邻摘要再合并为更高层。先找相关摘要，再查对应原文。
- **摘要使用单独选择的模型。** 沿用 DSH 的模型配置和账户，摘要模型可以与任务模型分别设置。
- **设置就在插件里。** 打开「插件 → SuperLcm」，管理摘要分块、模型和可选压缩。远程浏览器使用同一个 DSH 连接。

## 从后台摘要开始

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/dsh-recall-zh-dark.gif"><img src="docs/images/dsh-recall-zh-light.gif" alt="流程示意：DSH 对话持续归档，原文分块成为摘要，摘要合并成上层目录，智能体沿目录读回原文中的端口决定。"></picture>

原文归档持续运行。新安装时，后台摘要和压缩接管分别关闭；选择模型后，可以只开启后台摘要，继续由 DSH 原生机制处理上下文压缩。

| 功能 | 在哪里设置 | 做什么 |
|---|---|---|
| 原文归档 | 随插件运行 | 完整保存 DSH 事件，供后续核对 |
| 后台摘要 | 摘要设置 | 按所选模型和分块大小整理历史 |
| 精确召回 | 智能体的召回工具 | 搜索历史、查看摘要、读取原文 |
| 可选压缩接管 | 压缩 | 在所选上下文比例附近一次替换较旧内容 |

摘要默认按约 **20K token** 原文分块。至少四个相邻同层摘要、正文累积足够后，再生成上一层摘要。小尾段等待后续内容，完整工具组保持在一起。

摘要帮助定位历史；精确数字、授权和重要结论通过原文核对。

## 可选：提前准备，到阈值再替换

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/dsh-compaction-zh-dark.gif"><img src="docs/images/dsh-compaction-zh-light.gif" alt="流程示意：开启可选接管后，后台准备并合并摘要，达到所选比例时固定范围，就绪后一次替换较旧内容，最近原文继续保留。"></picture>

开启 SuperLcm 压缩接管后，引擎在后台准备摘要，达到所选比例并且摘要就绪后，一次替换固定范围内的较旧上下文。近期原文继续保留，完整历史仍可召回。

- **按模型容量触发。** 默认使用有效输入容量的 **80%**，支持预设和自定义百分比，适合切换不同上下文长度的模型。
- **分块大小可调。** 压缩分块与后台摘要分块分别设置。
- **准备期间继续使用原文。** 草稿生成和摘要合并在后台完成，固定范围准备好后才提交。
- **独立开关和模型。** 后台摘要与压缩接管各自配置；关闭接管后恢复 DSH 原生压缩。

开启两种功能时，各自可能产生模型请求。摘要效果取决于所选模型，建议先使用后台摘要，再按自己的任务需要决定是否接管压缩。

## 安装与更新

要求 **Node.js 22.16+**。本版实测宿主为 **DSH 0.2.1-alpha.1**，当前插件版本 **0.5.23**。

在仓库目录执行 `npm pack`，然后使用 DSH 官方命令安装生成的文件。以下示例在文件所在目录执行：

```sh
npm pack
dsh plugin --profile web add ./SuperLcm-0.5.23.tgz
```

Windows PowerShell 可使用：

```powershell
dsh plugin --profile web add ".\SuperLcm-0.5.23.tgz"
```

重启对应 DSH 宿主，打开 **插件 → SuperLcm → 摘要设置**，选择模型并开启后台摘要。压缩接管在独立的「压缩」页中选择。

已安装同名独立插件时，以上命令更新包，并保留现有设置和数据库。若此前使用完整 SuperLcm 的全局 DSH 接入，先在它的「管理接入」中取消 DSH 接入，再安装独立版。旧自定义补丁若另行挂载引擎或工具，也应退出旧入口，保持一套活动插件。

## 让智能体读回历史

| 工具 | 用途 |
|---|---|
| `lcm_find` | 搜索已归档会话和原文 |
| `lcm_outline` | 查看会话的分层摘要目录 |
| `lcm_read` | 按事件编号读取完整原文 |

旧版工具 `lcm_grep`、`lcm_describe`、`lcm_expand`、`lcm_expand_query`、`lcm_reindex`、`lcm_doctor` 继续用于压缩索引的查阅和维护。

## 数据保存在运行 DSH 的机器上

原文、摘要和设置保存在本机数据库中。生成摘要时，所选片段会发送给 DSH 中配置的模型供应商。远程浏览器通过已登录的 DSH 连接读取设置，数据库路径由宿主机器解析。

数据库默认位于 `$DSH_HOME/SuperLcm/lcm.sqlite`；未设置 `DSH_HOME` 时使用当前用户的 `~/.dsh`。支持 `DSH_SUPERLCM_DB` 自定义文件，兼容旧 `DSH_LOSSLESS_DB` 和 `lossless-context` 数据库路径。

## 了解更多

- **[完整 SuperLcm 项目](https://github.com/yu381792/superlcm)**：多工具共享归档、跨工具接续和完整产品介绍。
- [独立版设计](docs/ARCHITECTURE.md) · [升级说明](docs/UPGRADE-0.5.23.md) · [验证范围](docs/VALIDATION.md)
- [更新记录](CHANGELOG.md) · [参考机制与依赖](THIRD_PARTY_NOTICES.md) · [MIT 许可](LICENSE)

本版通过 50 项测试和 macOS 真实安装升级验证。Windows 代码兼容审查已完成，Windows 实机测试未执行，具体范围见验证文档。

开发检查：`npm run validate`。真实安装升级验证：`npm run test:install`。GitHub 自动测试保持关闭。

SuperLcm 是独立项目，与 DeepSeek 无隶属或官方背书关系。相关名称仅用于说明兼容工具。
