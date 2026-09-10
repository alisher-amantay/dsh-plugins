# Alisher Amantay DSH plugins

English | [中文](README.zh.md)

This workspace contains independently publishable Cordis plugins and one opinionated DeepSeek Harness bundle. Product behavior stays in `@alisheramantay/*` packages; the upstream `@deepseek-ai/*` packages expose only reusable extension APIs.

## Packages

- `@alisheramantay/dsh-observational-memory` — session-local observations, reflections, evidence recall, and deterministic compaction.
- `@alisheramantay/dsh-tool-pdf` — bounded PDF page rasterization through a dedicated `read_pdf` tool.
- `@alisheramantay/dsh-tool-goal-extended` — extends the model-facing goal tools with suspension until an owned background job settles.
- `@alisheramantay/dsh-goal-round-driver-delayed` — replacement goal continuation driver with a cancellable cadence delay.
- `@alisheramantay/dsh-client-goal-extended` — replaces the Goal Client plugin with round progress and a cap editor in the Web composer dock.
- `@alisheramantay/dsh-client-chat-extended` — replaces the Chat Client plugin and suppresses generic model activity while a foreground tool already reports its work.
- `@alisheramantay/dsh-custom-bundle` — installs the host and Web rows for the custom distribution.

## Development

Run `pnpm install`, then `pnpm run check`. During development, the root override links the three unreleased extension APIs from a sibling `../deepseek-harness` checkout; published package manifests contain only semver peer ranges. Publish the matching Harness release before publishing observational memory.

The custom bundle installs profile-global rows and a replacement preset roster. Standard, PTC, and Cordis modes receive observational memory and extended goal tools automatically; Minimal remains unchanged.
