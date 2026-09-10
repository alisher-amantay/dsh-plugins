# @alisheramantay/dsh-custom-bundle

English | [中文](README.zh.md)

The opinionated profile layer for this plugin set. It replaces the Host goal-round driver, adds `read_pdf`, and replaces the Web Chat and Goal Client plugins. Install it after the normal DSH Web bundle:

```sh
dsh plugin --profile <name> add @alisheramantay/dsh-custom-bundle
```

The bundle also ships `preset/observational`. Copy that directory to the writable agent-preset root reported by DSH, then mount-validate it before starting a session. The preset replaces the stock goal tool and compaction provider with the `@alisheramantay` packages while preserving the required isolated compaction realm.

Memorix remains a separate opt-in bundle because it requires an external executable.
