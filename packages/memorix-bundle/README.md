# @alisheramantay/dsh-memorix-bundle

English | [中文](README.zh.md)

An installable DSH profile bundle for Memorix 1.8.7 Lite mode. Install the `memorix` executable separately, then add this bundle to a profile:

```sh
dsh plugin --profile <name> add @alisheramantay/dsh-memorix-bundle
```

The bundle starts `memorix serve --mode lite` through the DSH MCP client and uses the profile process working directory.
