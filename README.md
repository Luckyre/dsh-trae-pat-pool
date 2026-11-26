# dsh-trae-pat-pool

> 在 DeepSeek Harness（dsh）里直接调用 **Trae 企业版模型**，支持**多 PAT 席位池**（故障转移 / 轮转）与**逐席位额度显示**。

一个 dsh 插件。填一个 PAT 即可用；填多个 PAT 就变成一个号池：主席位被限流或额度用完时自动换下一个，也能每个请求轮转一个席位。不需要 `trae2api` 进程、不需要 Python、不需要 `traecli`。

> 这是**产品初步迭代（v0.14.3）**：核心链路已可用，细节会继续打磨。欢迎 issue / PR。

---

## 特性

- **PAT 直连**：PAT 在 Trae 企业控制台生成，插件用它兑换 Cloud-IDE JWT，直连 `/api/ide/v2/llm_raw_chat`；流式正文、流式 thinking、function calling、token 用量都支持。
- **多席位号池**：每个席位一个 PAT，页面上增删/排序。两种模式：
  - `failover`（默认）——主号一直用，被拒绝（额度用完 / 限流 / 令牌失效 / 服务端错误）才换下一个，并给坏席位记冷却；
  - `rotate`——每个请求换下一个席位，把额度和限流摊开。
- **逐席位额度**：企业版席位填控制台账号后，每个席位各读各的额度；输入框旁的徽标只读主席位（`?scope=primary`），不为几个数字给每个席位都发一次请求。
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
   dsh plugin --profile desktop add ./dsh-trae-pat-pool-0.14.3.tgz
   ```

   也可以在侧栏 **插件 → 添加插件** 里填目录绝对路径 / tgz 路径。

3. 重新打开 Desktop → 设置面板左侧 **Trae** 页 → 在「席位」里填 PAT，保存。

然后在对话框右下角模型菜单里选 **Trae** 分组的模型，思考档位在同一菜单切换。选中 Trae 模型时模型选择器旁会显示剩余额度徽标。

卸载：`dsh plugin --profile desktop remove dsh-trae-pat-pool`。

## PAT 从哪来

在 Trae 企业控制台生成个人访问令牌（Personal Access Token）。填到 Trae 页的席位里后只保存在 dsh 凭据库（默认引用名 `TRAE_PAT`），**不会写进任何配置文件**，保存后即时生效。

> 若手上已有 Cloud-IDE JWT（例如 `~/.trae/cli/auth.json` 的 `access_token`），也可以直接填进 PAT 框：插件识别为 JWT 后原样使用，过期后需要自己更新。

## 号池怎么用

Trae 页的「席位」列表：

- **添加席位** → 生成一行，填 PAT；企业版席位再填控制台邮箱与密码。
- 每席位可改名、上移/下移（顺序就是优先级）、移除。
- 密钥输入框是**本地暂存 + 停顿提交**：打字不写盘，停 600ms 才写一次，所以输入很跟手。
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

- **Trae 页**：每席位一块「剩余额度」，显示额度包、已用/剩余/到期与按模型用量。
- **模型选择器旁的徽标**：只读主席位那一份，点击刷新（`?scope=primary`）。
- 宿主路由：`GET /api/dsh-trae-pat-pool/quota`（全部席位）/ `?scope=primary`（主席位）/ `?refresh=1`（跳过缓存）。有 1 分钟缓存。

> **企业版额度只认控制台账号，不认 PAT**：两个席位共用同一控制台账号会读到同一份数字。插件会拿 JWT 里的账号与配置的控制台邮箱比对，**不一致时在席位行给出"账号不匹配"警告**（两者确实可以合法地不同，例如子账号或代管，所以只是警告不是拦截）。每个席位仍建议配独立的控制台账号；SSO-only 租户没有这条路径。个人版（ToC）额度走 IDE 接口，无需控制台账号。

## 开发

```sh
pnpm install
pnpm typecheck
pnpm run build     # 产出 lib/index.js + lib/client.js
pnpm test          # 单测（部分环境会因禁止 spawn python3 而失败一项 zip 校验）
```

源码：`src/index.ts`（宿主注册与配置）、`src/adapter.ts`（请求与故障转移）、`src/trae/pool.ts`（号池）、`src/trae/quota.ts`（逐席位额度）、`client/client.js`（浏览器端 Trae 页与徽标）。

## Roadmap（v0.14.4 之后的想法）

已完成（v0.14.4）：
- **修复多模态图片发送**：`readImageRequest` 的 target 用了错误的字段名（`maxBytes` 而非 `maxImageBytes`，且缺 `imageTargetBytes`），DSH 的 `validateTarget` 直接抛错，异常被 `catch` 吞掉后图片静默降级为 `[image omitted]` —— 此前**所有**多模态模型其实都没真正收到过图。现已按契约修正并加回归测试。

已完成（v0.14.3）：
- 账号配对警告（PAT 账号 ↔ 控制台邮箱）
- 命名空间三处一致性自检 + CI 断言
- 多席位额度并发查询

待做：
- **tool 轮次图片**：上游只接受 user 轮次的图片，当前 `read_image` / 截图工具的结果会被替换为 `[image omitted]`。要让 Agent 自己读图需另行设计（直接塞进 user 轮次有触发上游 1210 的风险）。
- 席位健康检查面板（谁被冷却、为什么、何时恢复、清除冷却按钮）
- 换号会话内提示 / 当前席位标识
- 按席位分配模型白名单
- 配置迁移提示（旧 `trae2api` 行残留）
- 诊断信息一键复制

## 已知限制

- **图片只能来自 user 轮次**：直接把图贴进对话可用；由工具（`read_image`、截图、OCR）读回来的图不会被发送。原因见 Roadmap。
- **单图长边上限 1024px、单图 2MB**：超出会由 DSH 重新编码，超大图可能被压缩到细节不可辨。

## License

MIT · 上游协议与实测结论见源码注释；Trae 接口为未公开内部接口，后端改协议可能导致插件失效。
