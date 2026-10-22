# @alisher-amantay/dsh-observational-memory-bundle

This bundle installs [`@alisher-amantay/dsh-observational-memory`](https://www.npmjs.com/package/@alisher-amantay/dsh-observational-memory) as the default compaction engine for DeepSeek Harness.

The engine is a port of [pi-observational-memory](https://github.com/elpapi42/pi-observational-memory).

> [!IMPORTANT]
> Install this focused bundle **instead of**, not alongside, `@alisheramantay/dsh-custom-bundle`. Both override the same shipped preset declarations, and the bundle installed last replaces the other's declarations wholesale.

It replaces Basic Compaction in every shipped mode that already enables compaction: Standard, PTC, and Cordis. Minimal intentionally remains unchanged because it does not enable context compaction.

Requires DSH 0.2.1 (`>=0.2.1-alpha.2 <0.2.2`). Each override restates the complete `preset-<id>` declaration of `@deepseek-ai/dsh-web-app`, because an overridden declaration's plugin list replaces the shipped one, so a future preset change requires regenerating the declarations with `node build/preset-overrides.ts` and a reviewed bundle update.

## Install

Install the bundle into the DSH profile you use:

```sh
dsh plugin --profile <profile-name> add @alisher-amantay/dsh-observational-memory-bundle
```

Inspect the composed configuration and restart the profile:

```sh
dsh --profile <profile-name> --dump-config
dsh --profile <profile-name>
```

Adding, updating, or removing this bundle takes effect after restarting the profile. Sessions opened afterward—including reopened persisted sessions—resolve their saved preset through the current declarations, so Standard, PTC, and Cordis use observational memory automatically.

## Remove

```sh
dsh plugin --profile <profile-name> remove @alisher-amantay/dsh-observational-memory-bundle
```
