# 开发说明

面向维护者与贡献者。普通用户请先看 [README](../README.md)。

## 常用命令

```sh
pnpm install
pnpm typecheck
pnpm run build      # 产出 lib/index.js + lib/client.js
pnpm run build:test # 产出测试入口 lib/testing.mjs
pnpm test           # 单测；无 python3 的环境中 ZIP 校验用例会跳过
```

构建产物必须随源码提交；CI 会检查 bundle id、settings namespace 和浏览器端 namespace 一致。

## 源码结构

- `src/index.ts`：宿主注册、配置、连接路由与凭据事件。
- `src/adapter.ts`：请求、故障转移、逐请求归属与流生命周期。
- `src/trae/pool.ts`：号池成员、冷却和失败记录。
- `src/trae/pool-view.ts`：只读状态投影、逐账号验证证据与安全身份。
- `src/trae/request-usage.ts`：按会话与请求记录实际账号，处理并发与迟到完成。
- `src/trae/quota.ts`：逐席位额度与按凭据版本隔离的缓存。
- `client/client.js`：Trae 设置页、号池概览、账号卡片和对话栏徽标。

## 测试重点

- 凭据写入是显式操作；PAT 保存、验证成功、验证失败和网络暂不可用分别反馈。
- 旧写入、旧验证和页面卸载后的结果不能覆盖新输入或新凭据状态。
- 并发会话分别记录实际账号；旧请求失败不能污染替换后的 PAT。
- 同一 seatId 换 PAT 后，历史请求保持当时身份，额度按不透明凭据版本隔离。
- 状态读取不推进轮转、不触发聊天；验证不发聊天、不消耗生成额度。
- 旧单 PAT、故障转移、轮转和既有分享/目录/图片兼容策略保持通过。

本机受限沙箱下的测试命令与覆盖缺口见 [验证记录](superpowers/specs/2026-11-28-pat-pool-ui-verification.md)。该记录说明平台限制，不代表普通 CI 需要同样处理。
