# @alisheramantay/dsh-tool-pdf

English | [中文](README.zh.md)

Adds a dedicated `read_pdf` tool without replacing the stock filesystem tools. The tool resolves files through `ctx.fs`, verifies a vision-capable model route, rasterizes selected pages, and stores the resulting PNGs through `ctx.attachments`.

Configuration bounds source bytes, pages per call, render scale, and pixels per page. Explicit ranges above the page limit fail; an omitted selection renders the first bounded window and reports truncation. PDF parsing and native canvas dependencies stay outside the default DSH installation.
