# 部署与配置

所有配置都来自 `ADPROOF_` 前缀的环境变量，默认值可以完全离线运行。完整列表见 [`.env.example`](../.env.example)。

## 本地运行

```bash
cd backend && python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000

cd frontend && pnpm install && pnpm dev      # http://localhost:5173
```

前端构建后（`pnpm build`），后端会直接托管 `frontend/dist`，访问 http://localhost:8000 即可。

## Docker

```bash
docker compose up --build        # http://localhost:8000
```

- 镜像分两阶段：Node 构建前端，Python 运行 API 并托管前端；以非 root 用户运行，带健康检查。
- SQLite 数据库位于数据卷 `/app/data`。
- 在线编辑的规则库写回镜像内的 `backend/rules/adproof_rules.yaml`；需要持久化时，把规则文件放到数据卷并设置 `ADPROOF_RULES_PATH`。
- 生产环境务必设置 `ADPROOF_JWT_SECRET`，并设置 `ADPROOF_SEED_DEMO=0` 关闭演示账号。

## 接入真实模型

| 预设 | Base URL | 说明 |
|---|---|---|
| `doubao` | `https://ark.cn-beijing.volces.com/api/v3` | 火山方舟；`ADPROOF_LLM_MODEL` 填控制台中的模型或接入点 ID |
| `hunyuan` | `https://api.hunyuan.cloud.tencent.com/v1` | 腾讯混元 OpenAI 兼容接口 |
| `deepseek` | `https://api.deepseek.com/v1` | DeepSeek |

```bash
ADPROOF_LLM_PROVIDER=openai_compat
ADPROOF_LLM_PRESET=doubao
ADPROOF_LLM_API_KEY=...
ADPROOF_LLM_MODEL=...
# ADPROOF_LLM_BASE_URL=...        # 其他 OpenAI 兼容服务
# ADPROOF_LLM_JSON_MODE=1         # 默认开启；模型返回 400 时自动去掉 response_format 重试
# ADPROOF_LLM_TEMPERATURE=0.2
```

模型 ID 经常变化，代码中不写死任何模型名。接入真实模型后：

- 卖点提炼、脚本生成、模型审查和改写润色都会调用模型；规则审查、事实核对、证据定位和校验仍是确定性代码；
- 使用真实模型时启动不会生成演示审查记录，避免启动就消耗 Token；
- 建议先运行一次评测（`python -m app.evals.cli --report real.json`），记录模型版本、指标、Token 和延迟。

## 其他配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ADPROOF_REVIEW_CHANNELS` | `rule,llm` | 只开某一个通道时可设为 `rule` 或 `llm` |
| `ADPROOF_REWRITE_MAX_ROUNDS` | `2` | 改写与复审的最大轮数 |
| `ADPROOF_MAX_SCRIPT_CHARS` | `6000` | 单次提交的字数上限 |
| `ADPROOF_MOCK_LATENCY_MS` | `0` | 仅用于演示：给离线模型加模拟延迟，链路页面会注明“耗时为模拟值”；测试、评测和启动时的演示数据都不使用 |
| `ADPROOF_CORS_ORIGINS` | `http://localhost:5173` | 逗号分隔 |
