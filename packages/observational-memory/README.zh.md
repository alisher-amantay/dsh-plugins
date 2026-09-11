# @alisher-amantay/dsh-observational-memory

[English](README.md) | 中文

该插件是 [pi-observational-memory](https://github.com/elpapi42/pi-observational-memory) 的移植版本。

DeepSeek Harness 的会话本地观察式记忆。该 Cordis 服务扩展基础 compaction engine，记录有来源的观察与反思，提供 `/memory-status` 和 `/memory-view`，并注册 `observational_memory_recall` 以精确分页证据。

在 agent preset 中，将它挂载到 compact command 和结果 pruner 所在的同一个隔离 `compaction` 与 `toolResultPruner` realm。不要将它与另一个 compaction provider 同时挂载。

该插件以 `ignorable: true` 写入 ledger 记录。未加载本包的 Harness 安装仍可忽略可选记忆 projection 并重建普通对话。确定性压缩摘要仍使用普通第一方 compaction 事件。

`@alisheramantay/dsh-custom-bundle` 会在标准、PTC 与 Cordis 模式中自动挂载该 provider，同时保持 Minimal 不变。
