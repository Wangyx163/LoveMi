# 本次修改清单（相对用户上传的 v1.9 参考实现）

## 保留不动

- `src/engine.js` 原有节点函数、路由、进度、状态、业务规则。
- `tests/cases.js` 85 个逻辑用例及运行入口。
- `data/config.json` 的题目、权重、额度、模拟人物和标签等所有配置；只调整 `version` 与三个阶段专属提示段落。
- v1.9 的原始 `docs/` 流程和规则资料。

## Prompt 变更

- P1B：使用已确认的 v1.11 完整系统及用户提示词。包含 5 条 ack Few-shot，自然承接规则及人物卡示例。
- P3/P5/P6/P7：同步替换为 v1.11 合集中的文本。
- P1：保留 v1.9 原文，供旧版对照。
- `stage_rules.CARD`：人物追问由“追具体五官”改为“询问其他具体印象/吸引点”；需求及补充阶段规则与 v1.11 合集保持一致。

## 本地运行新增

- `server.js` 本地 HTTP 服务及 OpenAI-compatible Chat Completions API 代理。
- `local_model_client.js` 浏览器到服务器的模型节点请求。
- `config/models.json` 六节点独立模型配置。
- `.env.example` Key 配置样例；密钥仅由服务端读取。
- `start_windows.bat`、`start_mac_linux.sh`。
- `tests/test_local_gateway.js` 无真实模型网关联调测试。

## 测试界面

- 原 HTML 的 mock、真实模型、调试轨迹、状态、Prompt、A/B 对比保持。
- 默认 Prompt、默认 CONFIG 与 `data/` 同步。
- 本地真实模型模式不再依赖 `window.claude.use`；有独立后端时优先使用本地接口。
- 新的本地存储 Prompt Key 防止以前的浏览器自定义 Prompt 覆盖本次 v1.11 默认提示词。

## 尚不涵盖

- 真实模型自然度/准确率测评。
- 流式 Token 输出及多用户生产级后端。
- 修改 v1.9 原始业务路由或题库；如需改这些，应当作为独立需求处理。
