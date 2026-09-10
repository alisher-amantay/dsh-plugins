# @alisheramantay/dsh-tool-pdf

[English](README.md) | 中文

增加专用 `read_pdf` 工具，而不替换 stock 文件系统工具。该工具通过 `ctx.fs` 解析文件、验证支持视觉的模型 route、栅格化所选页面，并通过 `ctx.attachments` 存储生成的 PNG。

配置会限制源文件字节数、每次调用的页面数、渲染缩放与每页像素数。超过页面上限的显式范围会失败；省略选择时，会渲染第一个有界窗口并报告截断。PDF 解析与原生 canvas 依赖保留在默认 DSH 安装之外。
