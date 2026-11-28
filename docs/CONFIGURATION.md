# 配置与号池模式

本文面向需要脚本化配置、排查状态接口或了解换号细节的用户。日常使用请先看 [README](../README.md)。

## 配置示例

配置只在需要脚本化时手写；日常在 **设置 → Trae 号池** 页面操作。profile 的 `cordis.patch.yml`：

```yaml
- id: trae-pat-pool
  name: dsh-trae-pat-pool
  config:
    seats:
      - name: 席位 A
        pat: TRAE_PAT
        email: TRAE_CONSOLE_EMAIL          # 企业版席位才需要
        password: TRAE_CONSOLE_PASSWORD
      - name: 席位 B
        pat: TRAE_PAT_2
        email: TRAE_CONSOLE_EMAIL_2
        password: TRAE_CONSOLE_PASSWORD_2
    patPoolMode: failover                  # 或 rotate
    patPoolMaxAttempts: 3
```

`seats` 留空时沿用 `patEnv` 指向的单 PAT，旧配置升级后行为不变。

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `patEnv` | `TRAE_PAT` | 单席位回退用的 PAT 引用名 |
| `seats` | `[]` | 号池席位列表，值是凭据库引用名 |
| `patPoolMode` | `failover` | `failover` / `rotate` |
| `patPoolMaxAttempts` | `3` | 一个请求最多试几个席位 |
| `host` | `https://api.enterprise.trae.cn` | Trae 接口地址 |
| `catalogSource` | `auto` | 模型目录来源：`auto` / `upstream` / `cache` / `builtin` |
| `catalogFunctions` | `['chat']` | 问上游目录的通道 |
| `consoleHost` | `https://console.enterprise.trae.cn` | 企业控制台地址 |
| `contextBudgetTokens` | `0` | 本地上下文预算上限，只改压缩时机 |
| `suggestions` | `true` | 回答后是否给下一步卡片 |
| `suggestSubagent` | `true` | 卡片任务默认交给子会话 |

## 故障转移与轮转

- **故障转移（默认）**：优先使用前排可用账号，被拒绝后才换下一个。判定只看账号自身的问题：`QUOTA` / `RATE_LIMIT` / `AUTH` / `SERVER` 会换；`MODEL_NOT_FOUND`（4023）与 `CONTEXT_WINDOW_EXCEEDED` 不换，因为那是请求问题。
- **逐请求轮转**：每次请求换下一个席位，把额度与限流摊开。

401/403 时先用同一 PAT 重换 JWT，仍失败才换席位。被拒绝的 PAT（`AUTH`）保持出局，直到编辑该 PAT；其他失败按上游重置时间冷却，未提供时默认 30 分钟。

## 状态与验证接口

- `GET /api/dsh-trae-pat-pool/pool`：只读号池快照，不触发 PAT 兑换、不推进轮转、不发送聊天。
- `POST /api/dsh-trae-pat-pool/pool/validate`：请求体 `{ "seatId": "凭据引用名" }`，验证指定账号；不接收令牌内容。
- `GET /api/dsh-trae-pat-pool/session?session=<id>&view=usage`：只读本会话最近请求快照，不触发鉴权或后台身份查询。

接口不返回 PAT、JWT、控制台密码或上游原始错误正文。

## 额度接口

- `GET /api/dsh-trae-pat-pool/quota`：全部账号额度。
- `?seat=<seatId>`：指定账号额度。
- `?scope=primary`：旧主账号接口，保留兼容。
- `?refresh=1`：跳过本机缓存。

额度沿用缓存，不随运行状态轮询强制刷新。账号换了 PAT 后，额度缓存按不透明的凭据版本隔离，旧额度不会挂到新账号或历史请求上。

## 企业版额度口径

企业版额度认控制台账号，不认 PAT。两个席位共用同一控制台账号会读到同一份数字；插件会比对 PAT 所属账号与控制台邮箱，不一致时提示，但不拦截（子账号或代管场景可能合法不同）。SSO-only 租户无法使用控制台额度路径；个人版额度走 IDE 接口，无需控制台账号。
