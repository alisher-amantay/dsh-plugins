# @alisheramantay/dsh-goal-round-driver-delayed

[English](README.md) | 中文

这是 `@deepseek-ai/dsh-goal-round-driver` 的 Host plane 替代包，并增加一个设置：

```yaml
- id: goal-round-driver
  name: '@alisheramantay/dsh-goal-round-driver-delayed'
  config:
    continuationDelayMs: 15000
```

延迟结束后，driver 会重新检查确切的空闲 agent 以及 active、armed 的 goal revision。agent dispose 与插件 teardown 会取消 timer，因此 profile live reload 不会等待节奏间隔。
