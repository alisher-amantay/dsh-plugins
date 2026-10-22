# @alisher-amantay/dsh-observational-memory-bundle

该 bundle 将 [`@alisher-amantay/dsh-observational-memory`](https://www.npmjs.com/package/@alisher-amantay/dsh-observational-memory) 安装为 DeepSeek Harness 的默认 compaction engine。

该引擎是 [pi-observational-memory](https://github.com/elpapi42/pi-observational-memory) 的移植版本。

> [!IMPORTANT]
> 请安装此精简 bundle **而不是**同时安装 `@alisheramantay/dsh-custom-bundle`。两者覆盖同一批内置 preset 声明，后安装的 bundle 会整体替换另一个的声明。

它会在原本已启用 compaction 的所有内置模式（标准、PTC 与 Cordis）中替换 Basic Compaction。Minimal 原本不启用上下文压缩，因此保持不变。

需要 DSH 0.2.1（`>=0.2.1-alpha.2 <0.2.2`）。每个覆盖都会完整重述 `@deepseek-ai/dsh-web-app` 的 `preset-<id>` 声明，因为被覆盖声明的插件列表会替换内置列表；因此未来的 preset 变化需要用 `node build/preset-overrides.ts` 重新生成声明，并经过 bundle 更新审核。

## 安装

将 bundle 安装到所使用的 DSH profile：

```sh
dsh plugin --profile <profile-name> add @alisher-amantay/dsh-observational-memory-bundle
```

检查组合后的配置并重启 profile：

```sh
dsh --profile <profile-name> --dump-config
dsh --profile <profile-name>
```

添加、更新或移除此 bundle 后，需要重启 profile 才会生效。此后打开的会话（包括重新打开的持久化会话）会通过当前声明解析已保存的 preset；标准、PTC 与 Cordis 因而会自动使用观察式记忆。

## 移除

```sh
dsh plugin --profile <profile-name> remove @alisher-amantay/dsh-observational-memory-bundle
```
