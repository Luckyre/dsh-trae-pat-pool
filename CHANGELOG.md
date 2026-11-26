# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.14.4] - 2026-11-26

### Fixed

- **多模态图片从未真正发送给模型**（严重）：`prepareImages()` 传给
  `attachments.readImageRequest(ref, target)` 的 `target` 字段名不符合
  `@deepseek-ai/dsh-attachment-local` 的 `validateTarget()` 契约——
  用了 `maxBytes`（应为 `maxImageBytes`）且完全缺少 `imageTargetBytes`。
  由于 `readRequestImageFile()` 第一步就调用 `validateTarget()`，
  每次都会抛 `INVALID_ATTACHMENT_REF`；该异常又被 `prepareImages()` 的
  `catch` 吞掉（只打一条不落盘的 `logger.warn`），导致图片被静默降级为
  `[image omitted]` 占位文本。

  影响面：所有声明为多模态的模型（15/20 条路由）在**任何**含图请求中
  都看不到图片，与具体模型无关。

  修复：

  ```diff
  - const target = { width: 1024, height: 1024, maxBytes: 2 * 1024 * 1024 }
  + const target: ImageRequestTarget = {
  +   width: 1024,
  +   height: 1024,
  +   maxImageBytes: 2 * 1024 * 1024,
  +   imageTargetBytes: 2 * 1024 * 1024,
  + }
  ```

  同时新增导出类型 `ImageRequestTarget`，把契约写在类型里而不是注释里。

### Added

- 回归测试 `adapter: the image request target uses the attachment store's field names`：
  用一个模拟真实 `validateTarget()` 行为的 attachment store 驱动
  `prepareImages()`，断言四个字段齐全、不允许出现 `maxBytes`、
  `imageTargetBytes <= maxImageBytes`，并验证解析出的字节被内联成 data URL。
  该测试在修复前会失败（`maxImageBytes must be a positive integer`），
  修复后通过。

### Known limitations

- 上游只接受 user 轮次的图片，`tool` 轮次（`read_image`、截图、OCR 结果）
  的图片仍会被替换为 `[image omitted]`。本次不改变该行为。

## [0.14.3] - 2026-11-25

### Added

- 账号配对警告：比对 PAT 所属账号与控制台邮箱，不一致时警告。
- 命名空间三处一致性自检 + CI 断言（bundle 入口 id、settings namespace、client）。
- 多席位额度并发查询。

## [0.14.2] 及更早

见 git 历史：`git log --oneline`。
