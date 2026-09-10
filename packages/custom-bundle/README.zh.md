# @alisheramantay/dsh-custom-bundle

[English](README.md) | 中文

这是本插件集有明确取舍的 profile layer。它替换 Host goal-round driver、增加 `read_pdf`，并替换 Web Chat 与 Goal Client 插件。请在普通 DSH Web bundle 之后安装：

```sh
dsh plugin --profile <name> add @alisheramantay/dsh-custom-bundle
```

该 bundle 还附带 `preset/observational`。把该目录复制到 DSH 报告的可写 agent-preset 根目录，并在启动会话前验证挂载。该 preset 会以 `@alisheramantay` 包替换 stock goal 工具和 compaction provider，同时保留必需的隔离 compaction realm。

Memorix 保持为独立 opt-in bundle，因为它需要外部可执行文件。
