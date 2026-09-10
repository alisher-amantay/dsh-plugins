# @alisheramantay/dsh-tool-goal-extended

[English](README.md) | 中文

这是 `@deepseek-ai/dsh-tool-goal` 的替代包，增加 `defer_goal_until_job`。新工具会在一个自有后台任务运行期间停用确切 active goal revision，并在任务以任意终态结束后重新启用它。

请在 agent preset 中使用本包，并沿用现有 `tool-goal` row id。它需要 Host goal、jobs、agent、session-projection、system-prompt 与 tool registry。dispose 会在释放状态前尝试重新启用由本插件延后的每个 goal。
