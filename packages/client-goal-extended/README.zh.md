# @alisheramantay/dsh-client-goal-extended

[English](README.md) | 中文

这是 stock goal UI 的浏览器 Client 替代包。它保留 goal dock 与 `/goal` 渲染，同时增加已完成 Round 进度和总 Round 上限编辑器。

将它挂载到现有 Web row id，以替换 stock 包：

```yaml
- id: ui-goal
  name: '@alisheramantay/dsh-client-goal-extended'
```

Host goal 服务会拒绝低于已开始 Round 数的上限。
