# Alisher Amantay DSH plugins

English | [中文](README.zh.md)

`@alisher-amantay/dsh-observational-memory` is a port of [pi-observational-memory](https://github.com/elpapi42/pi-observational-memory).

This workspace contains independently publishable Cordis plugins and DeepSeek Harness bundles. Product behavior stays in `@alisheramantay/*` packages; the upstream `@deepseek-ai/*` packages expose only reusable extension APIs.

## Packages

- `@alisher-amantay/dsh-observational-memory` — session-local observations, reflections, evidence recall, and deterministic compaction.
- `@alisher-amantay/dsh-observational-memory-bundle` — installs observational memory as the default engine in every mode that already enables compaction.
- `@alisheramantay/dsh-tool-pdf` — bounded PDF page rasterization through a dedicated `read_pdf` tool.
- `@alisheramantay/dsh-tool-goal-extended` — extends the model-facing goal tools with suspension until an owned background job settles.
- `@alisheramantay/dsh-goal-round-driver-delayed` — replacement goal continuation driver with a cancellable cadence delay.
- `@alisheramantay/dsh-client-goal-extended` — replaces the Goal Client plugin with round progress and a cap editor in the Web composer dock.
- `@alisheramantay/dsh-client-chat-extended` — replaces the Chat Client plugin and suppresses generic model activity while a foreground tool already reports its work.
- `@alisheramantay/dsh-tool-session-message` — Session listing, creation and renaming plus prompts relayed to another Session, as a private local bundle.
- `@alisheramantay/dsh-custom-bundle` — installs the host and Web rows for the custom distribution.

## Development

Run `pnpm install`, then `pnpm run check`. During development, the root overrides link every Harness package these plugins use from a sibling `../deepseek-harness` checkout, which carries unreleased extension APIs; linking all of them keeps one copy of each Harness type in the build. The checkout must have built `lib/` output (`pnpm run build` there). Published package manifests contain only semver ranges for the DSH 0.2.1 release line. Publish the matching Harness release before publishing observational memory.

`pnpm run check` builds every package, imports each built entry through the same module graph a profile uses (`build/load-check.ts`, which resolves `@deepseek-ai/*` to the Harness `lib/` output rather than vitest source aliases), runs the tests, and then runs `pack:check` and `publint`. Two suites guard the checkout relationship: `tests/compatibility.spec.ts` rejects a dependency the Harness does not ship, a pin that does not name the checked-out version, and a bundle roster that names or forgets a package, while `packages/client-chat-extended/tests/vendor-drift.spec.ts` rejects a stale vendored Chat copy.

The custom bundle installs profile-global rows and overrides the shipped preset declarations. Standard, PTC, and Cordis modes receive observational memory and extended goal tools automatically; Minimal remains unchanged. Both bundles' `presets/*.patch.yml` files are generated from the Harness checkout's shipped presets by `node build/preset-overrides.ts`; the bundle tests reject stale files. The Web Chat package vendors that checkout's Chat client with one documented edit; regenerate it with `node build/vendor-ui-chat.ts` after a Harness update. `pnpm run presets` and `pnpm run vendor` run each generator.
