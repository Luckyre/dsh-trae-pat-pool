# PAT 号池方案 A 验证记录

日期：2026-11-28

范围：本地 `feature/pat-pool-ui-a`，基于 `29f9e7d` 的独立工作区。改造未安装到当前 DSH，未推送远端、创建 PR 或发布版本。

## 最终结果

| 项目 | 结果 | 证据边界 |
| --- | --- | --- |
| TypeScript 检查 | 退出码 0 | 真实源码，现有 TypeScript 工具链 |
| 主机生产构建 | 退出码 0 | esbuild 生成 `lib/index.js` |
| 浏览器产物 | 与源码 SHA256 一致 | `client/client.js` 复制到 `lib/client.js` |
| 测试入口构建 | 退出码 0 | esbuild 生成忽略提交的 `lib/testing.mjs` |
| 完整兼容回归 | 209 项通过，0 失败 | 单进程测试模式；排除下述 1 项受限 ZIP 子进程用例 |
| ZIP 等价断言 | 全部通过 | 直接运行 Node 生成与捆绑 Python 解压校验，未修改原测试 |
| 前端规格审查 | 通过 | 独立源代码审查；56 项前端回归及额外需关注筛选复现，共 57 项通过 |
| 主机规格审查 | 通过 | 账号状态、并发归属、只读接口、凭据版本、延迟失败与身份快照 |
| 独立代码质量复核 | 通过 | 发现的 3 项 Important 问题均先复现、再修正并独立回验；无剩余阻断项 |
| 差异格式检查 | 通过 | `git diff --check`、暂存区检查；仅有 Git 的 LF/CRLF 提示 |

最终浏览器源码及产物 SHA256：

```text
f269c8837dec9217190081d481b0fed990cd833e12660dc6fbeaf7e1beb1b4da
```

## 沙箱适配与原有基线

最初基线共 159 项，158 项通过；`artifact: a stored zip with UTF-8 names that unzip accepts` 因 `execFileSync('python3')` 触发沙箱 `EPERM`，不是本次功能失败。常规 Node 测试器的子进程隔离也受同类限制，因此本机使用 `--test-isolation=none --test-concurrency=1`。

复用依赖目录的 worktree 不运行 pnpm 隐式安装：pnpm 的模块目录保护会拒绝处理指向原仓库的 node_modules junction。构建和检查直接使用现有 TypeScript/esbuild 入口，未改包管理器全局设置，也未重装依赖。

最终 Node 测试命令明确排除上述一个 ZIP 用例。Node 的这项筛选在输出中直接省略该用例，因此输出为 `tests 209 / pass 209 / skipped 0`；不能把它误报成原 ZIP 测试自身通过。

该 ZIP 用例的真实 `zipStore` 导出仍由最终构建入口执行：检查标准 CRC32、ZIP 首尾签名、文件数；再由捆绑 Python 直接打开生成包，检查中文 UTF-8 文件名、HTML/二进制内容及全部 CRC。所有断言通过，未利用 Node 捕获子进程管道。

## 主要验证内容

- PAT/邮箱/密码不会按字符、停顿或增删排序动作自动写入；明确保存失败保留草稿，确认写入后的元数据失败只重读元数据。
- 迟到写入、旧验证、移除账号、离开页面和重新挂载不覆盖新输入或留下“验证中”状态。
- 状态读取不触发上游鉴权或轮转；直接 JWT 必须经服务器验证，本地解析不算鉴权通过。
- 同时运行的不同会话记录各自的实际账号；旧请求结束或旧凭据失败不覆盖新请求和新凭据。
- 真实成功的模拟上游请求可建立当前凭据验证证据；部分输出后报错、旧凭据成功、失效 JWT 均不能产生错误的可用状态。
- PAT 刷新兑换遭鉴权拒绝撤销旧的有效证据，网络异常显示暂不可用并保留原错误语义。
- 请求保存当时账号名称或安全身份；包括 JWT 无姓名、身份仅来自 GetUserInfo 的情况，换令牌/移除后仍保留历史归属。
- 随机不透明 credentialVersion 绑定账号、请求和额度；新旧版本的缓存与并发读取隔离，旧响应不能覆盖新缓存，历史请求不显示新凭据的额度。
- 空闲后的请求开始/结束主动补读，运行时 2 秒、空闲时 30 秒；后台暂停、失败退避及卸载清理均有行为回归。
- 原模型目录、图片兼容策略、工具调用、分享和旧单 PAT/故障转移/轮转测试保持通过。

## 可复现命令

在本隔离工作区运行，使用本机捆绑 Node：

```powershell
& 'C:\Users\PC\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' node_modules/typescript/bin/tsc -p tsconfig.json
& 'C:\Users\PC\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' node_modules/esbuild/bin/esbuild src/index.ts --bundle --platform=node --format=esm --target=node20 --outfile=lib/index.js --external:@deepseek-ai/cordis --external:@deepseek-ai/dsh-llm --external:@deepseek-ai/schemastery
Copy-Item client/client.js lib/client.js
& 'C:\Users\PC\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' node_modules/esbuild/bin/esbuild test/_internals.ts --bundle --platform=node --format=esm --target=node20 --outfile=lib/testing.mjs --external:@deepseek-ai/dsh-llm
& 'C:\Users\PC\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' --test --test-isolation=none --test-concurrency=1 '--test-skip-pattern=^artifact: a stored zip with UTF-8 names that unzip accepts$' test/internals.test.mjs test/pool.test.mjs test/pool-plugin.test.mjs test/plugin.test.mjs test/client.test.mjs test/share.test.mjs test/request-usage.test.mjs test/pool-ui.test.mjs
```

普通不受限环境可按 README 使用项目构建、测试脚本；上述命令仅是本机验证方式。

## 未验证项与交付边界

- 没有将开发分支安装到用户当前 DSH，也没有改变 profile。当前已安装界面不会因这次源码提交自动更新。
- 浏览器工具对当前 DSH 主地址明确返回 `WCU_POLICY_DENIED`；未绕过限制。因此未对已安装 GUI 做真实视觉、浅深主题、窄屏或键盘验收。此前原型和确定性组件测试不能替代这类验收。
- 未使用真实 Trae PAT 调用上游；鉴权、限流、额度及并发错误场景使用可控假上游。真实企业租户接口兼容性仍需安装后验证。
- 主工作区原有图片探测修改和未跟踪文件保持保留，不包含在本分支提交中。
- 本分支与工作区保留供审查；远端推送、合入、发布、安装分别按后续明确要求执行。
