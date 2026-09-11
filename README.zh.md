# Alisher Amantay DSH 插件

[English](README.md) | 中文

`@alisheramantay/dsh-observational-memory` 是 [pi-observational-memory](https://github.com/elpapi42/pi-observational-memory) 的移植版本。

本 workspace 包含可独立发布的 Cordis 插件与一个有明确取舍的 DeepSeek Harness bundle。产品行为保留在 `@alisheramantay/*` 包中；上游 `@deepseek-ai/*` 包只公开可复用的扩展 API。

## 包

- `@alisheramantay/dsh-observational-memory` — 会话本地的观察、反思、证据召回与确定性 compaction。
- `@alisheramantay/dsh-observational-memory-bundle` — 在原本已启用 compaction 的所有模式中将观察式记忆安装为默认引擎。
- `@alisheramantay/dsh-tool-pdf` — 通过专用 `read_pdf` 工具进行有界 PDF 页面栅格化。
- `@alisheramantay/dsh-tool-goal-extended` — 扩展面向模型的 goal 工具，可暂停到自有后台任务结束。
- `@alisheramantay/dsh-goal-round-driver-delayed` — 带可取消节奏延迟的 goal 续行 driver 替代包。
- `@alisheramantay/dsh-client-goal-extended` — 替换 Goal Client 插件，在 Web composer dock 中显示 Round 进度并编辑上限。
- `@alisheramantay/dsh-client-chat-extended` — 替换 Chat Client 插件；当前台工具已报告具体工作时，隐藏通用模型活动状态。
- `@alisheramantay/dsh-custom-bundle` — 为自定义发行版安装 Host 与 Web row。

## 开发

运行 `pnpm install`，再运行 `pnpm run check`。开发期间，根 override 会从相邻的 `../deepseek-harness` checkout 链接三个尚未发布的扩展 API；发布包 manifest 只包含 semver peer range。请先发布匹配的 Harness 版本，再发布观察式记忆包。

自定义 bundle 会安装 profile 全局 row 与替换后的 preset roster。标准、PTC 与 Cordis 模式会自动获得观察式记忆和扩展 goal 工具；Minimal 保持不变。
