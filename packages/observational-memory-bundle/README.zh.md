# @alisheramantay/dsh-observational-memory-bundle

该 bundle 将 [`@alisheramantay/dsh-observational-memory`](../observational-memory) 安装为 DeepSeek Harness 的默认 compaction engine。

该引擎是 [pi-observational-memory](https://github.com/elpapi42/pi-observational-memory) 的移植版本。

它会在原本已启用 compaction 的所有内置模式（标准、PTC 与 Cordis）中替换 Basic Compaction。Minimal 原本不启用上下文压缩，因此保持不变。

## 安装

将 bundle 安装到所使用的 DSH profile：

```sh
dsh plugin --profile <profile-name> add @alisheramantay/dsh-observational-memory-bundle
```

检查组合后的配置并重启 profile：

```sh
dsh --profile <profile-name> --dump-config
dsh --profile <profile-name>
```

添加、更新或移除此 bundle 后，需要重启 profile 才会生效。此后打开的会话（包括重新打开的持久化会话）会通过当前 roster 解析已保存的 preset；标准、PTC 与 Cordis 因而会自动使用观察式记忆。

## 移除

```sh
dsh plugin --profile <profile-name> remove @alisheramantay/dsh-observational-memory-bundle
```
