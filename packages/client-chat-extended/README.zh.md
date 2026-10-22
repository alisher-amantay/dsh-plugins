# @alisheramantay/dsh-client-chat-extended

[English](README.md) | 中文

这是 stock Web Chat Client 插件的替代包。它保留当前 Chat composition；当前台工具调用已显示其确切运行工作时，会隐藏通用模型活动状态。后台任务不会隐藏模型活动。

源码是 DSH 0.2.1 的 `@deepseek-ai/dsh-client-ui-chat` 加上这一处改动，因此其他 Chat 行为（包括在 Web 右侧栏预览中打开链接文件）都与 stock 包一致。`src/` 由 `node build/vendor-ui-chat.ts` 生成：它复制 Harness 的 Chat client 并应用 `CHAT_EDITS` 中已记录的改动；vendor-drift 测试会拒绝不再匹配的副本，因此 Harness 更新只需重新生成并审查，而无需手工移植。

通过 `@alisheramantay/dsh-custom-bundle` 将它挂载到现有 `ui-chat` row id。
