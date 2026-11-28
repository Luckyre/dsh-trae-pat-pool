# dsh-trae-pat-pool

> 在 DeepSeek Harness（dsh）里直接调用 **Trae 企业版模型**，支持**多 PAT 席位池**（故障转移 / 轮转）与**逐席位额度显示**。

一个 dsh 插件。填一个 PAT 即可用；填多个 PAT 就变成一个号池：主席位被限流或额度用完时自动换下一个，也能每个请求轮转一个席位。不需要 `trae2api` 进程、不需要 Python、不需要 `traecli`。

> 当前版本 **v0.15.0**：包含 PAT 号池方案 A。改造与验证记录见 CHANGELOG 和 `docs/superpowers/specs/`。欢迎 issue / PR。

---

## 特性

- **PAT 直连**：PAT 在 Trae 企业控制台生成，插件用它兑换 Cloud-IDE JWT，直连 `/api/ide/v2/llm_raw_chat`；流式正文、流式 thinking、function calling、token 用量都支持。
- **多席位号池**：每个席位一个 PAT，页面上增删/排序。两种模式：
  - `failover`（默认）——主号一直用，被拒绝（额度用完 / 限流 / 令牌失效 / 服务端错误）才换下一个，并给坏席位记冷却；
  - `rotate`——每个请求换下一个席位，把额度和限流摊开。
- **逐席位额度**：企业版席位填控制台账号后，每个席位各读各的额度；输入框旁显示本会话实际使用的账号，并定向读取这个账号的额度，不为一个徽标查询整个号池。
- **号池概览与账号卡片**：总数、已配置 PAT、已验证可用、冷却/异常、待配置/待验证分开显示；卡片默认折叠，按优先级排列，支持筛选需关注账号。
- **明确保存与验证**：PAT 与控制台凭据显式保存，保存进度、验证结果和失败重试分别反馈。已保存不等于已验证；检测账号不会发起聊天请求。
- **模型目录问出来而非写死**：启动、换 PAT、`?refresh` 时向 Trae 问一次真实目录（含上下文窗口、思考档位、能否吃图），断网时降级到 traecli 缓存 / 内置表。模型下线不会再出现"选得到但一发就 4023"。
- **独立配置页**：设置面板左侧的 **Trae** 页（和 WorkBuddy 同级）集中放席位、凭据、号池、额度；「设置 → 模型」里的 Trae 行只留状态摘要。
- **账号配对提示**：席位会比对 PAT 所属账号与控制台邮箱，不一致时给出警告，避免"多席位读同一份额度"却无感知。
- 工具调用历史修复、`<invoke>` 文本工具调用回收、重复塌缩截断、空回合重试、错误码翻译等兜底。

## 安全模型

- **密钥只进 dsh 凭据库**（`~/.dsh/.credentials.yaml`），配置文件里只有引用名。
- `~/.dsh/.trae-pat-pool.json` 只记席位冷却结论与时间，**不含任何凭据**。
- 席位失败是按席位隔离的：一个坏 PAT 不会遮住其它席位的额度，也不会让整轮请求失败。

## 安装

1. 先启动一次 DeepSeek Harness Desktop（初始化 `desktop` profile），然后**完全退出**。
2. 安装插件（二选一）：

   ```sh
   # 从源码目录
   dsh plugin --profile desktop add /绝对路径/dsh-trae-pat-pool
   # 或从 Release 里下载的 tgz
   dsh plugin --profile desktop add ./dsh-trae-pat-pool-0.15.0.tgz
   ```

   也可以在侧栏 **插件 → 添加插件** 里填目录绝对路径 / tgz 路径。

3. 重新打开 Desktop → 设置面板左侧 **Trae** 页 → 在「席位」里填 PAT，保存。

然后在对话框右下角模型菜单里选 **Trae** 分组的模型，思考档位在同一菜单切换。选中 Trae 模型时模型选择器旁会显示剩余额度徽标。

卸载：`dsh plugin --profile desktop remove dsh-trae-pat-pool`。

## PAT 从哪来

在 Trae 企业控制台生成个人访问令牌（Personal Access Token）。填到 Trae 页的席位里后只保存在 dsh 凭据库（默认引用名 `TRAE_PAT`），**不会写进任何配置文件**，保存后即时生效。

> 若手上已有 Cloud-IDE JWT（例如 `~/.trae/cli/auth.json` 的 `access_token`），也可以直接填进 PAT 框：插件识别为 JWT 后原样使用，过期后需要自己更新。

## 号池怎么用

Trae 页的账号卡片列表：

- **添加账号** → 填写 PAT，点击**保存并验证**；企业版账号可另填控制台邮箱与密码查询额度。
- 每个账号可改名、上移/下移（顺序就是优先级）、移除；点击管理入口展开凭据编辑。
- PAT 与控制台凭据先在本地编辑，明确保存后才写入凭据库。保存失败保留输入并可重试；保存成功但验证失败时无需重新粘贴令牌。普通名称仍可停顿保存。
- 页面分别展示“已保存”和“已验证”。顶部“已验证可用”只统计当前凭据版本有有效服务器鉴权证据、且不在冷却/拒绝状态的账号；它不保证所有模型权限或剩余额度。各项统计属于不同维度，不能相加作为总数。
- 冷却卡片展示原因及预计恢复时间；到期表示重新成为候选，验证证据仍需有效。刷新状态只读取快照，“重新验证”才主动检测该账号；检测不推进轮转游标，也不发送聊天。
- 设置页显示明确标注会话的**最近请求使用**；对话输入栏显示**本会话使用中 / 上次使用**账号。自动换号跟随真实请求更新，多个会话各自记录。
- 「切换方式」选 `故障转移` 或 `轮转`；「一个请求最多试几个席位」默认 3。

故障转移的换号判定只看"这个席位的事"：`QUOTA` / `RATE_LIMIT` / `AUTH` / `SERVER` 会换，`MODEL_NOT_FOUND`(4023) 与 `CONTEXT_WINDOW_EXCEEDED` 不换（那是请求的问题，换席位只会把同一个错误再烧一遍）。401/403 先拿同一个 PAT 重换一次 JWT（可能只是过期），仍失败才换席位。被拒的 PAT（`AUTH`）永久出局，直到你改了那个 PAT；其它失败冷却按上游说的重置时间算，没说就 30 分钟。

## 配置（可选）

配置只在需要脚本化时才手写；日常都用页面。profile 的 `cordis.patch.yml`：

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

`seats` 留空 = 沿用 `patEnv` 指的那一个 PAT（旧单席位行为），升级插件不改变任何行为。

<details>
<summary>全部配置项</summary>

| 字段 | 默认 | 说明 |
|---|---|---|
| `patEnv` | `TRAE_PAT` | 单席位回退用的 PAT 引用名 |
| `seats` | `[]` | 号池席位列表（凭据库引用名） |
| `patPoolMode` | `failover` | `failover` / `rotate` |
| `patPoolMaxAttempts` | `3` | 一个请求最多试几个席位 |
| `host` | `https://api.enterprise.trae.cn` | Trae 接口地址 |
| `catalogSource` | `auto` | 模型目录来源：`auto` / `upstream` / `cache` / `builtin` |
| `catalogFunctions` | `['chat']` | 问上游目录的通道 |
| `consoleHost` | `https://console.enterprise.trae.cn` | 企业控制台地址 |
| `contextBudgetTokens` | `0` | 本地上下文预算上限（只改压缩时机） |
| `suggestions` | `true` | 回答后是否给下一步卡片 |
| `suggestSubagent` | `true` | 卡片任务默认交给子会话 |

</details>

## 额度显示

- **Trae 页**：每个账号显示额度摘要及控制台来源，和 PAT 验证状态分开。
- **模型选择器旁的徽标**：按本会话实际使用的账号定向读取额度；尚未发过请求时不推断当前账号。额度未知或查询失败时仍保留账号标识，换号后不继续展示旧账号的数字。同一席位更换 PAT 后，历史请求仍显示当时的账号；新凭据的额度不会附到旧请求上。
- 额度接口：`GET /api/dsh-trae-pat-pool/quota`（全部账号）、`?seat=<seatId>`（指定账号）、`?scope=primary`（保留旧主账号接口）、`?refresh=1`（跳过缓存）。额度沿用缓存，不随运行状态的频繁轮询强制刷新。
- 账号状态：`GET /api/dsh-trae-pat-pool/pool` 是只读状态快照；`POST /api/dsh-trae-pat-pool/pool/validate` 以 `{ "seatId": "凭据引用名" }` 验证指定账号。接口不接收或返回 PAT 明文。
- 会话归属：`GET /api/dsh-trae-pat-pool/session?session=<id>&view=usage` 只读本会话记录，不触发鉴权或后台身份查询。

> **企业版额度只认控制台账号，不认 PAT**：两个席位共用同一控制台账号会读到同一份数字。插件会拿 JWT 里的账号与配置的控制台邮箱比对，**不一致时在席位行给出"账号不匹配"警告**（两者确实可以合法地不同，例如子账号或代管，所以只是警告不是拦截）。每个席位仍建议配独立的控制台账号；SSO-only 租户没有这条路径。个人版（ToC）额度走 IDE 接口，无需控制台账号。

## 开发

```sh
pnpm install
pnpm typecheck
pnpm run build     # 产出 lib/index.js + lib/client.js
pnpm run build:test # 产出测试入口 lib/testing.mjs
pnpm test          # 单测（部分环境会因禁止 spawn python3 而失败一项 zip 校验）
```

源码：`src/index.ts`（宿主注册与配置）、`src/adapter.ts`（请求与故障转移）、`src/trae/pool.ts`（号池）、`src/trae/quota.ts`（逐席位额度）、`client/client.js`（浏览器端 Trae 页与徽标）。

## Roadmap（v0.15.0 之后的想法）

已完成（v0.15.0）：
- 方案 A：号池概览、折叠账号卡片、显式凭据保存与逐账号验证。
- 冷却原因与恢复时间展示、按会话记录实际请求账号、自动换号提示和定向额度读取。

已完成（v0.14.5）：
- **记录 tool 图片探测与边界**：指定模型的 A/B/C 请求均 HTTP 200，仅 user 图片正对照的 reasoning 描述了目标图形；这不足以证明所有模型都忽略 tool 图片。详见[观测记录](docs/tool-image-observation-2026-11-27.md)。保留现有 tool 图片省略策略。
- 更新代码注释、离线策略回归与安装包内的 CHANGELOG。没有新增图片转发行为。

已完成（v0.14.4）：
- **修复多模态图片发送**：`readImageRequest` 的 target 用了错误的字段名（`maxBytes` 而非 `maxImageBytes`，且缺 `imageTargetBytes`），DSH 的 `validateTarget` 直接抛错，异常被 `catch` 吞掉后图片静默降级为 `[image omitted]` —— 此前**所有**多模态模型其实都没真正收到过图。现已按契约修正并加回归测试。

已完成（v0.14.3）：
- 账号配对警告（PAT 账号 ↔ 控制台邮箱）
- 命名空间三处一致性自检 + CI 断言
- 多席位额度并发查询

待做：
- **tool 轮次图片**：当前 `read_image` / 截图工具结果中的图片被替换为 `[image omitted]`（OCR 返回的文字不受影响）。本次指定模型未获得 tool 图片被使用的正向证据；后续若尝试转发或改挂 user 消息，需独立验证视觉理解与工具配对，不能只凭 HTTP 200 放开。
- 手动清除冷却操作
- 按席位分配模型白名单
- 配置迁移提示（旧 `trae2api` 行残留）
- 诊断信息一键复制

## 已知限制

- **当前仅转发 user 消息中的图片**：用户直接贴图可走视觉链路；工具结果中的图片仍被本插件省略。这是现有兼容策略，不是所有上游模型永久不支持 tool 图片的结论。OCR 已识别出的文字仍可传递。
- **单图长边上限 1024px、单图 2MB**：超出会由 DSH 重新编码，超大图可能被压缩到细节不可辨。
- **探测边界**：本次结果只覆盖 2026-11-27 的 Trae 企业端点与 `DeepSeek-V4.1-Flash-1017__max`；原型提示与图形不匹配，未定位上游丢图环节。详情见[观测记录](docs/tool-image-observation-2026-11-27.md)。

## License

MIT · 上游协议与实测结论见源码注释；Trae 接口为未公开内部接口，后端改协议可能导致插件失效。
