# @alisheramantay/dsh-goal-round-driver-delayed

English | [中文](README.zh.md)

A host-plane replacement for `@deepseek-ai/dsh-goal-round-driver` with one additional setting:

```yaml
- id: goal-round-driver
  name: '@alisheramantay/dsh-goal-round-driver-delayed'
  config:
    continuationDelayMs: 15000
```

The driver rechecks the exact idle agent and active, armed goal revision after the delay. Its timer is cancelled during agent disposal and plugin teardown, so live profile reload does not wait for the cadence interval.
