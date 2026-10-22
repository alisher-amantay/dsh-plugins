# Alisher Amantay DSH 插件

[English](README.md) | 中文

`@alisher-amantay/dsh-observational-memory` 是 [pi-observational-memory](https://github.com/elpapi42/pi-observational-memory) 的移植版本。

本 workspace 包含可独立发布的 Cordis 插件与 DeepSeek Harness bundles。产品行为保留在 `@alisheramantay/*` 包中；上游 `@deepseek-ai/*` 包只公开可复用的扩展 API。

## 包

- `@alisher-amantay/dsh-observational-memory` — 会话本地的观察、反思、证据召回与确定性 compaction。
- `@alisher-amantay/dsh-observational-memory-bundle` — 在原本已启用 compaction 的所有模式中将观察式记忆安装为默认引擎。
- `@alisheramantay/dsh-tool-pdf` — 通过专用 `read_pdf` 工具进行有界 PDF 页面栅格化。
- `@alisheramantay/dsh-tool-goal-extended` — 扩展面向模型的 goal 工具，可暂停到自有后台任务结束。
- `@alisheramantay/dsh-goal-round-driver-delayed` — 带可取消节奏延迟的 goal 续行 driver 替代包。
- `@alisheramantay/dsh-client-goal-extended` — 替换 Goal Client 插件，在 Web composer dock 中显示 Round 进度并编辑上限。
- `@alisheramantay/dsh-client-chat-extended` — 替换 Chat Client 插件；当前台工具已报告具体工作时，隐藏通用模型活动状态。
- `@alisheramantay/dsh-tool-session-message` — 列出、创建、重命名 Session，并代表用户向另一个 Session 发送提示；以私有本地 bundle 形式提供。
- `@alisheramantay/dsh-custom-bundle` — 为自定义发行版安装 Host 与 Web row。

## 开发

运行 `pnpm install`，再运行 `pnpm run check`。开发期间，根 override 会从相邻的 `../deepseek-harness` checkout 链接这些插件用到的全部 Harness 包，该 checkout 带有尚未发布的扩展 API；全部链接可让构建中每个 Harness 类型只有一份。该 checkout 必须已有构建好的 `lib/` 输出（在其中运行 `pnpm run build`）。发布包 manifest 只包含 DSH 0.2.1 版本线的 semver 范围。请先发布匹配的 Harness 版本，再发布观察式记忆包。

`pnpm run check` 会构建所有包，通过 profile 实际使用的模块图导入每个已构建入口（`build/load-check.ts`，其中 `@deepseek-ai/*` 解析到 Harness 的 `lib/` 产物，而不是 vitest 的源码 alias），然后运行测试，最后运行 `pack:check` 与 `publint`。两个测试套件守护与 checkout 的关系：`tests/compatibility.spec.ts` 拒绝 Harness 未提供的依赖、未指明 checkout 版本的版本范围，以及命名或遗漏包名的 bundle roster；`packages/client-chat-extended/tests/vendor-drift.spec.ts` 拒绝过期的 vendored Chat 副本。

自定义 bundle 会安装 profile 全局 row，并覆盖内置的 preset 声明。标准、PTC 与 Cordis 模式会自动获得观察式记忆和扩展 goal 工具；Minimal 保持不变。两个 bundle 的 `presets/*.patch.yml` 文件由 `node build/preset-overrides.ts` 从 Harness checkout 的内置 preset 生成；bundle 测试会拒绝过期文件。Web Chat 包从该 checkout 复制 Chat client 并只做一处已记录的改动；Harness 更新后用 `node build/vendor-ui-chat.ts` 重新生成。`pnpm run presets` 与 `pnpm run vendor` 分别执行两个生成脚本。
