# @alisheramantay/dsh-memorix-bundle

[English](README.md) | 中文

这是用于 Memorix 1.8.7 Lite 模式的可安装 DSH profile bundle。请先单独安装 `memorix` 可执行文件，再把本 bundle 加入 profile：

```sh
dsh plugin --profile <name> add @alisheramantay/dsh-memorix-bundle
```

该 bundle 通过 DSH MCP client 启动 `memorix serve --mode lite`，并使用 profile 进程的工作目录。
