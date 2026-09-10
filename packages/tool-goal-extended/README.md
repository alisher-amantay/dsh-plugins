# @alisheramantay/dsh-tool-goal-extended

English | [中文](README.zh.md)

A replacement for `@deepseek-ai/dsh-tool-goal` that adds `defer_goal_until_job`. The new tool disarms the exact active goal revision while an owned background job runs and rearms it after any terminal job outcome.

Use this package in an agent preset under the existing `tool-goal` row id. It requires the host goal, jobs, agent, session-projection, system-prompt, and tool registries. Disposal attempts to rearm every goal deferred by this plugin before releasing its state.
