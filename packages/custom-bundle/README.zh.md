# @alisheramantay/dsh-custom-bundle

[English](README.md) | 中文

这是本插件集有明确取舍的 profile layer。它替换 Host goal-round driver、增加 `read_pdf`，并替换 Web Chat 与 Goal Client 插件。请在普通 DSH Web bundle 之后安装：

```sh
dsh plugin --profile <name> add @alisheramantay/dsh-custom-bundle
```

该 bundle 保留随产品提供的 `standard`、`ptc`、`cordis` 与 `minimal` preset ID，使已有 Session 继续使用原来的 ID。它覆盖 `@deepseek-ai/dsh-web-app` 中 `standard`、`ptc` 与 `cordis` 的声明，用观察式记忆替换 Basic Compaction，并用扩展 goal 工具替换内置工具；`minimal` 保持不变。新 Session 默认使用 `standard`。

`Weak-Strong Review` 增加第五种模式：一个从 `standard` 派生的编排 preset，在持久 goal 下让较弱的 `implement` 委派与较强的 `review` 委派循环（数值评判 + 修正说明）。两个模型固定在 `build/preset-overrides.ts` 中 `tool-implement` 与 `tool-review` 的 `agentOptions` 里；首次使用前，请将其 `provider`、`model` 与 `reasoningEffort` 替换为你实际的弱、强路由。

需要 DSH 0.2.1（`>=0.2.1-alpha.2 <0.2.2`）。`presets/` 中的文件由该版本内置的 preset 生成；更新 Harness 后，运行 `node build/preset-overrides.ts` 并审阅差异。
