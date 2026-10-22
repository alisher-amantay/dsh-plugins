# @alisher-amantay/dsh-observational-memory

[English](README.md) | 中文

该插件是 [pi-observational-memory](https://github.com/elpapi42/pi-observational-memory) 的移植版本。

DeepSeek Harness 的会话本地观察式记忆。该 Cordis 服务扩展基础 compaction engine，记录有来源的观察与反思，提供 `/memory-status` 和 `/memory-view`，并注册 `observational_memory_recall` 以精确分页证据。

在 agent preset 中，将它挂载到 compact command 和结果 pruner 所在的同一个隔离 `compaction` 与 `toolResultPruner` realm。不要将它与另一个 compaction provider 同时挂载。

该插件把 ledger 写成 `plugin:observational-memory/…` 插件记录，这些记录带有 `ignorable: true`。未加载本包的 Harness 安装仍可忽略可选记忆 projection 并重建普通对话。V4 Session 格式之前写入的会话把同样的记录存为 `observational-memory/…` 事件；V3-to-V4 迁移会把它们重命名到 `plugin:` 命名空间，因此 projection 能读取两代记录。确定性压缩摘要仍使用普通第一方 compaction 事件。

观察工作以 token 为时钟：完成的 step 或 turn 会触发它，`observeAfterTokens` 决定第一个观察块的起点，一次触发最多连续消耗四个观察块，因此覆盖范围能在长 turn 内跟上。工作者已在运行时到达的触发会被排队，而不是丢弃。超过观察输入上限的单条来源消息（compaction checkpoint 或大型工具结果）会以首尾摘录送入观察者，而不是中止覆盖水位。若该调用仍然失败，最旧的一条会被记为跳过，覆盖水位继续前进，因此一个无法回答的 checkpoint 不能冻住 ledger。活跃观察池超过 `observationsPoolTargetTokens` 时，即使观察仍在追赶，也会运行反思和 dropper。压缩不会再让模型重写 transcript。摘要就是渲染后的记忆，只保留仍能装进 `observationsPoolTargetTokens`、且让带框架的 checkpoint 小于被替换区间的最新已覆盖观察。写入摘要前，活跃观察池会被裁到同一目标，优先丢掉最旧、相关度最低的观察，因此积压不会被贴回上下文。压力压缩使用 Pi 的 0.68 窗口比例，而不是等到窗口边缘。溢出恢复会保留最近的尾部，只替换更早的区间，而不是把整个 surface 都影子化。ledger 为空时仍回退到模型摘要。空闲 compaction 会先有限地排空观察积压，以便渲染后的记忆覆盖该区间。

部署方在其希望具备记忆的 preset 中挂载该 provider：`@alisher-amantay/dsh-observational-memory-bundle` 自带标准、PTC 与 Cordis preset，而本 checkout 的产品 Standard、PTC 与 Cordis preset 直接挂载它。Minimal 保持不变。
