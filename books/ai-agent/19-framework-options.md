# 19. AI 框架選型對照(LangGraph / LangChain / deepagents / Vercel AI SDK)

## 定位

新專案的技術棧已定案 **PostgreSQL + Hono + Next.js + pnpm + Redis + docker-compose**,唯獨 **AI agent 框架尚未定案**。四個候選:

| 候選 | npm 套件 | 現況版本(2026-07 查證) | 一句話定位 |
|---|---|---|---|
| **LangGraph** | `@langchain/langgraph` | 1.4.7 | 低階圖編排:StateGraph、checkpointer、interrupt——LibreChat 底層即為此 |
| **LangChain 1.x** | `langchain` | 1.5.2 | `createAgent` 高階 agent harness + middleware 生態,**底層就是 LangGraph** |
| **deepagents** | `deepagents` | 1.10.5 | LangChain 官方「batteries-included」harness:planning / filesystem / subagents 開箱,**建於 LangGraph 之上** |
| **Vercel AI SDK** | `ai` | 7.0.11(v6 6.0.218 / v5 5.0.209 維護線) | 輕量 agent loop(`streamText` / `ToolLoopAgent` / `stopWhen`)+ 最強的 provider 抽象與 UI 串流協定 |

本文不預設任何一個是最終選擇。做法是:**以 LibreChat 各子系統(01~18 文件)推導出的能力需求為基準,逐項對照四個框架的支援方式**,如實呈現一個關鍵不對稱——LibreChat 的 `@librechat/agents` 就是 LangGraph 的封裝(`@librechat/agents@3.2.57` 直接依賴 `@langchain/langgraph@^1.4.6`),因此:

- 選 **LangGraph 系**(含 LangChain / deepagents):LibreChat 的執行引擎、HITL、多代理做法可以**當作同一套 primitives 的生產級參考實作**直接照讀。
- 選 **ai-sdk**:較多能力要自建,但每一份文件的「移植到新技術棧的建議」章節本來就是以 ai-sdk 為假想對象寫的,自建的路線圖已備好。

兩邊都有參考材料,只是性質不同:前者是「程式碼級參考」,後者是「設計級參考」。

> 注意版本時效:本文所有版本號與 API 名稱以 2026-07-02 的 npm registry 與官方文件為準。四個框架在過去一年都有 major 演進(LangGraph JS 進入 1.x、LangChain 1.x 成為主線、deepagents 出了正式 JS 版、AI SDK 直接到了 v7),任何 2025 年以前的訓練知識或部落格文章都可能過時。

## 四個候選的定性介紹

### LangGraph(`@langchain/langgraph` 1.4.7)

**哲學**:agent 是一張顯式狀態圖。節點是計算、邊是控制流、state 是 reducer 合併的共享資料結構;持久化(checkpointer)、暫停(interrupt)、串流都是圖的一級公民。

- **抽象層級**:最低。你要自己定義 `StateGraph`、`addNode`/`addEdge`/`addConditionalEdges`、編譯、管理 `thread_id`。換來的是任意拓撲(平行節點、subgraph、迴圈)與對每一步的完全控制。
- **HITL**:`interrupt()` 在任意節點內暫停並拋出 payload,呼叫端以 `graph.invoke(new Command({ resume: value }), config)` 重入;狀態存在 checkpointer,**可以在另一個 process / 另一台機器 resume**——這正是 LibreChat「暫停 24 小時、跨 replica 核准」(14 文件)的底層機制。
- **Checkpointer**:官方 JS 套件齊全——`@langchain/langgraph-checkpoint-postgres`(1.0.4,`PostgresSaver`,官方標示 production-ready、LangSmith 自用)、`@langchain/langgraph-checkpoint-redis`(1.0.10,`RedisSaver`)、另有 sqlite / mongodb(LibreChat 用的 `MongoDBSaver` 1.4.0)。**新棧的 PostgreSQL + Redis 都有官方 checkpointer 直接可用**。
- **Streaming**:`streamMode` 六種粒度(`values` / `updates` / `messages` token 級 / `custom` / `tools` / `debug`),可同時開多種、可含 subgraph(`subgraphs: true` 帶 namespace);另有 `streamEvents`(LibreChat 用 v2,LangChain 1.x 文件已推 v3)。
- **維護狀態 / TS 支援**:LangChain 主力產品線,1.x 為穩定主線;TS 一級支援(langgraphjs 是獨立 first-class 實作,非 Python 移植殘本)。
- **與 Hono/Next.js 整合**:它只是一個 Node library,無框架綁定;SSE 橋接要自己寫(LibreChat 的 callbacks → SSE 就是這層)。LangGraph Platform / `useStream` React hook 是可選加值,不是必需。

### LangChain 1.x(`langchain` 1.5.2)

**哲學**:1.x 徹底重寫了舊 LangChain 的心智模型——核心只剩一件事:`createAgent`(model + tools + middleware 的 agent harness),**回傳的就是一張編譯好的 LangGraph 圖**。舊版鏈式抽象(Chains/AgentExecutor)已淘汰。

- **抽象層級**:中。你不碰圖,但拿到的物件支援所有 LangGraph 能力(checkpointer、`thread_id`、interrupt、streamEvents)。客製化靠 **middleware** 在 loop 的固定掛點(before/after model、wrap tool call)插入行為。
- **內建 middleware**(等於 LibreChat 多個子系統的現成對應):`humanInTheLoopMiddleware`(HITL 審批)、`createSummarizationMiddleware`(context 壓縮——對應 04 文件的 summarize 節點)、`todoListMiddleware`(任務規劃)、`piiMiddleware`、`modelRetryMiddleware` / `toolRetryMiddleware`、`createSkillsMiddleware`、`createFilesystemMiddleware`。
- **Structured output**:`responseFormat` + Zod schema,結果掛在 `structuredResponse`。
- **Provider**:`"anthropic:claude-sonnet-4-6"` 字串或 `@langchain/*` provider 套件實例——LibreChat 的 provider 層(06 文件)用的就是同一批套件(`@langchain/openai`、`@langchain/anthropic`、`@langchain/google-vertexai`、`@langchain/aws`⋯,見 `@librechat/agents` 的依賴表)。
- **與 LangGraph 的關係**:不是競爭而是分層——官方定位是「先用 createAgent,不夠再 eject 到 LangGraph」。middleware 本身可以直接用在自建的 LangGraph 圖裡。
- **維護狀態**:LangChain 公司的主線產品,發版頻繁(1.5.x);TS/Python 雙軌同步。

### deepagents(`deepagents` 1.10.5,repo:langchain-ai/deepagentsjs)

**哲學**:「agent harness 的 batteries-included 版」。官方回答「JS/TS 是否可用?」——**可用且已成熟**,npm `deepagents` 就是 JS 套件(1.10.5),與 Python 版(langchain-ai/deepagents)同名分倉。

- **內建能力**:
  - **Planning**:`write_todos` 工具 + `todoListMiddleware`,pending / in-progress / completed 狀態追蹤。
  - **Filesystem**:虛擬檔案系統工具組(`ls` / `read_file` / `write_file` / `edit_file` / `glob` / `grep` / `execute`),backend 可插拔:`StateBackend`(存圖 state)、`StoreBackend`(LangGraph Store)、`FilesystemBackend`(本機磁碟)、`CompositeBackend`(路由混搭)、沙箱 backend。
  - **Subagents**:內建 `task` 工具 spawn ephemeral subagent,隔離 context、回傳單一報告——與 LibreChat 的 subagent 隔離模型(05 文件)同構。
  - **Skills / Memory**:`SKILL.md` 漸進式載入、`AGENTS.md` 跨對話記憶;自動 summarization 與大型工具結果 offload;Anthropic/Bedrock prompt caching。
  - **HITL**:`interruptOn` 參數宣告哪些工具要審批,底層即 LangGraph interrupt。
- **關鍵事實**:`createDeepAgent()` **回傳編譯好的 LangGraph 圖**——checkpointer(Postgres/Redis)、streaming、interrupt、Studio 全部直接適用。它是 `createAgent` + 一組官方 middleware 的預組合,middleware(`createFilesystemMiddleware`、`createSubAgentMiddleware`、`createAsyncSubAgentMiddleware`、`createMemoryMiddleware`⋯)全部可單獨抽出用在 createAgent 或 LangGraph 上。
- **代價**:最有主見(opinionated)。它假設你要的是「Claude Code 式」的規劃-執行-委派 harness;若產品的 agent 形態不同(例如 LibreChat 式多端點聊天平台),部分內建行為(todo 提示詞、檔案工具)反而要關掉或覆寫。

### Vercel AI SDK(`ai` 7.0.11)

**哲學**:LLM 呼叫是一個函式,agent 是一個帶停止條件的迴圈,狀態就是 messages 陣列。不引入圖,換取最小心智負擔與最深的 TypeScript / Web 標準整合。**v7(現行)已從「chat primitives」長成「agent 平台」**,補上了過去相對 LangGraph 的多數缺口:

- **Agent loop**:`streamText` / `generateText` 內建 tool loop,`stopWhen`(預設 `stepCountIs(20)`,對應 LibreChat 的 recursionLimit 保險絲)+ `prepareStep`(每步可換 model / 工具集 / 改寫 messages——可做 compaction 與輕量 handoff)。
- **Agent 類**:`ToolLoopAgent`(核心 agent 類:tools、approvals、typed `runtimeContext` / `toolsContext`、lifecycle callbacks)、`WorkflowAgent`(`@ai-sdk/workflow`:**durable execution**,步驟間狀態落盤,重啟 / 部署 / 延遲核准後可續跑)、`HarnessAgent`(把 Claude Code / Codex 等外部 harness 包成標準 Agent 介面)。
- **HITL**:v7 的 **tool approvals** 已是一級功能——`generateText` / `streamText` / `ToolLoopAgent` 可宣告 approval policy(需人工核准 / 自動核准 / 自動拒絕 / 自訂函式);搭配 `WorkflowAgent` 可跨程序恢復。傳統的「工具不給 `execute` → 落盤 messages → 補 tool result 續跑」模式仍然可用且更透明。
- **Streaming / UI**:`fullStream` 細粒度 parts(text-delta / reasoning-delta / tool-call / tool-result / finish-step⋯)、UIMessage stream 協定 + `useChat`;**resumable streams**:`useChat({ resume: true })` + `resumable-stream` 套件,**官方指名以 Redis 為儲存**——與新棧的 Redis 及 14 文件的 chunk-log 設計同路數。
- **MCP**:`createMCPClient`(tools / resources / prompts / elicitation),HTTP transport 建議生產使用(stdio 仍 experimental);v7 另有 MCP Apps(模型可見 / app-only 工具分離、沙箱 iframe 渲染)。
- **Provider 抽象**:業界最廣的官方 provider 矩陣;v7 把 reasoning 參數做成 provider-agnostic 頂層選項(OpenAI / Anthropic / Google / Groq / xAI / Bedrock⋯)。
- **限制**:**沒有 multi-agent 圖原語**(edges / 平行節點 / conditional routing 要自建 orchestrator);**沒有跨對話 memory**;token usage 有標準欄位但計費級校正(Vertex undercount、Bedrock additive cache,見 04 文件)仍要自帶。
- **工程要求**:v7 要 **Node 22+、ESM-only**;與 Hono(Web 標準 Response)、Next.js(`useChat` / `DirectChatTransport`)是四者中整合最無縫的。維護狀態:Vercel 主力,發版極快(v5→v7 約 18 個月)。

## 能力對照矩陣

需求維度取自 LibreChat 各子系統的實際依賴(括號為對應文件)。標記:✅ 內建/官方套件、🔶 部分支援或需組裝、🛠 需自建。

| 能力需求 | LangGraph 1.4 | LangChain 1.5 (createAgent) | deepagents 1.10 | AI SDK 7 |
|---|---|---|---|---|
| **Agent loop + 步數上限**(04) | ✅ 自建圖 + `recursionLimit`(LibreChat 現制) | ✅ 內建 loop,底層同 recursionLimit | ✅ 同左,harness 預組好 | ✅ `stopWhen: stepCountIs(N)` + `prepareStep` |
| **Tool calling**(07) | ✅ ToolNode / 自訂節點,LangChain tool 生態 | ✅ Zod schema tools + retry middleware | ✅ 同左 + 內建 filesystem/task 工具組 | ✅ `tool()` + typed `contextSchema`,per-tool timeout |
| **多代理 graph / handoff / 平行**(05) | ✅ 原生:任意拓撲、subgraph、conditional edges——LibreChat edges 即此 | 🔶 單 agent 為主;多代理需下探 LangGraph 或以 subagent middleware 組 | 🔶 subagent 委派內建;**圖狀 handoff 拓撲**仍要下探 LangGraph | 🛠 無圖原語;handoff-as-tool + 自建 orchestrator(`prepareStep` 可做輕量版) |
| **Subagents(隔離 context spawn)**(05) | 🔶 subgraph + 自建 spawn 邏輯 | 🔶 用 deepagents 的 `createSubAgentMiddleware` | ✅ 內建 `task` 工具,ephemeral 隔離 | 🔶 tool 的 execute 內再跑一個 agent(模式簡單但 usage 回流自理) |
| **HITL interrupt / resume**(14) | ✅ `interrupt()` + `Command({resume})` + checkpointer,跨 process resume | ✅ `humanInTheLoopMiddleware` 開箱 | ✅ `interruptOn` 參數開箱 | ✅ v7 tool approvals(policy 級)+ `WorkflowAgent` durable resume;或無-`execute` tool 模式自建 |
| **Checkpoint 持久化(Postgres/Redis)**(14) | ✅ 官方 `PostgresSaver` 1.0.4 / `RedisSaver` 1.0.10 | ✅ 同左(回傳物即 LangGraph 圖) | ✅ 同左 | 🔶 messages 陣列即狀態,自行存 PG(簡單透明);`WorkflowAgent` 有自己的 durable storage 抽象 |
| **Streaming 事件粒度**(04/14) | ✅ 六種 streamMode 可疊加 + `streamEvents` + subgraph namespace | ✅ `streamEvents({version:'v3'})` | ✅ 同左 | ✅ `fullStream` parts + UIMessage stream 協定(前端協定是四者中最完整) |
| **可恢復串流(斷線重連)**(14) | 🛠 自建 job store + replay(LibreChat 現制,可照抄) | 🛠 同左 | 🛠 同左 | 🔶 官方 `resumable-stream` + Redis + `useChat({resume})`;粒度較粗,LibreChat 級的 status/active 查詢仍要自建 |
| **Provider 抽象**(06) | ✅ `@langchain/*` 套件群(LibreChat 同款) | ✅ 同左 + model 字串速記 | ✅ 同左 | ✅ 最廣 provider 矩陣 + provider-agnostic reasoning/usage 欄位 |
| **MCP**(08) | ✅ `@langchain/mcp-adapters` 1.1.3 | ✅ 同左 | ✅ 同左 | ✅ `createMCPClient`(tools/resources/prompts/elicitation)+ MCP Apps |
| **Memory(跨對話)**(12) | 🔶 LangGraph Store(BaseStore,cross-thread) | 🔶 同左 | ✅ `AGENTS.md` 記憶 + `createMemoryMiddleware` | 🛠 無;LibreChat 的 DB key-value 記憶本就框架中立,自建成本低 |
| **Context 管理(summarization/pruning)**(04) | 🛠 自建節點(LibreChat 的 summarize 節點在 SDK 層) | ✅ `createSummarizationMiddleware` | ✅ 內建自動壓縮 + 大結果 offload | 🔶 `prepareStep` 手動 compaction(時機自控) |
| **Token usage 追蹤 / 計費**(04) | ✅ `usage_metadata`(含 cache 細目);計費校正自帶 | ✅ 同左 | ✅ 同左 | ✅ per-step `usage` + `totalUsage`;計費校正同樣自帶 |
| **Structured output** | 🔶 model 層 `withStructuredOutput` / 自建節點 | ✅ `responseFormat` + Zod → `structuredResponse` | ✅ 同左 | ✅ `generateObject` / `streamObject` + 強化的 schema 驗證與 JSON 修復(v7) |
| **Observability** | ✅ LangSmith 原生(LibreChat 另掛 Langfuse) | ✅ 同左 | ✅ 同左 | ✅ v7 `registerTelemetry()` + `@ai-sdk/otel`(OTel 標準,對接 Langfuse 等) |

**無論選誰都要自建的**(框架中立,LibreChat 對應文件直接適用):生成 job 與 HTTP 解耦的 job store / SSE 訂閱 / abort / 世代 CAS(14)、計費 transactions + balance(04)、權限 RBAC × ACL(16)、認證(17)、對話樹(15)、檔案(13)、RAG(10)、沙箱(11)、config 系統(02)。**框架選型只決定「執行核心 + HITL + 多代理」這一段,大約是全系統的三分之一。**

## 與 LibreChat 架構的距離

### `@librechat/agents` = LangGraph 封裝的意涵

LibreChat 的執行核心不是自己寫的 loop,而是 `@librechat/agents`(3.2.57)——它直接依賴 `@langchain/langgraph@^1.4.6` 與整套 `@langchain/*` provider 套件。這代表:

- LibreChat 04 文件描述的一切執行語義——`thread_id` / `configurable`、`streamEvents(version:'v2')`、`recursionLimit`、`interrupt()` + checkpointer rehydrate、multi-agent 圖編譯——**就是 LangGraph 的公開 API 語義**,不是 LibreChat 私有發明。
- 選 LangGraph 系時,LibreChat host 層(request.js / client.js / callbacks.js)+ `@librechat/agents` SDK 源碼合起來,是一套「同框架、生產驗證過」的完整參考:事件映射表怎麼設計、checkpoint 什麼時候 prune、resume 怎麼用空 messages 重建圖,全部可以照讀照搬。
- 選 ai-sdk 時,這些變成「設計參考」:概念(job 世代 CAS、先落盤再 emit、雙重扣款防護)完全可移植,但程式碼要換 primitives 重寫。

### 選各框架時,01~18 文件的可參考度

| 文件 | LangGraph 系(LangGraph / LangChain / deepagents) | AI SDK |
|---|---|---|
| 04 執行引擎 | **程式碼級參考**:createRun 橋接、GraphEvents handler 表、recursionLimit 決議可近乎照搬 | 「Vercel AI SDK 對應」章節就是實作藍圖:`fullStream` part ↔ GraphEvents 對照表已寫好 |
| 05 多代理 | **直接參考**:edges/handoff/subagent 的圖編譯就在同一框架 | 要自建 orchestrator;文件的「handoff-as-tool + 外層 loop」建議即起點 |
| 14 串流與可恢復性 | HITL 章節(pause snapshot、fingerprint、checkpoint 三方共管)直接適用;job store 照抄 | job store 照抄;HITL 改走「messages 即狀態」路線,文件已論證這簡單一個數量級 |
| 06 Provider | `@langchain/*` 套件同款,參數轉換層直接參考 | 換成 ai-sdk provider registry;宣告式模型能力/價格表的建議不變 |
| 07/08 工具與 MCP | 工具兩階段載入、`_mcp_` 命名、連線治理可沿用(MCP 治理層本就自建於 `@modelcontextprotocol/sdk`) | 同左——MCP 治理層框架中立;工具定義層換 `tool()` + `createMCPClient` |
| 12 記憶 | 可比較 LangGraph Store vs LibreChat 的 DB key-value(後者更簡單) | LibreChat 做法直接搬(本就不依賴框架) |
| 02/03/09~11/13/15~18 | **框架無關**,兩邊等值適用 | 同左 |

**距離總結**:LangGraph 系的「距離」最短——LibreChat 已經付過的抽象稅(host 概念 ↔ 圖概念的翻譯層)有現成答案;代價是把那筆抽象稅也一起繼承。ai-sdk 的距離較長——多代理圖、memory、HITL 週邊要自建;回報是狀態模型透明(messages 陣列 vs 序列化 checkpoint)、與 Hono/Next.js/Redis 的整合最省,且 04/14 文件已指出 LibreChat 相當比例的複雜度(checkpoint 生命週期三方共管、resume 重建圖)正是圖框架的代價,換 ai-sdk 時自然消失。

## 組合可能性

框架不是單選題,常見的務實組合:

1. **ai-sdk 當 provider 層 + 自建薄 loop**:只用 `streamText` / provider 套件 / UIMessage 協定,agent loop 與狀態機自己寫(反正 job store 一定自建)。適合「需求邊界清楚、拒絕框架鎖定」的團隊;風險是逐步重造 LangGraph 已解的問題(平行、interrupt 語義)。
2. **LangGraph 做編排 + ai-sdk 做 UI 串流協定**:圖負責執行與 HITL,把 `streamEvents` 橋接成 UIMessage stream parts 餵給 `useChat`(或用 `@langchain/langgraph-sdk` 的 `useStream`)。取兩者所長,但要自維護一層事件轉換器——LibreChat 的 callbacks.js 證明這層不小。
3. **deepagents 起步、逐步 eject**:`createDeepAgent` 直接得到 planning/filesystem/subagents/HITL,PoC 最快;因為回傳物就是 LangGraph 圖、middleware 可拆,後期可逐項替換成 `createAgent` + 自選 middleware,再必要時下探 StateGraph。**同一基底、三個抽象層級之間是滑軌不是牆**——這是 LangGraph 系相對 ai-sdk 的結構性優勢。
4. **ai-sdk 全家桶 + WorkflowAgent 承擔 HITL/durability**:純 Vercel 路線,`resumable-stream` + Redis、approvals、`@ai-sdk/otel` 全用官方件;multi-agent 需求出現時再評估是否引入圖(屆時 messages-as-state 遷移到任何框架都容易)。

不建議的組合:LangChain 與 ai-sdk 的 model 層互套(兩套 message 型別互轉的膠水成本高於收益);在 ai-sdk 外面再包一層自製「圖 DSL」(等於重寫 LangGraph)。

## 選型建議(決策樹)

```
需要「圖狀」多代理拓撲嗎?(edges/平行節點/conditional routing——LibreChat 05 那種)
├─ 是,且是核心需求
│    └─ LangGraph 系。再問:要多少開箱能力?
│         ├─ 產品形態接近「規劃-執行-委派」harness(Claude Code 式)→ deepagents 起步(組合 3)
│         ├─ 要 middleware 生態但保留控制權 → LangChain createAgent,必要時 eject 到 StateGraph
│         └─ 拓撲高度客製(LibreChat 重建即此)→ 直接 LangGraph + 參考 @librechat/agents 源碼
├─ 否/不確定(單 agent + subagent spawn 就夠)
│    └─ 再問:HITL 要「跨 replica、長暫停、政策化審批」嗎?
│         ├─ 要,且想要現成的 → LangGraph 系(interrupt + PostgresSaver 最成熟)
│         │   或 ai-sdk v7(approvals + WorkflowAgent,較新但官方一級支援)
│         └─ 「工具核准」等級即可 → ai-sdk(無-execute tool / approvals + PG 存 messages,最透明)
└─ 團隊偏好:
     ├─ 輕量、TS/Web 標準至上、Next.js UI 深整合、抗拒抽象稅 → ai-sdk
     └─ 全家桶、要官方解決 context/planning/memory、接受 LangChain 生態 → LangGraph 系
```

補充判斷因子:

- **參考資產**:重建 LibreChat 級功能且時程緊 → LangGraph 系可直接搬 04/05/14 的實作;願意換取更簡單的狀態模型 → ai-sdk 沿各文件「移植建議」重建。
- **鎖定風險對稱性**:ai-sdk 的狀態是 messages 陣列,遷出容易;LangGraph 的狀態是 checkpointer 序列化 blob,遷出等於重寫 HITL。反向地,ai-sdk 缺圖原語,需求長出圖時要補課。
- **工程約束**:AI SDK 7 要 Node 22+ / ESM-only;LangGraph 系無此硬性要求但依賴樹大得多。
- **不必急著全域定案**:job store、計費、權限、RAG 等(全系統約三分之二)框架中立,可先動工;執行核心保持一個薄介面(輸入 messages + tools,輸出事件流 + usage),四個候選都能塞進去。

## 出處

版本號均為 2026-07-02 npm registry 查證(`latest` dist-tag)。

- LangGraph JS:`@langchain/langgraph` 1.4.7;persistence/checkpointers/streaming/interrupts 官方文件——https://docs.langchain.com/oss/javascript/langgraph/persistence 、https://docs.langchain.com/oss/javascript/langgraph/checkpointers 、https://docs.langchain.com/oss/javascript/langgraph/streaming 、https://docs.langchain.com/oss/javascript/langgraph/interrupts ;checkpointer 套件:`@langchain/langgraph-checkpoint-postgres` 1.0.4、`@langchain/langgraph-checkpoint-redis` 1.0.10、`@langchain/langgraph-checkpoint-mongodb` 1.4.0
- LangChain 1.x JS:`langchain` 1.5.2;Agents 文件 https://docs.langchain.com/oss/javascript/langchain/agents ;`createAgent` reference https://reference.langchain.com/javascript/langchain/index/createAgent ;MCP:`@langchain/mcp-adapters` 1.1.3
- deepagents JS:`deepagents` 1.10.5(repo https://github.com/langchain-ai/deepagentsjs );overview https://docs.langchain.com/oss/javascript/deepagents/overview ;API reference https://reference.langchain.com/javascript/deepagents
- Vercel AI SDK:`ai` 7.0.11(維護線 `ai-v6` 6.0.218、`ai-v5` 5.0.209);AI SDK 7 changelog https://vercel.com/changelog/ai-sdk-7 ;Agents overview / loop control https://ai-sdk.dev/docs/agents/overview 、https://ai-sdk.dev/docs/agents/loop-control ;resumable streams https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams ;MCP https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools 、https://ai-sdk.dev/docs/reference/ai-sdk-core/create-mcp-client
- LibreChat 依賴鏈:`api/package.json` 與 `packages/api/package.json`(`@librechat/agents` ^3.2.57);`@librechat/agents@3.2.57` npm 依賴表(`@langchain/langgraph` ^1.4.6);本系列 04-execution-engine.md、14-streaming-resumability.md
