# @alisheramantay/dsh-observational-memory-bundle

This bundle installs [`@alisheramantay/dsh-observational-memory`](../observational-memory) as the default compaction engine for DeepSeek Harness.

The engine is a port of [pi-observational-memory](https://github.com/elpapi42/pi-observational-memory).

> [!IMPORTANT]
> Install this focused bundle **instead of**, not alongside, `@alisheramantay/dsh-custom-bundle`. Both replace the profile's preset-roster provider and are intentionally alternative distributions.

It replaces Basic Compaction in every shipped mode that already enables compaction: Standard, PTC, and Cordis. Minimal intentionally remains unchanged because it does not enable context compaction.

## Install

Install the bundle into the DSH profile you use:

```sh
dsh plugin --profile <profile-name> add @alisheramantay/dsh-observational-memory-bundle
```

Inspect the composed configuration and restart the profile:

```sh
dsh --profile <profile-name> --dump-config
dsh --profile <profile-name>
```

Adding, updating, or removing this bundle takes effect after restarting the profile. Sessions opened afterward—including reopened persisted sessions—resolve their saved preset through the current roster, so Standard, PTC, and Cordis use observational memory automatically.

## Remove

```sh
dsh plugin --profile <profile-name> remove @alisheramantay/dsh-observational-memory-bundle
```
