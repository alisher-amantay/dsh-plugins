# @alisheramantay/dsh-observational-memory

English | [中文](README.zh.md)

Session-local observational memory for DeepSeek Harness. The Cordis service extends the basic compaction engine, records source-backed observations and reflections, supplies `/memory-status` and `/memory-view`, and registers `observational_memory_recall` for exact evidence paging.

Mount it in an agent preset inside the same isolated `compaction` and `toolResultPruner` realm as the compact command and result pruner. Do not mount it beside another compaction provider.

The plugin writes its ledger records with `ignorable: true`. A Harness installation that does not load this package can reconstruct the ordinary conversation while omitting the optional memory projection. Deterministic compacted summaries remain ordinary first-party compaction events.

See `@alisheramantay/dsh-custom-bundle/preset/observational` for a complete preset template.
