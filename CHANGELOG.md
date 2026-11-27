# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.14.5] - 2026-11-27

### Documentation

- 记录 Trae 企业端点、`DeepSeek-V4.1-Flash-1017__max` 的 A/B/C 图片探测观测：三组 HTTP 200；最后一次回读仅 user 图片正对照的 reasoning 描述了目标图形，tool 图片组没有相应描述。
- 将 wire 层“上游只接受 user 图片”的绝对断言改为有日期、模型范围与证据边界的兼容策略说明。HTTP 接受不等于视觉理解，单次阴性结果不能定位丢图层级或覆盖所有模型。
- 新增 `docs/tool-image-observation-2026-11-27.md`，说明提示与刺激不匹配、可见答案为空等实验局限，以及未来重新探测的验收要求。三份本地探索脚本尚未整理为可靠工具，不纳入提交或安装包；本版不增加真实探测调用。
- README 更新安装版本与图片限制说明；安装包包含本更新日志及观测记录。

### Tests

- 加强现有消息翻译回归：同时提供 user 与 tool 的已解析图片映射，断言 tool 图片仍按现有策略省略，正文、占位文本及工具调用配对保留。该测试验证插件策略，不证明上游视觉能力。

### Runtime behaviour

- 不改变 tool 图片发送策略、号池或重试行为；继续包含 v0.14.4 的用户图片 target 字段修复。

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

- `tool` 轮次结果中的图片仍会被本插件替换为 `[image omitted]`；OCR 结果里的文字仍可传递。v0.14.4 未改变该行为。原“上游只接受 user 图片”的绝对描述已在 v0.14.5 校正为有范围与局限的观测，不能视为通用协议约束。

## [0.14.3] - 2026-11-25

### Added

- 账号配对警告：比对 PAT 所属账号与控制台邮箱，不一致时警告。
- 命名空间三处一致性自检 + CI 断言（bundle 入口 id、settings namespace、client）。
- 多席位额度并发查询。

## [0.14.2] 及更早

见 git 历史：`git log --oneline`。
