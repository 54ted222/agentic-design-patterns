# 05. 多代理協作

## 定位

LibreChat 的多代理子系統解決一個問題:**單一 agent 的工具迴圈不夠用時,如何讓多個 agent 在一次對話回合(run)中分工**。它提供三種互補機制:

| 機制 | 形態 | 狀態 |
|---|---|---|
| **edges 有向圖** | agent 之間的 handoff / direct / condition 邊,編譯成一張 LangGraph StateGraph | 現行主力 |
| **subagents** | 把其他 agent(或自己)當成一個 `subagant` spawn 工具,在**隔離的 context window** 裡跑一個子 run,只回傳摘要 | 現行主力 |
| **sequential chain(`agent_ids`)** | 依序執行的 agent 清單,底層被翻譯成一串 direct edge | **deprecated**,僅向後相容 |

在整體架構中,它位於「初始化」與「執行」之間:agent 文件(MongoDB)描述靜態拓撲 → 後端在每次請求時做**發掘(discovery)、權限檢查、圖修剪(pruning)** → 產出乾淨的 agent 集合 + 邊集合交給 `@librechat/agents` SDK 的 `Run.create` 編譯成 LangGraph。執行迴圈、事件流與 HITL 屬於其他文件範圍(見 04-execution-engine.md、14-streaming-resumability.md);本章專注拓撲的建構、驗證與路由語意。

## 核心概念

- **GraphEdge**:一條有向邊 `{ from, to, edgeType, condition, prompt, ... }`。`from`/`to` 都可以是單一 agent id 或 id 陣列(`packages/data-provider/src/types/agents.ts:647-677`)。
- **handoff 邊**:`edgeType: 'handoff'`(預設)。SDK 會為 `from` agent 生成一個名為 `lc_transfer_to_<agentId>` 的**工具**(前綴常數 `Constants.LC_TRANSFER_TO_`,`packages/data-provider/src/config.ts:2666`),LLM 呼叫該工具即把控制權移交給目標 agent — 這是「動態路由」:是否移交由模型在執行期決定。
- **direct 邊**:無條件直連。SDK 的 `MultiAgentGraph.createWorkflow` 對每個 `from` 來源呼叫一次 `builder.addEdge(src, dest)`,因此 direct 邊也天然支援**平行執行**(多個無入邊的起點會同時跑)。
- **condition**:`(state) => boolean | string | string[]` — 執行期依 graph state 決定要不要走、或走到哪些目的地。因為是 function,**無法持久化到 DB**,只能在程式端組圖時使用。
- **multi-source 邊的 OR 語意**:`{ from: ['A','B'], to: 'C' }` 實際是 `A→C` **或** `B→C`(每個 source 各自一條 LangGraph 邊),不是「A 與 B 都完成才到 C」。這個語意貫穿所有修剪邏輯(`packages/api/src/agents/discovery.ts:341-397`)。
- **起點(start node)語意**:SDK 的 `MultiAgentGraph.analyzeGraph` 把「沒有入邊的 agent」視為起點,與 primary agent **平行執行**。使用者可以刻意宣告兩條獨立分支。
- **subagent**:與 edges 完全不同的機制 — 不是圖上的節點,而是一個 spawn 工具(工具名 `subagent`,`config.ts:2674`)。子 agent 在**隔離的 child graph** 中執行,冗長的工具輸出留在子 context,只有摘要回到父 context。支援 `self` spawn(自己派生自己處理子任務)。
- **sequential chain**:舊版「Agent Chain」。agent 文件上的 `agent_ids: string[]` 依序串接,執行時被翻譯成一串帶 prompt 模板的 direct edge(`packages/api/src/agents/chain.ts:15`)。
- **hide_sequential_outputs**:chain 專用的 UX 旗標 — 中間 agent 的輸出「計費但不顯示、不持久化」,只有最後一個 agent 的輸出成為可見回覆。

## 架構與流程

```
Agent 文件 (MongoDB: edges / agent_ids / subagents)
        │
        ▼
initializeAgent(primary)                       api/server/services/Endpoints/agents/initialize.js:393
        │
        ▼
discoverConnectedAgents (BFS)                  packages/api/src/agents/discovery.ts:144
  │  ├─ 每個候選 agent: getAgent → VIEW 權限 → validateAgentModel → initializeAgent
  │  ├─ createEdgeCollector: 邊去重 + 蒐集新 agent          edges.ts:137
  │  ├─ (deprecated) agent_ids → createSequentialChainEdges  chain.ts:15
  │  ├─ filterOrphanedEdges: 剔除指向 skipped agent 的端點   edges.ts:89
  │  └─ reachability pruning: 區分「意外孤兒」vs「刻意平行起點」
        │
        ▼
subagent 樹解析 (loadSubagentsFor / resolveSubagentTrees)   initialize.js:760, 846
  │  ├─ 深度/節點數上限、循環守衛
  │  └─ pure subagents 從 agentConfigs 移除(不進 LangGraph)
        │
        ▼
createRun                                       packages/api/src/agents/run.ts:872
  │  ├─ buildSubagentConfigs: 遞迴展開 spawn 目標(再驗一次深度/數量)  run.ts:767
  │  └─ graphConfig.type = 'multi-agent'(多 agent 或有邊)否則 'standard'  run.ts:1149-1153
        │
        ▼
@librechat/agents Run.create → MultiAgentGraph → LangGraph StateGraph
  ├─ handoff 邊 → lc_transfer_to_<id> 工具(模型決定路由)
  ├─ direct 邊 → addEdge(平行/串行皆可)
  └─ subagentConfigs → `subagent` spawn 工具(隔離 child run)
```

### discoverConnectedAgents:BFS 發掘與權限檢查

進入點在 `packages/api/src/agents/discovery.ts:144`。流程:

1. **種子**:`collectEdges(primaryConfig.edges)` 把 primary 的邊丟進 `createEdgeCollector`(`edges.ts:137`)。collector 用 `getEdgeKey`(排序後的 from/to + edgeType,`edges.ts:7`)去重,並把邊上出現、但尚未初始化的 agent id 放進 `agentsToProcess`。
2. **BFS 迴圈**(`discovery.ts:299-311`):每取出一個 id 就跑 `processAgent`:
   - `getAgent({ id })` 撈 DB,不存在 → 記入 `skippedAgentIds`(孤兒引用)。
   - **權限檢查**(`discovery.ts:211-225`):對每個 sub-agent 檢查目前使用者的 `PermissionBits.VIEW`。`resourceType` 可注入 — 站內聊天用 `AGENT`,OpenAI 相容 / Responses API 入口用 `REMOTE_AGENT`(`api/server/controllers/agents/responses.js:511-514`),確保 sub-agent 不會繞過該路由對 primary 施加的分享邊界。無權限 → skip,不是報錯。
   - `validateAgentModel` 驗證模型是否在允許清單(這個失敗會 throw,由迴圈 catch 後 markSkipped)。
   - `initializeAgent` 完整初始化(工具、檔案、skills…),且**強制 `endpoint: agents`**(`discovery.ts:248-251`)讓 `allowedProviders` 白名單一定生效 — 否則 OpenAI 相容入口的 sub-agent 會靜默繞過 provider 白名單。
   - 成功的 agent 若自己也有 `edges`,再 `collectEdges(agent.edges)` — BFS 就此遞迴展開 `A → B → C`。
3. **deprecated chain**(`discovery.ts:313-336`):若請求帶了 `agent_ids`,逐一初始化,然後呼叫 `createSequentialChainEdges([primary, ...agent_ids])` 生成串接的 direct 邊,一起丟給 collector。
4. **孤兒修剪**,見下節。
5. 回傳 `{ agentConfigs, edges, skippedAgentIds, userMCPAuthMap }` — 其中 `userMCPAuthMap` 是 primary + 所有 sub-agent 的 MCP 認證 map 合併(先淺拷貝再 merge,避免污染呼叫端物件,`discovery.ts:182-185, 275-282`)。

### filterOrphanedEdges 與 reachability pruning

修剪分兩階段,目標是保證 **`StateGraph.compile` 永遠不會看到指向不存在節點的邊**(否則 SDK 直接丟 `Found edge ending at unknown node`):

**第一階段 — `filterOrphanedEdges`**(`packages/api/src/agents/edges.ts:89`):把 `skippedAgentIds` 中的 id 從每條邊的端點剔除。對陣列端點是「剝除成員」而非丟棄整條邊(`{ from:['A','B'], to:'C' }`、B 被 skip → `{ from:['A'], to:'C' }`),呼應 SDK 每個 source 一條 addEdge 的語意;只有當某一側完全清空才丟棄整條邊。

**第二階段 — 可達性修剪**(`discovery.ts:341-487`),要同時處理兩種語意:

- **意外孤兒**:`A → B → C`,B 被 skip 後 C 失去唯一路徑。若留著 C,SDK 的 `analyzeGraph` 會把它當無入邊起點、**意外平行執行** — 必須剪掉。
- **刻意平行起點**:使用者明確定義 `A → B` 加上獨立的 `X → Y` 兩條分支 — 必須保留。

區分準則是:「**該 agent 在使用者原始(pre-filter)圖裡有沒有入邊**」(`discovery.ts:419-436`)。沒有入邊 = 使用者宣告的起點,列入可達性種子;有入邊但過濾後失去 = 意外孤兒,剪除。注意這比「pre-filter 從 primary 可達」更嚴格:`X → Y` 中 X 被 skip 時,Y 從 primary 本來就不可達,但它有入邊,所以正確地被判為孤兒。

之後從種子(primary + 無入邊 agent)沿邊做固定點展開(`expandReachable`,任一 source 可達即前進,OR 語意),保留「至少一個 source 可達 **且** 每個 destination 都可達」的邊,並把 multi-source 邊裡不可達的 co-source 剝掉(`discovery.ts:466-481`)— 死掉的 co-source 若留著,會在 SDK 端變成無入邊節點、又跑成意外平行根。最後把不可達的 agent 從 `agentConfigs` 刪除(`discovery.ts:483-487`)。

### 路由:圖如何執行

編譯後的 run 由 `graphConfig.edges = agents[0].edges` 驅動(`run.ts:1143-1147`,只取 primary 上已合併好的邊集合)。路由分三種:

- **handoff**:`from` agent 的工具清單多出 `lc_transfer_to_<to>`。`GraphEdge.prompt`(字串)在 handoff 邊上是這個工具**輸入參數的描述**,參數名由 `promptKey` 客製(預設 `instructions`)— 讓上游 agent 移交時附帶指示(`types/agents.ts:657-676`)。
- **direct**:圖編譯期就接死。`prompt` 在 direct 邊上是**過場注入**:可以是含 `{results}` 變數的字串,或 `(messages, runStartIndex) => string` 函式;`excludeResults: true` 時,下游 agent 看不到上游原始訊息、只看到 prompt 產出(chain 就靠這個做「摘要接力」)。
- **condition**:執行期回傳 boolean(走/不走)或具體目的地 id(動態多路)。

**recursion_limit**(agent 欄位,`types/assistants.ts:289`)限制 LangGraph 的步數,是多代理圖防失控的最外層護欄(`client.js:1353` 的 `resolveRecursionLimit`)。

### subagents:隔離 context 的子代理

與 edges 正交的機制,資料來源是 agent 文件上的 `subagents: { enabled, allowSelf, agent_ids }`(`packages/data-provider/src/types/assistants.ts:254-260`)。載入分兩層:

**載入期(initialize.js:574-887)**:`resolveSubagentTrees` 以 BFS 走訪 primary + 所有 handoff agent 的 `subagents.agent_ids`,對每個目標跑 `loadAgentById`(同樣的 DB → VIEW 權限 → 模型驗證 → initializeAgent 流程,`initialize.js:611-723`),掛到 `config.subagentAgentConfigs`。守衛:

- `MAX_SUBAGENT_GRAPH_NODES = 50`:全 run 唯一 subagent 目標數上限(`config.ts:2681`、`initialize.js:735-750`)。
- `MAX_SUBAGENT_DEPTH = 5`:巢狀委派深度上限(`config.ts:2678`),且以「最深可達路徑」重複檢查同一 config(`initialize.js:840-863`)。
- 循環守衛:subagent 指回 primary 時直接重用 primary config,不重複載入(`initialize.js:815-823`)。
- **pure subagent**(只被當 subagent 引用、不在任何邊上的 agent)最後從 `agentConfigs` 刪除(`initialize.js:867-872`)— 否則 LangGraph 會把它當平行起點;但保留在 `agentToolContexts`,子 run 的工具執行仍需要它的資源脈絡。
- 端點 capability(`AgentCapabilities.subagents`)關閉時,**每個** config 的 `subagents` 都被 strip(`initialize.js:882-887`)— 不只 primary,因為 `run.ts` 會對 agents 陣列中每一個呼叫 `buildSubagentConfigs`。

**展開期(run.ts:767-855)**:`buildSubagentConfigs` 把載好的 config 遞迴轉成 SDK 的 `SubagentConfig[]`:

- `allowSelf !== false` 時先放一個 `{ self: true, type: 'self' }` 項目(`run.ts:780-790`)— 模型可以把自己派生到隔離 context 處理子任務,「冗長的工具輸出留在子 context,只回摘要」。
- 每個子 agent 經 `toInput(child, { isSubagent: true })` 轉成 `AgentInputs`,再**遞迴**解析孫代(`run.ts:833-842`)讓 `A → B → C` 多層委派可用;`ancestors` set 擋 `A → B → A` 循環(`run.ts:797-806`)。
- 兩個護欄函式在展開時逐項執行:`countSubagentConfig`(總展開數 ≤ `MAX_SUBAGENT_RUN_CONFIGS = 100`,`run.ts:666-678`)與 `assertSubagentDepth`(深度 ≤ 5,`run.ts:680-691`)。超限直接 throw — 載入期已擋一次,這裡是防「同一 agent 在多個父節點下重複展開」造成的組合爆炸。

**隔離語意**(`run.ts:1057-1092, 1118`):`isSubagent` 時 (1) 不繼承父 run 的 `initialSummary` 與 tool-search 發現狀態;(2) `toolRegistry` 做「Map + 每個 tool 物件」的雙層淺拷貝,避免父圖後續對 `defer_loading` 的原地修改寫穿到子代理已握有的引用。

**獨立計費**:子 graph 在父 run 的 `streamEvents` 迴圈之外執行,`ModelEndHandler` 看不到它們的模型呼叫。SDK 改經 `subagentUsageSink` 回報(`run.ts:924-932`);host 端 `createSubagentUsageSink`(`packages/api/src/agents/usage.ts:716-743`)把每筆標成 `usage_type: 'subagent'`、附上 `agentId`(子代理可能在不同 endpoint、不同費率),推進同一個 `collectedUsage`。`recordCollectedUsage` 對 subagent 組**全額扣款但不計入回覆的 output 總數**(`usage.ts:666`)— 因為 output 總數會變成父回覆訊息的 `tokenCount`,子代理的輸出父層根本沒看到,混入會讓下一輪 context 計算失真好幾個量級。子代理的完整活動軌跡(reasoning / 工具呼叫 / 最終文字)另經 `ON_SUBAGENT_UPDATE` 事件聚合,存到父訊息 `subagent` tool_call 的 `subagent_content` 上,重新整理頁面後仍可展開(`client.js:206-234`、`callbacks.js:454-501`)。

### sequential chain(deprecated)

`createSequentialChainEdges(agentIds, template)`(`chain.ts:15-47`)把 `[primary, ...agent_ids]` 兩兩串成 direct 邊,每條邊帶:

- `prompt`:一個 async function,把本 run 的訊息(`messages.slice(startIndex)`)用 `getBufferString` 攤平成對話文字,填進模板 `{convo}`;
- `excludeResults: true`:**關鍵** — 下游 agent 只看到 prompt 產出,不看到上游原始訊息。

`hide_sequential_outputs` 的落地全在 host 端事件層(`api/server/controllers/agents/callbacks.js`):

- `checkIfLastAgent(last_agent_id, langgraph_node)` 用「目前 LangGraph 節點名是否以最後一個 agent id 結尾」判斷是否為鏈尾(`callbacks.js:204-209`);`last_agent_id` 在 run 前寫進 `config.configurable`(`client.js:1612`),`hide_sequential_outputs` 也是(`client.js:1345`)。
- `ON_RUN_STEP` / `ON_MESSAGE_DELTA` / `ON_REASONING_DELTA` / `ON_RUN_STEP_COMPLETED` / `ON_CONTEXT_USAGE` / `ON_SUBAGENT_UPDATE` 每個 handler 都套同一條規則:鏈尾或未隱藏 → 照發;隱藏的中間步驟 → 只發 `on_agent_update` 的「`<Agent> is thinking...`」狀態訊息(`callbacks.js:351-379`)。
- **計費面**:中間 agent 的 usage 標 `usage_type: 'sequential'`(`callbacks.js:119-129`),照樣扣款、但不計入 output 總數(`usage.ts:667`)。
- **持久化面**:`applyHideSequentialOutputsFilter`(`client.js:1183-1193`)在存檔前把 contentParts 過濾成「最後一段 + tool_call 部分」,HITL resume 路徑也做同樣過濾(`client.js:1964-1968`),避免恢復執行時把該隱藏的中間輸出存進 DB。

### 建立/更新時的引用驗證

執行期檢查之外,agent CRUD 也擋一層(`api/server/controllers/agents/v1.js`):

- `validateEdgeAgentAccess`(`v1.js:149`):邊引用的每個 agent 需要 VIEW;**不存在的 id 不算錯** — 建立當下 `from` 常自引用尚未存在的自己。
- `validateSubagentReferences`(`v1.js:168`):比 edges 嚴格,missing 與 unauthorized 都是錯 — subagent 不可能自引用,missing 一定是打錯字或已刪除的 agent,放行會讓持久化設定與實際 spawn 目標靜默脫鉤。

前端 UI(`client/src/components/SidePanel/Agents/Advanced/`)只會產生最簡單的邊:`{ from: 當前agent, to: 目標, edgeType: 'handoff' }`(`AgentHandoffs.tsx:71-73`);multi-source、direct、condition 都是 API 層能力,UI 尚未暴露。

## 關鍵資料結構

### GraphEdge(`packages/data-provider/src/types/agents.ts:647-677`)

| 欄位 | 型別 | 用途 |
|---|---|---|
| `from` | `string \| string[]` | 來源 agent id;陣列 = OR 語意(每個 source 各一條邊) |
| `to` | `string \| string[]` | 目的 agent id;陣列 = 每個 destination 各一條邊 |
| `edgeType` | `'handoff' \| 'direct'` | 預設 handoff(生成 transfer 工具);direct 直連、支援平行 |
| `condition` | `(state) => boolean \| string \| string[]` | 執行期路由;function,**不可持久化** |
| `prompt` | `string \| (messages, startIndex) => string` | direct:過場注入(支援 `{results}`);handoff:transfer 工具輸入參數的描述 |
| `excludeResults` | `boolean` | true 時下游只看 prompt、不看上游訊息;prompt 用了 `{results}` 時自動為 true |
| `promptKey` | `string` | handoff 工具輸入參數名,預設 `instructions` |
| `description` | `string` | 說明文字 |

### AgentSubagentsConfig(`packages/data-provider/src/types/assistants.ts:254-260`)

| 欄位 | 型別 | 用途 |
|---|---|---|
| `enabled` | `boolean` | 是否掛 `subagent` spawn 工具 |
| `allowSelf` | `boolean` | 預設 true;允許把自己 spawn 進隔離 context |
| `agent_ids` | `string[]` | 明確的可 spawn 目標(需 VIEW 權限、存在性驗證) |

### Agent 文件上的協作欄位(`types/assistants.ts:283-304`、Mongo schema `packages/data-schemas/src/schema/agent.ts:71-127`)

| 欄位 | 型別 | 用途 |
|---|---|---|
| `edges` | `GraphEdge[]`(Mongo 存 `Mixed`) | 有向圖拓撲;有 `{ 'edges.to': 1 }` 索引(`agent.ts:140`)供反向查詢 |
| `agent_ids` | `string[]` | **deprecated** sequential chain |
| `subagents` | `AgentSubagentsConfig`(Mongo 存 `Mixed`) | spawn 設定 |
| `hide_sequential_outputs` | `boolean` | chain 中間輸出隱藏 |
| `recursion_limit` | `number` | LangGraph 步數上限 |

### 執行期限制常數(`packages/data-provider/src/config.ts:2677-2684`)

| 常數 | 值 | 檢查點 |
|---|---|---|
| `MAX_SUBAGENT_DEPTH` | 5 | 載入期(initialize.js:768-806)+ 展開期(run.ts:680) |
| `MAX_SUBAGENT_GRAPH_NODES` | 50 | 載入期唯一目標數(initialize.js:735) |
| `MAX_SUBAGENT_RUN_CONFIGS` | 100 | 展開期總 SubagentConfig 數(run.ts:666)— 擋重複展開的組合爆炸 |

### DiscoverConnectedAgentsResult(`discovery.ts:122-131`)

| 欄位 | 型別 | 用途 |
|---|---|---|
| `agentConfigs` | `Map<string, InitializedAgent>` | 修剪後的 sub-agent 初始化結果 |
| `edges` | `GraphEdge[]` | 去重、去孤兒、可達性修剪後的邊 |
| `skippedAgentIds` | `Set<string>` | 找不到或無權限的 id(供後續 subagent 載入短路) |
| `userMCPAuthMap` | `Record<string, Record<string,string>>` | 全體 agent 的 MCP 認證合併 |

### SubagentUsageEvent(`packages/api/src/agents/usage.ts:689-704`)

| 欄位 | 用途 |
|---|---|
| `usage` | 子 run 單次模型呼叫的 UsageMetadata |
| `model` / `provider` | 產生該筆用量的模型與供應商 |
| `subagentType` / `subagentRunId` / `subagentAgentId` | spawn 目標識別、子 run id、子 agent id(用於逐 agent 計價) |
| `runId` | 父 run id |

## 關鍵實作細節與陷阱

1. **權限失敗是 skip 不是 error**。sub-agent 無 VIEW、被刪除、模型不合法都只是從圖上剝掉並記錄 warning(`discovery.ts:192-236`)。這讓「分享出去的 agent 引用了對方看不到的 agent」時對話仍可進行 — 但也意味著拓撲會**靜默降級**,除錯只能靠 log。
2. **resourceType 必須跟入口一致**。Responses/OpenAI 相容路由對 primary 驗 `REMOTE_AGENT`,sub-agent 若只驗 `AGENT` 就是權限繞過(`discovery.ts:57-64`、`responses.js:511-514`)。移植時任何「經由 A 間接載入 B」的路徑都要沿用入口的授權邊界。
3. **sub-agent 一律強制 `endpoint: agents`** 再初始化(`discovery.ts:248-251`),否則 provider 白名單在非 agents 入口不生效。
4. **孤兒修剪的判準是「pre-filter 有無入邊」而非「從 primary 可達」**。用錯判準會把 stranded 下游誤判為平行起點,SDK 會真的把它平行跑起來 — 這是行為 bug 不是編譯錯(`discovery.ts:419-427`)。
5. **multi-source 邊要剝 co-source**。過濾後留著不可達的 co-source,SDK 端它會變成無入邊節點 → 意外平行根(`discovery.ts:447-481`)。
6. **邊去重 key 含 edgeType**(`edges.ts:7-12`):同一對節點可以同時有 handoff 邊和 direct 邊,兩者語意不同、都要保留。
7. **深度/數量限制要在兩個階段都做**。載入期(每個 agent 只載一次)擋不住展開期的組合爆炸:同一個子 agent 被 10 個父節點引用,載入期只算 1 個節點,展開期是 10 個 SubagentConfig。`MAX_SUBAGENT_RUN_CONFIGS` 就是為此存在(`run.ts:666-678`)。
8. **subagent 的隔離必須在來源處做,不能事後清欄位**。`buildAgentInput` 對 `toolRegistry` 有原地副作用(翻轉 `defer_loading`);拿到回傳值再清欄位無法撤銷 registry 寫入,所以用 `isSubagent` 旗標在源頭 gate 整段邏輯,並對子代理 clone「Map + 每個 tool 物件」兩層(`run.ts:811-823, 1073-1092`)。
9. **pure subagent 的雙重身份**:從 `agentConfigs`(圖節點)刪除、但留在 `agentToolContexts`(工具執行脈絡)— 刪錯邊會導致子 run 的 action 工具被跳過或資源範圍錯誤(`initialize.js:574-582, 867-872`)。
10. **capability 關閉要 strip 所有 config**,不只 primary — handoff agent 文件上殘留的 `subagents.enabled: true` 否則仍會在執行期暴露 self-spawn(`initialize.js:876-887`)。
11. **hide_sequential_outputs 是「一致的不記錄規則」**:live 串流、持久化、subagent 軌跡聚合三處都要 gate,漏一處就會出現「當下看不到、重新整理後看到」的洩漏(`callbacks.js:471-483`、`client.js:1183`)。
12. **隱藏 ≠ 免費**:`sequential` 與 `subagent` 用量都全額扣款,只是不計入回覆訊息的 token 數(`usage.ts:666-667`)。計費和 context 記帳是兩本帳,混用會其中一本失真。
13. **`userMCPAuthMap` 合併時的 mutation 陷阱**:primary 的 map 先淺拷貝、第一個 sub-agent 的 map 也要拷貝後才能當合併目標,否則後續 merge 會原地污染別人的 config(`discovery.ts:182-185, 275-282`)。
14. **Mongo 端 `edges`/`subagents` 都是 `Schema.Types.Mixed`**(`agent.ts:81-84, 124-127`)— 沒有 schema 級驗證,所有防禦(型別、去重、自引用、權限)都在應用層。這是移植時最值得改進的點。

## 設計決策分析

**為什麼三種機制並存?** 這是演進的沉積:chain(最早,線性)→ edges(一般化成任意有向圖,chain 被翻譯成 direct 邊向後相容)→ subagents(解決圖機制解決不了的 **context 隔離**問題)。edges 上的所有 agent 共享同一條訊息流(除非 `excludeResults`),一個查資料的支線 agent 會把幾萬 token 的工具輸出灌進主 context;subagent 把這些留在子 context、只回摘要 — 本質上是 **context 管理工具**,不是路由工具。兩者正交且可組合(handoff 目標自己還能 spawn subagent)。

**為什麼 handoff 用工具實作?** 讓「要不要移交」變成模型的一等決策,不需要另寫 router 節點;工具描述(`prompt`/`promptKey`)天然成為移交協定。代價是路由品質依賴模型的工具選擇能力,且 transfer 工具會佔 prompt 空間。

**為什麼修剪邏輯放在 host 而不是 SDK?** 因為孤兒的成因(DB 缺漏、ACL、模型驗證失敗)只有 host 知道;SDK 的 `StateGraph.compile` 對未知節點是 fail-fast。host 端做 BFS + 兩階段修剪,把「使用者拓撲」轉換成「可編譯拓撲」,並在語意上盡量保留使用者意圖(平行起點)。缺點是這段程式碼複雜度極高 — `discovery.ts` 後半近 150 行都在處理修剪的邊界情況,且行為(靜默降級)不易被使用者察覺。

**若重做會怎麼選?**
- edges 用**關聯表 + 外鍵**存,建立時就擋掉大部分孤兒,執行期修剪可以簡化到只剩 ACL 一種成因。
- `condition` 作為 function 無法持久化,等於是「半個功能」— 重做會定義**可序列化的條件 DSL**(如 JSON 條件表達式)或乾脆只留 handoff(模型路由)+ direct。
- chain 一開始就該是 edges 的語法糖而不是獨立欄位;`hide_sequential_outputs` 散落在六個事件 handler + 兩個持久化點,重做應把「可見性」做成事件管線的單一 middleware。
- subagent 的「self spawn」是高性價比設計(零設定成本的 context 隔離),值得保留。

## 移植到新技術棧的建議

> 技術棧已定:PostgreSQL + Hono + Next.js + Redis(以下 schema / middleware / 前端建議照此)。**AI 框架尚未定案**(四候選:LangGraph / LangChain / deepagents / ai-sdk),涉及框架的部分以條件式呈現,完整比較見 19-framework-options.md。

### PostgreSQL schema 草案

用關聯表取代 Mixed 陣列,把存在性/自引用/去重下沉到 DB:

```sql
CREATE TABLE agent_edges (
  id          BIGSERIAL PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, -- 邊定義在哪個 agent 文件上
  from_ids    TEXT[] NOT NULL,          -- multi-source OR 語意
  to_ids      TEXT[] NOT NULL,
  edge_type   TEXT NOT NULL DEFAULT 'handoff' CHECK (edge_type IN ('handoff','direct')),
  prompt      TEXT,                     -- 僅支援字串模板;function prompt 不持久化
  prompt_key  TEXT DEFAULT 'instructions',
  exclude_results BOOLEAN NOT NULL DEFAULT FALSE,
  condition   JSONB,                    -- 可序列化條件 DSL(取代 LibreChat 的 function)
  UNIQUE (owner_id, from_ids, to_ids, edge_type)  -- 對應 getEdgeKey 去重
);
CREATE INDEX ON agent_edges USING GIN (to_ids);   -- 對應 Mongo 的 { 'edges.to': 1 }

CREATE TABLE agent_subagents (
  parent_id  TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  child_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  PRIMARY KEY (parent_id, child_id),
  CHECK (parent_id <> child_id)         -- 對應 v1.js 的自引用過濾
);
ALTER TABLE agents ADD COLUMN subagents_enabled BOOLEAN NOT NULL DEFAULT FALSE,
                   ADD COLUMN subagents_allow_self BOOLEAN NOT NULL DEFAULT TRUE;

-- 子代理/隱藏中間步驟計費:usage 表帶 usage_type + producing agent
CREATE TYPE usage_type AS ENUM ('message','summarization','subagent','sequential');
-- transactions(usage_type, agent_id, run_id, subagent_run_id, ...)
```

外鍵 `RESTRICT` 讓「刪除仍被引用的 agent」在 DB 層失敗,取代 LibreChat 執行期的 skip;edges 因允許引用尚未存在的自己,可保留應用層驗證(或改成兩段式建立)。

### Hono 對應

- **middleware**:入口授權(對應 `REMOTE_AGENT` vs `AGENT` 的區分)做成參數化 middleware,discovery service 接收同一個 `checkPermission` 閉包 — LibreChat 的 DI 形狀(`DiscoverConnectedAgentsDeps`)直接可搬。
- **route**:`POST /agents`、`PATCH /agents/:id` 內做 edges/subagents 引用驗證(對應 `v1.js:149,168`),用一次 `WHERE id = ANY($1)` 批次查回存在性 + ACL,沿用「edges 容忍 missing、subagents 不容忍」的規則。
- discovery 本身是純函式服務:輸入 primary agent + user,輸出 `{ agents, edges, skipped }`,與框架無關,建議照搬 BFS + 兩階段修剪的結構(這是本章最值得整段移植的邏輯)。

### AI 框架對應(框架未定案)

關鍵不對稱:**LibreChat 的 edges / subagents 就是 `@librechat/agents` 對 LangGraph 的封裝**——選 LangGraph 系(含 LangChain / deepagents)時,本章的拓撲建構、handoff、subagent 隔離幾乎可直接映射甚至照搬;選 ai-sdk 時生態無圖原語,多代理圖須以 tool 包裝或自建 orchestrator。核心機制的框架落點:

| 機制 | LangGraph | LangChain | deepagents | ai-sdk |
|---|---|---|---|---|
| **multi-agent graph / handoff / 平行** | 原生:任意拓撲、subgraph、conditional edges——LibreChat edges 即此,可直接映射 | 單 agent 為主,多代理需下探 LangGraph 或組 subagent middleware | subagent 委派內建,圖狀 handoff 拓撲仍要下探 LangGraph | 無圖原語,自建 orchestrator(handoff-as-tool + 外層 loop;`prepareStep` 可做輕量版) |
| **subagent(隔離 context spawn)** | subgraph + 自建 spawn 邏輯 | 可掛 deepagents 的 `createSubAgentMiddleware` | 內建 `task` 工具 spawn ephemeral subagent,隔離 context 回單一報告 | `spawnSubagent` tool 的 `execute` 內再跑一個 agent,usage 回流自理 |
| **agent loop + 步數上限(對應 `recursion_limit`)** | 自建 StateGraph + `recursionLimit`(LibreChat 現制) | `createAgent` 內建 tool loop,底層同 `recursionLimit` | `createDeepAgent` 預組完整 loop | `stopWhen: stepCountIs(N)` + `prepareStep` 每步調整 |

各機制的移植提示(依所選框架):

- **handoff**:
  - LangGraph 系:直接沿用 LibreChat 現制——每條 handoff 邊生成 `lc_transfer_to_<id>` 工具,由模型決定移交,拓撲交給 StateGraph。
  - ai-sdk:為每條 handoff 邊生成 `transfer_to_<id>` tool(對應 `lc_transfer_to_`),tool 的 `execute` 不做事、只回傳路由訊號;外層 loop 收到後**切換 active agent**(換 system prompt + tools + model),繼續同一條訊息流。`prepareStep` 可以在單一 `generateText`/`streamText` 迴圈內動態換 model/tools,是輕量 handoff 的自然落點;`stopWhen` 對應 `recursion_limit`。
- **direct 邊 / chain**:兩系都不該為它引入重機制。LangGraph 系用原生 `addEdge` 表達(即 LibreChat 把 chain 翻譯成 direct 邊的做法);ai-sdk 直接在程式層 orchestration,依 topological order 逐個 `streamText`,把上一步輸出經模板(對應 `prompt` + `excludeResults`)餵給下一步。
- **subagent**:
  - deepagents:內建 `task` 工具即隔離 context spawn,幾乎零成本,最貼近 LibreChat 的 subagent 語意。
  - LangGraph / LangChain:subgraph 自建 spawn,或掛 deepagents 的 `createSubAgentMiddleware`。
  - ai-sdk:一個 `spawnSubagent` tool,`execute` 內部開新的 `generateText` 呼叫(全新 messages 陣列 = 天然 context 隔離),回傳子 run 的摘要文字;子 run 的 usage 從回傳的 `usage` 累加到請求級 collector 並標 `subagent`(對應 `subagentUsageSink`),深度用顯式參數傳遞(depth+1)。
- **condition**:與框架無關——存成 JSONB DSL 在 server 解譯,不要學 LibreChat 存不了的 function 欄位;LangGraph 系可把解譯結果接到 conditional edge,ai-sdk 接到 orchestration 分支。

### Redis 用途

- **子 run 進度串流**:對應 `ON_SUBAGENT_UPDATE` — 子 run 在 tool execute 內執行,進度事件經 Redis pub/sub 匯回主 SSE 通道(多副本部署必要)。
- **run 級限制的計數**(如同時進行的 subagent 數)與 skip 快取可放 Redis,但 LibreChat 的做法(請求生命週期內的 in-memory Set/Map)在單請求範圍內已足夠,不必過度設計。

### Next.js 前端考量

- **可見性過濾在 server 做**,不要傳到前端再隱藏(對應 callbacks.js 的事件 gate)— 隱藏的中間輸出根本不該離開伺服器。
- subagent 軌跡以「折疊卡片」呈現:live 時吃進度事件,持久化時把子軌跡掛在父訊息的 tool_call part 上(對應 `subagent_content`),避免只存在前端 state、重新整理即消失。
- 圖編輯 UI 可以從 LibreChat 的最小版起步(單一 handoff 下拉,`AgentHandoffs.tsx:71-73`);multi-source/direct/condition 先只開 API。

### 圖引擎:框架條件式的取捨

「任意圖 + 檢查點 + 平行分支」在四框架的成本差異最大:

- **LangGraph / LangChain / deepagents**:StateGraph / MultiAgentGraph 就是原生能力,LibreChat 的 `MultiAgentGraph` 封裝本就建於其上——選這系等於免費得到本章大半機制,任意拓撲、平行起點、conditional edge 可直接映射,checkpoint 亦有官方 Postgres / Redis saver(見 14-streaming-resumability.md、19-framework-options.md)。相對地,本章描述的 host 端修剪邏輯(discovery.ts 後半)大多仍需保留,因為孤兒成因(DB 缺漏、ACL、模型驗證失敗)只有 host 知道。
- **ai-sdk**:生態沒有等價的圖原語。除非確定需要「任意圖 + 檢查點 + 平行分支」,建議先用「handoff-as-tool + 程式層 orchestration + subagent spawn」三件套覆蓋 95% 場景,真的需要圖再考慮嵌入 LangGraph.js 或自製小型狀態機 — LibreChat 為了支撐任意圖付出的修剪複雜度(discovery.ts 後半)是明確的警示:圖能力不是免費的。

完整選型權衡見 19-framework-options.md。
