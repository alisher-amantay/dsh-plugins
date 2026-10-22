# @alisheramantay/dsh-custom-bundle

English | [中文](README.zh.md)

The opinionated profile layer for this plugin set. It replaces the Host goal-round driver, adds `read_pdf`, and replaces the Web Chat and Goal Client plugins. Install it after the normal DSH Web bundle:

```sh
dsh plugin --profile <name> add @alisheramantay/dsh-custom-bundle
```

The bundle keeps the shipped `standard`, `ptc`, `cordis`, and `minimal` preset IDs, so existing Sessions resume under their original IDs. It overrides the `standard`, `ptc`, and `cordis` declarations of `@deepseek-ai/dsh-web-app` so they mount observational memory in place of Basic Compaction and the extended goal tool in place of the stock one; `minimal` stays unchanged. New Sessions default to `standard`.

`Weak-Strong Review` adds a fifth mode: an orchestrator preset, derived from `standard`, that loops a weaker `implement` delegation against a stronger `review` delegation (numeric verdict + redirect notes) under a persistent goal. The two models are pinned as the `tool-implement` and `tool-review` `agentOptions` in `build/preset-overrides.ts` — replace their `provider`, `model`, and `reasoningEffort` values with your exact weak and strong routes before first use.

Requires DSH 0.2.1 (`>=0.2.1-alpha.2 <0.2.2`). The files in `presets/` are generated from that release's shipped presets; after a Harness update, run `node build/preset-overrides.ts` and review the diff.
