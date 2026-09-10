# @alisheramantay/dsh-client-goal-extended

English | [中文](README.zh.md)

A browser Client replacement for the stock goal UI. It retains the goal dock and `/goal` rendering while adding completed-round progress and an editor for the total round cap.

Mount it under the existing Web row id so it replaces the stock package:

```yaml
- id: ui-goal
  name: '@alisheramantay/dsh-client-goal-extended'
```

The host goal service rejects a cap below the number of rounds already started.
