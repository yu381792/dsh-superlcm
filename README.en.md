<p align="center"><img src="docs/images/icon.svg" width="88" alt="SuperLcm"></p>

<h1 align="center">SuperLcm for DSH</h1>

<p align="center"><b>Keep every original. Recall any detail.</b><br>Background summaries · Exact recall · Optional context compaction</p>

<p align="center"><a href="README.md">中文</a> · <b>English</b> · <a href="https://github.com/yu381792/superlcm">Full SuperLcm project →</a></p>

SuperLcm for DSH preserves complete conversations in **DeepSeek Harness (DSH)**, organizes history into layered background summaries, and gives the agent tools to read exact originals when details matter. Summary and compaction controls live in the **native DSH plugin settings**, using providers and models already configured in DSH.

This is the standalone DSH edition. For a shared archive across Claude Code, Codex, Hermes, Pi and DSH, conversation handoffs, and the complete product design, see **[the full SuperLcm project](https://github.com/yu381792/superlcm)**.

## A complete memory for DSH

- **Keep the original words.** User messages, agent replies and tool records remain available by event number.
- **Build an outline in the background.** Source segments become summaries; adjacent summaries form higher layers. Locate a topic, then read its source.
- **Choose a separate summary model.** Reuse DSH's existing providers and accounts, with independently selected task and summary models.
- **Manage everything inside the plugin.** Open **Plugins → SuperLcm** for summary and optional compaction settings. Remote browsers use the same authenticated DSH connection.

## Start with background summaries

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/dsh-recall-en-dark.gif"><img src="docs/images/dsh-recall-en-light.gif" alt="Illustration: archive DSH originals, summarize source segments, merge an outline, then read the original deployment-port decision."></picture>

Original archiving runs with the plugin. On a fresh installation, summarization and compaction takeover are independently off. Select a model and enable background summaries while DSH continues to handle native compaction.

| Feature | Control | Purpose |
|---|---|---|
| Original archive | Runs with the plugin | Preserve complete DSH event records |
| Background summaries | Summary settings | Organize history with the selected model and source granularity |
| Exact recall | Agent tools | Search history, inspect summaries and read originals |
| Optional takeover | Compaction settings | Replace an older fixed context range near the selected percentage |

Source segments default to approximately **20K tokens**. At least four adjacent same-level summaries, with enough accumulated body text, are merged into a higher layer. Short tails wait for more content, and complete tool groups stay together.

Summaries locate history. Exact numbers, authorizations and consequential decisions should be checked against the originals.

## Optional: prepare ahead, replace at the threshold

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/dsh-compaction-en-dark.gif"><img src="docs/images/dsh-compaction-en-light.gif" alt="Illustration: with optional takeover enabled, prepare and merge in the background, fix the range at the chosen threshold, then commit once and retain recent originals."></picture>

When takeover is enabled, the engine prepares summaries in the background and commits a fixed older range once the selected threshold is reached and that range is ready. Recent originals remain in context, and complete history remains available through recall.

- **Follow the active model's capacity.** The default trigger is **80%** of available input capacity, with presets and custom percentages.
- **Adjust source granularity.** Compaction chunks and archive-summary chunks are configured separately.
- **Keep originals during preparation.** Drafts and merges are prepared before the fixed replacement is committed.
- **Independent controls and models.** Background summaries and takeover have separate switches. Turning takeover off restores DSH native compaction.

Enabling both paths may produce separate model requests. Summary quality depends on the selected model; start with background summaries and choose takeover according to your task.

## Install and update

Requires **Node.js 22.16+**. Tested with **DSH 0.2.1-alpha.1**. Current plugin version: **0.5.23**.

Build in the repository directory and install the generated archive with the official DSH command:

```sh
npm pack
dsh plugin --profile web add ./SuperLcm-0.5.23.tgz
```

Windows PowerShell:

```powershell
dsh plugin --profile web add ".\SuperLcm-0.5.23.tgz"
```

Restart that DSH host and open **Plugins → SuperLcm → Summary settings**. Choose a model and enable background summaries. Optional takeover has its own Compaction tab.

Installing over the existing standalone `SuperLcm` package updates it while keeping settings and the database. If using the full SuperLcm global DSH connection, disconnect DSH there before installing this edition. Retire custom patches that separately mount an older engine or tool entry.

## Recall tools

| Tool | Purpose |
|---|---|
| `lcm_find` | Search archived sessions and original text |
| `lcm_outline` | Inspect a session's layered summary outline |
| `lcm_read` | Read complete originals by event number |

Legacy tools `lcm_grep`, `lcm_describe`, `lcm_expand`, `lcm_expand_query`, `lcm_reindex` and `lcm_doctor` remain available for compaction-index inspection and maintenance.

## Data lives on the DSH host

Originals, summaries and settings are stored locally. Selected source segments are sent to the configured provider when summaries are generated. Remote browsers read settings through their authenticated DSH connection; the host resolves database paths.

The default database is `$DSH_HOME/SuperLcm/lcm.sqlite`, using the current user's `~/.dsh` when `DSH_HOME` is unset. `DSH_SUPERLCM_DB` selects a custom file; the legacy `DSH_LOSSLESS_DB` and `lossless-context` locations remain compatible.

## More

- **[Full SuperLcm project](https://github.com/yu381792/superlcm)**: shared archives, cross-tool handoffs and the complete product introduction.
- [Architecture](docs/ARCHITECTURE.md) · [Upgrade notes](docs/UPGRADE-0.5.23.md) · [Validation scope](docs/VALIDATION.md)
- [Changelog](CHANGELOG.md) · [Design references and dependencies](THIRD_PARTY_NOTICES.md) · [MIT license](LICENSE)

50 tests and a real macOS installation/upgrade check passed. Windows portability was reviewed; an actual Windows run was not performed. See the validation document for scope.

Development checks: `npm run validate`. Real install/upgrade check: `npm run test:install`. Repository Actions remain disabled.

SuperLcm is an independent project and is not affiliated with or endorsed by DeepSeek. Names identify compatible tools.
