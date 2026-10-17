# LoveMi AI 注册｜v1.9 原流程 + P1B v1.11（本地 / Vercel）

项目现包含独立的手机端前台。首页是 `index.html`，按参考图实现紫色渐变聊天、猫咪、人物卡、60% 阶段卡和 100% 完整画像卡。已有路由、模型理解与画像生成继续使用原引擎，调试工作台单独保留。

运行 `npm start`（Windows PowerShell 可用 `npm.cmd start`，或双击 `start_windows.bat`），打开 **http://127.0.0.1:8768/**；调试工作台打开 **http://127.0.0.1:8768/debug**。聊天会在本机浏览器保留，保存画像后也可再次查看。

仅检查界面时，可访问 `/?preview=chat`、`/?preview=cards`、`/?preview=60`、`/?preview=100`。这些地址展示固定的视觉样例，真实聊天请使用不带 preview 参数的首页。

**上传 GitHub 不会自动启动网站。** 仓库里的 `index.html` 是网页入口；真实模型聊天需要同时运行 Node 后端。GitHub Pages 只能展示静态页面与视觉样例，不能执行 `/api/model`。部署到支持 Node.js 的服务时，启动命令为 `npm start`，设置 `HOST=0.0.0.0`，端口可由平台的 `PORT` 环境变量指定。也可构建随包 Dockerfile：`docker build -t lovemi .`，再运行 `docker run --rm -p 8768:8768 lovemi`。

**Vercel 已有独立适配。** `vercel.json` 构建浏览器文件到 `public/`，`api/model.js` 与 `api/status.js` 自动部署为 Node Functions，复用本地网关。Vercel 不运行 `npm start`，也不需要常驻监听端口。之前直接上传静态页面时没有 `/api/model` 函数，因此能打开页面却无法调用模型。

猫咪素材与来源见 `assets/README.md`。

**本项目沿用你上传的 v1.9 参考实现流程。** 题目主线、进度权重、节点与模拟人物继续使用既有配置；原 85 项流程用例扩展为 89 项，另补 7 项路由边界检查。增量变更如下：

- `P1B` 替换为已经确认的 **v1.11 承接 Few-shot + 人物卡自然追问**版本。
- `P3` 使用本次自然切入版重问引子，`P6` 使用本次人物速写版关系画像；`P5/P7` 使用 v1.11 Prompt，`P1` 保留旧版用于 A/B 对照。
- `config.stage_rules` 的人物卡部分同步 v1.11 的追问边界；其他路由配置不做业务重构。
- HTML 与 `src/engine.js` 同步修复跳题对象判断、补充题状态、延后重问间隔及阶段入口；“真实模型”调用由本地 Node 服务代理，模拟回放和页面内状态/Prompt/测试面板保留。
- 新增独立模型配置 `config/models.json`，无需把 API Key 写入前端。

## 1. 本地运行（Node.js 18+）

**Windows：** 双击 `start_windows.bat`；或在项目目录终端执行：

```bash
node server.js
```

**macOS/Linux：** 执行 `./start_mac_linux.sh`（也可直接运行 `node server.js`）。

打开 **http://127.0.0.1:8768**。不要直接双击 HTML 文件，因为那样模型代理 `/api/model` 不可用。

页面有两个模式：

- **模拟回放：** 无需模型，直接选择场景，按“下一句”或“播放到底”。验证的是 v1.9 节点逻辑。
- **真实模型：** 自己在左下角输入「开始」，按实际流程回答。后端会按每个节点调用你配置的模型。页面右侧可查看节点轨迹、模型输出和状态。

### 部署到 Vercel

导入本仓库，Root Directory 选择包含 `package.json` 的项目根目录。Framework Preset 使用 **Other**，保留仓库 `vercel.json` 中的构建设置：Build Command 为 `node scripts/build-public.js`，Output Directory 为 `public`。已有项目更新后重新部署最新提交；若曾手动覆盖构建目录或框架，请恢复以上设置。

后端函数包含 `config/models.json` 和本次已授权随私有仓库提交的 `.env`，静态目录只复制指定前端文件，不包含密钥和后端源文件。Vercel 项目中的 `MODEL_API_KEY`、`MODEL_API_BASE` 环境变量优先于 `.env`，可以直接在项目 Settings → Environment Variables 中覆盖；修改后重新部署。保留 `fluid: true` 与函数 `maxDuration: 210`，给 P6/P7 的 180 秒网关超时留下返回响应的时间。

部署后先访问 `/api/status`，应返回 `ok: true`、`key_configured: true` 和六个节点模型名称；这里不会返回 Key。再回到不带 `preview` 参数的首页发送消息。界面预览页使用固定示例，不执行真实聊天。调试工作台仍可通过 `/debug/` 访问。

本地检查可运行 `npm run build` 和 `node tests/test_vercel.js`；它们验证静态构建、函数入口、Vercel 预解析请求体、环境覆盖与密钥隔离，不依赖线上部署，也不消耗模型额度。实际域名的网络、模型账户权限和 Vercel 部署日志需在对应项目中确认。

平台行为参考 [Vercel Node.js Functions](https://vercel.com/docs/functions/runtimes/node-js)、[项目配置](https://vercel.com/docs/project-configuration/vercel-json) 与 [函数运行时长](https://vercel.com/docs/functions/limitations)。

## 2. 单独配置模型

模型配置均在 **`config/models.json`**，和提示词/流程代码分离。修改后下一轮调用即可生效。每个节点可以使用不同的 `model`、`temperature`、`max_tokens` 和 `timeout_ms`。

| 节点 | 思考模式 | 网关超时（可编辑） |
| --- | --- | --- |
| P1/P1B/P3/P5 | 关闭 | 60 s |
| P6/P7 | 开启 | 180 s |

当前服务是阿里云百炼 `https://dashscope.aliyuncs.com/compatible-mode/v1`，全部节点使用 `deepseek-v4.1-flash`。网关发送 `enable_thinking=false/true`，P6/P7 的 `max_tokens=8192` 为思考与最终输出预留空间。按本次私有仓库部署要求，后端 `.env` 随项目提交；浏览器端无法读取密钥。

> 网页的“按生产超时执行”仍使用原流程的性能预算，云端调试请保持关闭。网关按上表超时控制实际请求。

接第三方兼容 OpenAI Chat Completions API 时：

1. 修改 `config/models.json` 中 `provider.api_base`，填到 `/v1`（或完整的 `/chat/completions`）。
2. 修改 `nodes.P1B.model` 等节点的具体模型名称。
3. 复制 `.env.example` 为 `.env`，在 `.env` 写 `MODEL_API_KEY=你的Key`；不要把 Key 写进 `models.json` 或网页中。
4. 重启服务；运行时 `MODEL_API_BASE` 环境变量也能临时覆盖 `provider.api_base`。

**注意**：本地模型网关使用的是 OpenAI-compatible `/chat/completions`，不是 Responses API；部分不支持 `temperature` 或 `max_tokens` 的模型，需要在配置中删除相应参数。模型不支持强制 JSON 结构时保持 `response_format_json=false`。浏览器不会收到密钥。

## 3. Prompt 和业务配置放在哪里

| 文件 | 内容 |
| --- | --- |
| `data/prompts.json` | **当前运行所用** P1/P1B/P3/P5/P6/P7 全部提示词，HTML 内已同步一份默认值 |
| `prompts/P1B_system.txt` | 单独阅读或替换 P1B 系统提示词 |
| `prompts/P1B_user.txt` | P1B 用户提示词（变量模板） |
| `prompts/P1B_stage_rules.json` | 人物卡/需求/补充题阶段专属规则 |
| `prompts/P6_system.txt` / `prompts/P6_user.txt` | P6 关系画像新版系统提示词与输入模板，已同步到 JSON 和网页默认值 |
| `data/config.json` | **当前运行所用** v1.9 题库、任务顺序、额度、标签等配置，HTML 内同步默认值 |
| `config/models.json` | 单独修改每个节点的模型配置 |
| `src/engine.js` | 基于 v1.9 修复后的节点引擎，与网页内嵌版本同步 |
| `docs/dialog-routing-current.md` | 当前主问题顺序、跳题门槛、追问/重问/补充题与本次路由修复 |
| `docs/` | 随包保留的 v1.9 原始规则/流程资料，便于逐项核对；文档名称仍是 v1.9 |

**编辑 Prompt 注意：**网页“Prompt”面板中可直接修改并临时存入本机浏览器，下一轮生效。此类编辑**不会自动写回** `data/prompts.json`，再次打包要手动同步。网页里的“恢复默认”恢复当前所选节点的随包默认提示词。Prompt 本地缓存使用 `lm_prompts_v19_v11`，本次 P6 修订额外通过 `lm_p6_prompt_revision` 进行一次性更新。

**P6 本次更新：**采用新版人物速写风格，区分用户自身、对 TA 的期待和双方关系；仅按明确标记保留硬性底线，矛盾无法确认时略过。三个输出字段和输入变量保持原契约，文案上限分别为 60/80/100 字，已有准确的 20～24 字 60% 洞察可以直接保留，事实不足时不为凑字数扩写。刷新网页时会一次性更新浏览器缓存中的 P6，其他节点已保存的编辑保留；更新后仍可在 Prompt 面板编辑 P6。

**问题话术同步：**已按 `LoveMi_词库与话术库 (2).xlsx` 的“话术库”C7:C27 和“补充题库”A2:I5，核对并导入 10 道主问题的脚本、重问核心句、主题短语，以及 4 道补充题的文案和理解配置。原项目文案已与表格一致；本次增加 `lm_question_bank_revision` 一次性更新浏览器旧题库缓存。只覆盖这些题目的对应配置，已保存的路由、配额和标签设置保留，P6 提示词沿用本次已更新版本。刷新网页后开始新会话即可使用。

**P3 与路由修正：**P3 已更新为自然切入、按需使用相关事实的新提示词，用户提示词变量保持原样。刷新时单独更新 P3 缓存，并为恋爱题的最小信息补上对象限制。引擎修复和当前实际跳题规则见 `docs/dialog-routing-current.md`，网页内嵌引擎与测试同步更新。

**P1B 人物反馈修正：**统一具体 L2 的追问判断，消除“可确认择偶意义”与“理由具体就停止”的冲突，修正省略追问的示例。人物卡阶段同时提取用户明确表达的自身信息，例如“我也喜欢音乐”须记录为用户兴趣，不能只记人物卡吸引点。补充完整的选择、共同兴趣、追问确认与 L3 停止示例；刷新时单独更新 P1B 及人物卡阶段规则缓存。

“人物反馈追问”A2:E4 的 L1/L2/L3 定义和示例问法也已补入人物卡阶段提示词，并同步到 `prompts/P1B_stage_rules.json`。示例中的字母称呼改为名字，实际调用时使用当前人物卡名字；追问仍遵守现有停止条件及系统额度，不为满足示例备注中的次数要求额外提问。

## 4. 跑测试

```bash
node tests/run_tests.js          # 89 项流程回归测试（无需 API）
node tests/run_demo.js A         # 模拟完整注册流程
node tests/run_demo.js B         # 模拟 60% 直接生成画像
node tests/test_local_gateway.js # 本地模型调用网关集成测试（模拟上游，不消耗真实 Key）
node tests/test_routing_edges.js # 7 项跳题、旧会话、阶段入口、P3 与测试框架边界检查
node tests/test_vercel.js        # Vercel 函数适配、请求体与公开构建保护检查
```

这里的自动测试主要覆盖**路由、状态机、契约和模型代理通路**；不代表已经验证 P1B 的中文承接自然度、字段提取准确率或真实模型延迟。真模型需自行配置并运行。

## 5. 继承原 v1.9 的重要说明

- 保留 v1.9 的 60% / 100% 阶段划分，前后阶段路由由 `src/engine.js` 控制，而非模型决定。
- 当前的 89 项流程用例使用预设模型 JSON，因此能验证节点逻辑，而**不能代替真实 LLM 测试**。
- 配置里的预设人物、标签、问法、进度和额度全部按你上传的 v1.9 工程保留；不从其他讨论推定新的问卷规则。
- 此项目为**单机 Prompt 验证工具**，默认服务仅监听 `127.0.0.1`，没有生产级账号、多用户隔离、远程部署安全策略或永久云端会话存储。会话状态主要存在当前浏览器页面中。
- 实际回复**不是逐 token 流式**：当前模型网关得到完整节点 JSON 后，页面展示回复；这样保留原 v1.9 流程与 JSON 校验机制。
