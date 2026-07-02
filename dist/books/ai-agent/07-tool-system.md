# 07. 工具系統

## 定位

工具系統(Tool System)是 LibreChat 讓 Agent 從「純聊天模型」升級成「能實際做事的 Agent」的核心子系統。它負責:

- **把各種能力抽象成統一的 tool 介面**:不論是內建的圖片生成、程式碼執行、網頁搜尋,還是使用者自訂的 OpenAPI action、外部 MCP server,最終都要收斂成 LLM 能理解的 function/tool schema,以及執行期能被呼叫的 tool instance。
- **管理載入管線**:決定「這個 Agent 這次對話能用哪些工具」,並在正確的時機把工具「定義」(給 LLM 看的 schema)與工具「實例」(真正跑的程式)分開載入。
- **處理工具認證**:每個工具可能需要 API key、OAuth token、或使用者提供的變數;系統要在 admin 層級(環境變數)與 user 層級(加密儲存)之間解析憑證。
- **權限與安全閘門**:capabilities(能力開關)、SSRF 防護、domain allowlist、per-tool 的 `allowed_callers` 都在這裡把關。

在整體架構中,工具系統橫跨兩個 workspace:
- `/api`(legacy JS)提供 Express 端的服務層與 HTTP 路由,例如 `ToolService.js`、`handleTools.js`、controllers。
- `/packages/api`(TypeScript)承載較新的、可測試的純邏輯,例如 `loadToolDefinitions`、`buildToolClassification`、tool registry 定義。

Agent run loop 本身(graph、streaming、tool 執行迴圈)由外部套件 `@librechat/agents` 提供;工具系統的職責是「準備好工具餵給那個 loop」,以及「在 loop 要求執行某工具時把它 on-demand 造出來」。Agent 執行流程本身見 04-execution-engine.md;本文專注於工具的分類、載入、認證與資料結構。

---

## 核心概念

### 工具的四大類

LibreChat 的工具依「來源與載入方式」分成四類,理解這個分類是理解整個管線的前提:

| 類別 | 代表 | 名稱格式 | 定義來源 | 實例建構 |
|---|---|---|---|---|
| **Native tools(原生)** | `execute_code`、`file_search`、`web_search`、`memory` | 固定字串 | 程式碼內建、`@librechat/agents` | `handleTools.js` 特判分支 |
| **Structured / Plugin** | `dalle`、`google`、`wolfram`、`tavily_search_results_json`、`flux` | `pluginKey` | `manifest.json` | `toolConstructors` map + `loadToolWithAuth` |
| **Actions** | 使用者自訂 OpenAPI 端點 | `<operationId>_action_<encodedDomain>` | 資料庫的 `Action` 文件(OpenAPI spec) | `createActionTool`(ActionService) |
| **MCP** | 外部 Model Context Protocol server | `<toolName>_mcp_<serverName>` | MCP server 動態探索 | `createMCPTool` / `createMCPTools` |

`ToolService.js:510` 定義了 native tools 的白名單:

```js
const nativeTools = new Set([
  Tools.execute_code,
  Tools.file_search,
  Tools.web_search,
  Tools.memory,
]);
```

而 `isBuiltInTool`(`ToolService.js:518`)判斷一個工具名稱是否為「系統認得的內建工具」——涵蓋 manifest 工具、toolkit、以及 native tools:

```js
const isBuiltInTool = (toolName) =>
  Boolean(
    manifestToolMap[toolName] ||
      toolkits.some((t) => t.pluginKey === toolName) ||
      nativeTools.has(toolName),
  );
```

### manifest 與 toolConstructors

`manifest.json`(`api/app/clients/tools/manifest.json`)是 structured/plugin 工具的「宣告清單」。每一筆是一個 `TPlugin`,關鍵欄位:`name`(顯示名)、`pluginKey`(內部 ID)、`description`、`icon`、`authConfig`(需要哪些憑證欄位)、以及可選的 `toolkit: true`。

`manifest.js` 把這份 JSON 攤平成兩個查找結構(`api/app/clients/tools/manifest.js`):
- `manifestToolMap`:`pluginKey → TPlugin`,O(1) 查表。
- `toolkits`:所有 `toolkit === true` 的工具陣列(目前只有 `image_gen_oai`)。

manifest 只是「宣告」,真正的「實作類別」在 `structured/` 目錄下,透過 `index.js` 匯出,再由 `handleTools.js` 的 `toolConstructors` map(`handleTools.js:181`)把 `pluginKey` 對應到 class:

```js
const toolConstructors = {
  flux: FluxAPI,
  calculator: Calculator,
  google: GoogleSearchAPI,
  open_weather: OpenWeather,
  wolfram: StructuredWolfram,
  'stable-diffusion': StructuredSD,
  'azure-ai-search': StructuredACS,
  traversaal_search: TraversaalSearch,
  tavily_search_results_json: TavilySearchResults,
};
```

每個 structured tool 是繼承 `@librechat/agents` `Tool` 的 class(見 `structured/GoogleSearch.js`),提供 `name`、`description`、`schema`(JSON Schema)、`_call(input)` 四個要素。這就是 LangChain 風格的 tool 抽象。

### 工具定義(definition)vs 工具實例(instance)

這是整個管線最重要的概念分野:

- **Tool definition**:一組 `{ name, description, parameters }`(JSON Schema)。這是「給 LLM 看的」——LLM 需要知道有哪些工具、參數長怎樣,才能決定要不要呼叫。序列化成本低,不需要 API key、不需要連 MCP server。
- **Tool instance**:一個有 `_call` / `invoke` 方法、綁好憑證、能真正發 HTTP request 的物件。建構成本高(要解密憑證、要連線 MCP server、要驗證 OpenAPI spec)。

LibreChat 刻意把這兩者拆開,走**兩階段載入**(two-phase / event-driven mode):
1. **初始化階段**只載入 definitions(`definitionsOnly = true`),把 schema 餵給 LLM。
2. **執行階段**當 LLM 真的呼叫某個工具(`ON_TOOL_EXECUTE` 事件),才用 `loadToolsForExecution` 把那幾個被叫到的工具實例化。

這對「一個 Agent 掛了 50 個 MCP 工具、但這次只用到 2 個」的場景是巨大的效能節省。

### deferred tools(延遲載入)與 tool search

當一個 Agent 掛載大量工具時,把全部 schema 塞進 system prompt 會浪費 context 且干擾模型判斷。LibreChat 的解法是 **deferred tools**:

- 在 `tool_options` 裡把某工具標記 `defer_loading: true`。
- 這些工具**不會**出現在 LLM 初始可見的工具清單裡。
- 系統改為注入一個 `tool_search` 元工具(`createToolSearch`,mode `'local'`),LLM 想用工具時先「搜尋」,系統回傳匹配的 deferred tool schema,LLM 才在下一輪呼叫。

`hasDeferredTools` 這個 boolean 一路從 `buildToolClassification` 傳出來,決定要不要注入 tool search。這對應到系統提示裡「The following deferred tools are now available via ToolSearch」的機制。

### tool_resources 與 tool_options

兩個容易混淆但職責完全不同的 Agent 欄位:

- **`tool_resources`**:提供給工具的**資料**。例如 `file_search` 需要 vector store IDs、`execute_code` 需要一組上傳檔案的 session、`image_edit` 需要要編輯的圖檔。型別是 `AgentToolResources`(`assistants.ts:186`)。
- **`tool_options`**:針對每個工具的**行為設定**。目前有兩個旋鈕:`defer_loading`(是否延遲載入)與 `allowed_callers`(誰能呼叫:`'direct'` = LLM 直接叫,`'code_execution'` = 只能透過 PTC 沙箱叫)。型別是 `AgentToolOptions = Record<toolId, ToolOptions>`(`assistants.ts:228/247`)。

### PTC(Programmatic Tool Calling)

`allowed_callers: ['code_execution']` 的工具不會直接暴露給 LLM,而是包進一個「用 bash/程式碼編排工具」的沙箱工具(`run_tools_with_bash` / `run_tools_with_code`)。LLM 寫一段程式去 orchestrate 這些工具,適合需要迴圈、條件、資料處理的多工具編排。這是 `programmatic_tools` capability 控制的進階功能。

---

## 架構與流程

### 高階資料流

```
Agent 設定 (tools[], tool_options, tool_resources)
        │
        ▼
capabilities 閘門 (resolveAgentCapabilities)  ← endpoints config / defaults
        │  過濾掉被停用能力的工具
        ▼
┌─────────────────────────────────────────────────────────┐
│ loadAgentTools (ToolService.js:1077)                     │
│   definitionsOnly?                                        │
│     true  → loadToolDefinitionsWrapper (:542)  ← 初始化   │
│     false → 全量實例化 (legacy / assistants)             │
└─────────────────────────────────────────────────────────┘
        │
        ▼ (definitionsOnly path)
loadToolDefinitions (packages/api/tools/definitions.ts:77)
   ├─ 內建工具 → getToolDefinition() 查 registry
   ├─ MCP 工具 → getOrFetchMCPServerTools() 動態探索
   ├─ action 工具 → getActionToolDefinitions() 解析 OpenAPI
   └─ buildToolClassification() → toolRegistry + hasDeferredTools
        │
        ▼
toolDefinitions[] + toolRegistry(Map) 餵給 LLM / agent graph
        │
        ▼ (LLM 決定呼叫工具, ON_TOOL_EXECUTE)
loadToolsForExecution (ToolService.js:1439)
   └─ handleTools.loadTools (handleTools.js:166) → 實例化被叫到的工具
        │
        ▼
tool._call(input)  →  結果回傳給 agent loop
```

### 流程一:初始化(只載入 definitions)

進入點 `loadAgentTools`(`ToolService.js:1077`)。當 `definitionsOnly = true`(預設,新的 event-driven 模式)時直接委派給 `loadToolDefinitionsWrapper`(`:542`):

1. **早退檢查**:`agent.tools` 為空、或只有 `context`/`ocr` 這類非工具 marker,直接回傳空定義(`:543`, `:547`)。

2. **解析 capabilities**:`resolveAgentCapabilities`(`:166`)先讀 endpoints config 的 `agents.capabilities`;若為空且是 ephemeral agent,退回 app-level 或 `defaultAgentCapabilities`。回傳一個 `Set<string>`。

3. **能力閘門過濾** `filteredTools`(`:569`):逐一檢查每個工具名稱對應的 capability——`file_search` 要 `AgentCapabilities.file_search`、MCP 工具要 `tools` capability 且 `canUseMCP` 權限、action 工具要 `actions` capability。任何一關沒過就從清單剔除。

4. **MCP 認證前置**:若有 MCP 工具,`getUserMCPAuthMap`(`packages/api/mcp/auth.ts:7`)批次抓出這些 MCP server 對應的使用者自訂變數(custom user vars),一次查 DB 而非逐一查。

5. **呼叫 `loadToolDefinitions`**(`:860`)——這是核心,見下節。

6. **MCP OAuth 處理**:對需要 OAuth 的 MCP server,發出 run-step 事件讓前端顯示授權連結,`Promise.allSettled` 等待授權完成,成功後重載定義(`:894`~`:963`)。

7. **建立 context maps**:`toolContextMap`(靜態,如 web search 使用說明)與 `dynamicToolContextMap`(動態,如「現在時間」、已上傳檔案清單)。`execute_code` / `file_search` 會 prime files(`primeCodeFiles` / `primeSearchFiles`)把 `tool_resources` 的檔案 session 準備好(`:987`~`:1019`)。

### 流程二:loadToolDefinitions 的內部(TypeScript)

`packages/api/src/tools/definitions.ts:77`。這是純邏輯、可單元測試的部分,透過依賴注入(`deps` 參數)拿到 `getOrFetchMCPServerTools`、`isBuiltInTool`、`getActionToolDefinitions`,避免直接 import Express 端的東西。

逐一走訪 `tools`(`:122`):
- **action 工具** → 收集到 `actionToolNames`,稍後批次解析。
- **非 MCP 工具** → 若 `isBuiltInTool` 為真,`getToolDefinition(toolName)` 從 registry 拿 schema;若是 toolkit(如 `image_gen_oai`)還要 `toolkitExpansion` 展開子工具(`image_edit_oai`)。
- **MCP 工具**(名稱含 `_mcp_`) → 抽出 server name,`getOrFetchMCPServerTools` 拿該 server 的工具清單;`_mcp_all` 前綴代表「該 server 全部工具」。MCP 的 JSON Schema 會經 `buildMcpParameters` 正規化(解 `$ref`、正規化、Gemini/Vertex 還要 union-flatten)。

最後把 MCP 工具丟進 `buildToolClassification`(`classification.ts:251`)建立 `toolRegistry`,並把 action / built-in 定義補進 registry(每筆預設 `allowed_callers: ['direct']`)。回傳 `{ toolDefinitions, toolRegistry, hasDeferredTools }`。

### 流程三:buildToolClassification

`packages/api/src/tools/classification.ts:251`。它只處理 MCP 工具(`loadedTools.filter(isMCPTool)`),因為只有 MCP 工具會套用 `tool_options` 的 per-tool 設定:

1. 從每個 MCP tool instance 抽出定義(`extractMCPToolDefinition`),用 `mcpJsonSchema` 屬性。
2. `buildToolRegistry`:若有 `agentToolOptions` 就套用(`buildToolRegistryFromAgentOptions`),把 `defer_loading` / `allowed_callers` 寫進每筆 `LCTool`;否則建基本定義。
3. 清掉暫時的 `mcpJsonSchema` 屬性(`cleanupMCPToolSchemas`)。
4. 計算 `hasProgrammaticTools`(要 `programmatic_tools` + `execute_code` capability 且有工具 `allowed_callers` 含 `code_execution`)與 `hasDeferredTools`(要 `deferred_tools` capability 且有工具 `defer_loading`)。
5. 若能力被停用,強制把 `defer_loading` 清為 false(`:292`)——**capability 是硬閘門,凌駕於 per-tool 設定**。
6. 有 deferred tools → 注入 `ToolSearchToolDefinition`;有 programmatic tools → 注入 PTC 定義(definitions-only 模式只加定義,不造實例)。

### 流程四:執行期載入(loadToolsForExecution)

`ToolService.js:1439`。當 agent loop 觸發 `ON_TOOL_EXECUTE`,傳入 `toolNames`(這一輪 LLM 實際要叫的工具)與先前建好的 `toolRegistry`:

1. **特殊工具識別**:`tool_search`、`run_tools_with_bash`/`run_tools_with_code`(PTC)、`bash_tool`、`execute_code` 各有專屬建構路徑,並用 `specialToolNames` set 排除,避免被當一般工具重載。
2. **tool search**:若 `toolNames` 含 `TOOL_SEARCH` 且有 registry,`createToolSearch({ mode: 'local', toolRegistry })` 造出搜尋工具。
3. **PTC**:若啟用 PTC,把 registry 裡非特殊工具全部收集成 `ptcOrchestratedToolNames`,連同一般工具一起載入,並把它們塞進 `configurable.ptcToolMap` 供沙箱編排。
4. **一般工具**分成 `actionToolNames` 與 `regularToolNames`,前者走 `loadActionToolsForExecution`,後者走 `handleTools.loadTools`。
5. **權限二次確認**:`execute_code`、`bash_tool` 在這裡再檢查一次 `codeExecutionEnabled` 且 registry 有註冊(`:1516`, `:1566`),沒過就 log warning 並跳過——防止 registry 與實際能力不同步時的越權執行。

### 流程五:handleTools.loadTools(真正實例化)

`handleTools.js:166`。這是把工具名稱變成 tool instance 的地方。核心是一個 `for (const tool of tools)` 迴圈,對每種類別分派:

- `execute_code` / `file_search` → prime files 後呼叫 `createCodeExecutionTool` / `createFileSearchTool`。
- `web_search` → `loadWebSearchAuth` 解析憑證後 `createSearchTool`,並掛上 streaming callback。
- memory 工具 → `buildInlineMemoryTool`。
- MCP 工具(`mcpToolPattern.test(tool)`)→ 解析 server config,收集到 `requestedMCPTools`,之後按 server 逐一(sequential)建構,因為 MCP 連線有狀態。
- toolkit 子工具(如 `image_gen_oai`)→ 查 `customConstructors`,並用閉包快取避免重複建構。
- 一般 structured tool → `loadToolWithAuth(user, getAuthFields(tool), Ctor, options)`(`:435`)產生一個 async factory,呼叫時才 `loadAuthValues` 解密憑證並 `new Ctor(...)`。

注意 MCP 工具是**每個 server 依序**建構(`:472` 的 `Object.entries(requestedMCPTools)`),而 structured 工具是 `Promise.all` 並行(`:450`)——因為 MCP 連線有連線池與 OAuth 狀態,不能亂序並發。

---

## 關鍵資料結構

### TPlugin(manifest 項目)

`manifest.json` 每筆的形狀:

| 欄位 | 型別 | 用途 |
|---|---|---|
| `name` | string | UI 顯示名稱 |
| `pluginKey` | string | 內部唯一 ID,`toolConstructors` 與 `agent.tools[]` 用它 |
| `description` | string | 給使用者看的說明 |
| `icon` | string | 圖示 URL / asset 路徑 |
| `authConfig` | `{ authField, label, description, optional? }[]` | 需要哪些憑證欄位;`authField` 可用 `\|\|` 表示 alternates |
| `toolkit` | boolean? | 是否為 toolkit(會展開成多個子工具) |
| `isAuthRequired` | string? | 是否強制需要憑證 |

`authField` 的 `A||B||C` 語法很重要:代表「A、B、C 任一個有值即可」,例如 DALL-E 的 `DALLE3_API_KEY||DALLE_API_KEY`。

### LCTool / toolRegistry 項目

`toolRegistry` 是 `Map<string, LCTool>`,每筆是 event-driven 執行的核心資料:

| 欄位 | 型別 | 用途 |
|---|---|---|
| `name` | string | 工具名稱 |
| `description` | string? | 給 LLM 的描述 |
| `parameters` | JsonSchemaType? | 輸入 schema |
| `allowed_callers` | `('direct'\|'code_execution')[]` | 誰能呼叫;預設 `['direct']` |
| `defer_loading` | boolean? | 是否延遲載入(需 capability 允許) |
| `toolType` | `'mcp'\|'builtin'\|...` | 工具來源分類 |
| `serverName` | string? | MCP 工具的 server 名稱 |

### ToolOptions / AgentToolOptions

`packages/data-provider/src/types/assistants.ts:222`:

```ts
export type AllowedCaller = 'direct' | 'code_execution';
export type ToolOptions = {
  defer_loading?: boolean;      // 預設 false
  allowed_callers?: AllowedCaller[]; // 預設 ['direct']
};
export type AgentToolOptions = Record<string, ToolOptions>; // key = tool_id
```

### AgentToolResources

`assistants.ts:186`。每種資源掛一組 file IDs / vector store IDs:

| key | 型別 | 給哪個工具 |
|---|---|---|
| `image_edit` | `{ file_ids, files }` | OpenAI/Gemini 圖片編輯 |
| `execute_code` | `ExecuteCodeResource` | 程式沙箱可見的檔案 |
| `file_search` | `{ file_ids, files, vector_store_ids }` | 語意搜尋 |
| `context` | `AgentBaseResource` | 直接注入 context 的檔案 |
| `ocr` | `AgentBaseResource` | (deprecated,改用 context) |

### PluginAuth(憑證儲存)

使用者層級的工具憑證存在 `PluginAuth` collection(MongoDB),欄位:`userId`、`authField`、`pluginKey`、`value`(加密)。透過 `getUserPluginAuthValue`(`PluginService.js:35`)解密讀取,`updateUserPluginAuth` 加密寫入。加密用 `@librechat/api` 的 `encrypt`/`decrypt`。

### AgentCapabilities(能力開關)

`config.ts:562` 定義的 enum,是最上層的閘門。與工具相關的關鍵值:`tools`、`actions`、`execute_code`、`file_search`、`web_search`、`memory`、`deferred_tools`、`programmatic_tools`。管理員在 `librechat.yaml` 的 `endpoints.agents.capabilities` 控制哪些能開。

---

## 關鍵實作細節與陷阱

### 憑證解析:admin 優先於 user

`loadAuthValues`(`credentials.js:13`)與 `validateTools`(`handleTools.js:64`)都遵循同一套規則:對每個 `authField`,先看環境變數(admin 設定),有值就用;沒有才查 `getUserPluginAuthValue`(user 設定)。且環境變數若等於字串 `AuthType.USER_PROVIDED`(佔位符)視同沒設。

`||` alternates 的處理有個陷阱:`findAuthValue`(`credentials.js:21`)逐個嘗試,只在**最後一個** alternate 也失敗時才 throw。若某工具設 `optional`,則放進 `optional` set 讓它回傳 `undefined` 而不 throw。搬移時要小心複製這套「多欄位、多來源、fallback」邏輯,否則很容易出現「明明設了 key 卻說沒認證」的 bug。

### MCP 工具名稱格式與雙向解析

MCP 工具名稱是 `<toolName>_mcp_<serverName>`,分隔符 `_mcp_`(`Constants.mcp_delimiter`,`config.ts:2649`)。這造成一個陷阱:**server 名稱本身若含底線**,反解時必須用「最後一個 `_mcp_`」或「第一個」來切,不同函式選擇不同:
- `handleTools.js:385` 用 `tool.split(Constants.mcp_delimiter)` 取 `[toolName, serverName]`。
- `classification.ts:41` `getServerNameFromTool` 取 `parts[parts.length - 1]`(最後一段)。
- `auth.ts:37` 用 `indexOf` 取「第一個 delimiter 之後全部」當 server name。

這種不一致是潛在踩坑點——移植時務必統一「工具名稱編碼/解碼」的單一實作。

### Action 的 domain 編碼與 operationId 碰撞

Action 工具名稱是 `<operationId>_action_<encodedDomain>`。因為工具名受 `[a-zA-Z0-9_-]{,64}` 限制,domain 太長會被 base64 截斷編碼(`domainParser`,`ActionService.js:115`)。`ToolService.js` 頂部有大段註解(`:81`~`:156`)解釋兩個微妙問題:

1. **短 hostname 用 `---` 分隔**(`actionDomainSeparator`),但查找 map 一律用 `_` 正規化,所以 `normalizeActionToolName`(`:97`)只正規化 domain 後綴、**不動 operationId**(因為 `openapiToFunction` 保留 operationId 裡的連字號,`get_foo---bar` 與 `get_foo_bar` 是不同 operation)。
2. `registerActionTools`(`:125`)以「完整工具名」為 key(而非只用 domain),讓兩個共用 hostname 的 action 靠 operationId 區分;若連 operationId 都撞則 log warning。

還註冊了 **legacy encoding** 相容路徑,讓舊 agent 存的工具名仍能解析。這是典型的「歷史包袱相容」複雜度,新平台若一開始就設計好穩定的工具 ID(例如用 UUID)可完全避開。

### SSRF 防護

Action 會打使用者指定的外部 URL,是 SSRF 高風險面。`createActionTool`(`ActionService.js:182`)在沒有明確 `allowedDomains` allowlist 時**預設啟用** SSRF 防護(`useSSRFProtection: !Array.isArray(allowedDomains) || length === 0`,見 `:447`),用 `createSSRFSafeAgents` 在連線時驗證解析出的 IP,擋掉私網位址。另外 `validateActionDomain` 做「stored domain 與 spec serverUrl 一致性」的 defense-in-depth 檢查(`:386`),防止資料庫裡被竄改的 action 打到別的 domain。移植 action/外部 HTTP 工具時,SSRF 防護是**不可省略**的安全要求。

### capabilities 是硬閘門且被檢查多次

同一個工具的能力可能被檢查 2~3 次:
- 載入定義時 `filteredTools` 過濾(`ToolService.js:569`)。
- `buildToolClassification` 裡若 capability 關閉就強制清 `defer_loading`(`classification.ts:292`)。
- 執行期 `loadToolsForExecution` 再確認 `execute_code`/`bash_tool` 授權(`:1516`, `:1566`)。

這種「多層重複檢查」是刻意的縱深防禦——因為 registry、定義、執行三個階段的資料可能來自不同快取而不同步。但也造成邏輯散落、難以一眼看全。

### 兩階段載入的隱藏成本:MCP 動態探索

`getOrFetchMCPServerTools`(`ToolService.js:716`)在初始化階段就可能連線 MCP server 抓工具清單(`getMCPServerTools` 快取沒命中時 `reinitMCPServer`)。也就是說「只載定義」並非完全零成本——MCP definitions 需要動態探索,還可能觸發 OAuth。快取(`getMCPServerTools`)在這裡是效能關鍵。

### primeFiles 與 execute_code 的第一次呼叫

`ToolService.js:980` 有段關鍵註解:`execute_code` 的檔案必須在 run 開始前 seed 到 `Graph.sessions[EXECUTE_CODE]`,否則第一次 tool call 時 `_injected_files` 為空,沙箱看不到上一輪產生的檔案。這是「工具狀態跨 turn 傳遞」的細節,`primedCodeFiles` 一路往上傳就是為了這件事。

### 直接呼叫工具的 HTTP 端點很窄

`directCallableTools`(`controllers/tools.js:23`)只有 `execute_code` 一個。`POST /agents/tools/:toolId/call` 不是通用工具閘道,而是專為 code interpreter 的「在對話外直接跑一段程式」設計。`verifyToolAuth` 對 `execute_code` 一律回報 `authenticated: true`(因為沙箱認證在 server 端做,`:87`),對 `web_search` 走 `verifyWebSearchAuth`,其他一律 404。不要誤以為這是所有工具的通用執行 API。

---

## 設計決策分析

### manifest 驅動的宣告式註冊

**做法**:工具用 JSON manifest 宣告(name/authConfig/icon),class 實作分離,靠 `pluginKey` 綁定。

**優點**:前端列出可用工具、判斷認證狀態(`checkPluginAuth`)完全靠 manifest,不需 import 任何工具實作;新增工具只要加一筆 JSON + 一個 class + 一行 `toolConstructors`。認證欄位宣告式,UI 能自動生成憑證輸入框。

**缺點**:manifest(JSON)、class(JS)、`toolConstructors`(JS)、registry definitions(TS,`packages/api/tools/registry/definitions.ts`)四處要手動保持同步,schema 甚至重複定義(GoogleSearch 的 schema 在 class 內與 registry 各寫一份)。這違反 DRY,是明顯的技術債。

**若重做**:讓工具用單一 TypeScript 模組 export 一個完整物件(schema + metadata + handler + authFields),用 Zod schema 自動推導 JSON Schema 與 TS 型別,build 時掃描目錄自動生成 registry,消除四處同步。

### 兩階段載入(definitions vs instances)

**做法**:初始化只載 schema,執行期才實例化。

**優點**:掛 50 個工具只用 2 個時,節省 48 次憑證解密 / MCP 連線;context 也只放實際需要的 schema(配合 deferred tools)。這是為「大量工具的 Agent」而生的正確設計。

**缺點**:程式複雜度暴增——同一套載入邏輯要在「definitions 模式」與「instances 模式」各走一遍(`loadToolDefinitionsWrapper` 與 `loadAgentTools` 的 else 分支幾乎平行但不完全相同),`buildToolClassification` 也有 `definitionsOnly` 分支。維護成本高、容易兩邊漂移。

**若重做**:用單一 lazy tool 抽象——tool 物件同時攜帶 schema(便宜、立即可得)與一個 `instantiate()` lazy factory(貴、按需呼叫)。四個候選框架的 tool 原語都接近這個形狀:ai-sdk 的 `tool({ parameters, execute })` 把 definition 與 execute 綁在一起,execute 只在被呼叫時才跑;LangChain 系(LangGraph / LangChain / deepagents)的 `tool()` / `DynamicStructuredTool` 同樣以 schema + handler 為單一物件——這也正是 LibreChat 現制的來源。兩者都讓你不必維護兩套平行程式碼(框架取捨見 19-framework-options.md)。

### JS legacy 與 TS package 的分工

**做法**:純邏輯(classification、definitions、format、auth map)放 `packages/api`(TS、可測試),Express 相關(HTTP、DB、streaming)留 `/api`(JS)。

**優點**:符合 monorepo 邊界原則,純函式能單元測試(`classification.spec.ts`、`definitions.spec.ts`),依賴注入(`deps` 參數)讓 TS 邏輯不碰 Express。

**缺點**:一個載入流程橫跨兩個 workspace、兩種語言,追 code 要在 JS 與 TS 之間跳。`ToolService.js` 這個 1791 行的 JS 巨檔仍是事實上的 orchestrator。

**若重做**:新平台可全 TypeScript,把 orchestration 也寫成 TS,消除語言邊界;但保留「純邏輯 / IO 邊界」的依賴注入切分是好的。

---

## 移植到新技術棧的建議

以下針對 **PostgreSQL + Hono + Next.js + pnpm + Redis + docker-compose** 給具體對應。AI 框架尚未定案,四個候選為 LangGraph / LangChain / deepagents / Vercel AI SDK(完整比較見 19-framework-options.md);與框架相關的部分以條件式或四欄對照呈現,其餘技術棧已定。

### 資料庫 schema(PostgreSQL DDL 草案)

LibreChat 的 `PluginAuth`、`Action`、agent 的 `tool_options`/`tool_resources` 對應到:

```sql
-- 使用者層級的工具憑證(對應 PluginAuth)
CREATE TABLE tool_credentials (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plugin_key   text NOT NULL,          -- 'google' / 'mcp_<server>' / action domain
  auth_field   text NOT NULL,          -- 'GOOGLE_SEARCH_API_KEY'
  value_enc    bytea NOT NULL,         -- 加密後的憑證(用 pgcrypto 或 app 層 AES-GCM)
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, plugin_key, auth_field)
);

-- 自訂 action(OpenAPI 工具),對應 Action collection
CREATE TABLE agent_actions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  domain       text NOT NULL,          -- 目標 host
  raw_spec     jsonb NOT NULL,         -- OpenAPI spec
  auth_type    text NOT NULL,          -- 'none' | 'service_http' | 'oauth'
  metadata_enc jsonb,                  -- 加密的 oauth_client_id/secret/api_key
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, domain)
);

-- agent 的 per-tool 設定(對應 tool_options),用 jsonb 即可
-- agents.tool_options jsonb  → { "search_mcp_github": { "defer_loading": true, "allowed_callers": ["direct"] } }
-- agents.tool_resources jsonb → { "file_search": { "vector_store_ids": [...] }, ... }
```

建議:
- `tool_options` / `tool_resources` 直接用 `agents` 表的 `jsonb` 欄位,不需拆表(讀寫都是整包 agent 一起)。
- 憑證加密**不要**依賴 pgcrypto 的欄位加密就滿足;在 app 層用 AES-256-GCM 加密後存 `bytea`,金鑰放環境變數/KMS,對應 LibreChat 的 `encrypt`/`decrypt`。
- action 的 OAuth token 另存一張 `oauth_tokens(user_id, identifier, access_token_enc, refresh_token_enc, expires_at)`,對應 LibreChat 的 `findToken`/`updateToken`。

### Hono route / middleware 對應

LibreChat 的 `routes/agents/tools.js` 直接對應:

```ts
const tools = new Hono();
tools.get('/', getAvailableToolsHandler);           // GET /agents/tools
tools.get('/calls', getToolCallsHandler);            // GET /agents/tools/calls
tools.get('/:toolId/auth', verifyToolAuthHandler);   // 驗證憑證狀態
tools.post('/:toolId/call', rateLimit(), callToolHandler); // 直接執行(code interpreter)
```

- `toolCallLimiter` → Hono 的 rate-limit middleware(可用 Redis 計數)。
- 認證/授權(`req.user`、capability 檢查)→ Hono middleware 注入 `c.set('user', ...)`,capability 閘門做成一個 `requireCapability('execute_code')` middleware。
- `getAvailableTools`(列出工具給前端)→ 一個 handler 讀「工具 registry + 使用者憑證狀態」回傳,對應 `checkPluginAuth` 的邏輯用 `filterUniquePlugins` + 每工具算 `authenticated` boolean。

### AI 框架的工具抽象對應

工具抽象是移植的最大槓桿點,也是四個候選框架差異最明顯的地方。關鍵不對稱:LibreChat 的 `@librechat/agents` 本身就是 LangGraph 封裝,選 LangGraph 系(含 LangChain / deepagents)時本文描述的載入管線、classification、MCP 正規化幾乎可直接參考;選 ai-sdk 則較多能力需自建(完整選型見 19-framework-options.md)。

**tool 定義對應(本子系統核心)**

| 面向 | LangGraph / LangChain / deepagents | Vercel AI SDK |
|---|---|---|
| tool 原語 | `tool()` / `DynamicStructuredTool`,schema(Zod 或 JSON Schema)+ handler 為單一物件——與 LibreChat 現制同源 | `tool({ description, parameters: zodSchema, execute })`,definition 與 handler 合一,`execute` 只在被呼叫時跑 |
| definition/instance 分離 | 沿用 LibreChat 現有兩階段載入即可(同一套 LangChain tool 抽象) | 用單一 lazy `execute` 天然收斂,不需 `loadToolDefinitions` / `loadToolsForExecution` 兩套平行程式碼 |
| MCP | `@langchain/mcp-adapters`(1.1.3)直接拿 LangChain 格式工具,對應 LibreChat 手刻的 `createMCPTool` / `reinitMCPServer` / schema 正規化可大幅精簡 | `createMCPClient`(tools/resources/prompts/elicitation;HTTP 建議生產、stdio experimental)+ v7 MCP Apps |
| deferred tools / tool search | 無內建;LibreChat 現制(`createToolSearch`)可照抄 | 無內建;自建 `tool_search` 工具讓 `execute` 回傳匹配的 deferred schema,或用 `prepareStep` 動態調整每步 `activeTools` |

**其餘與工具相關的能力**

- **agent loop**:LangGraph 系用 `createAgent` / `createDeepAgent` 內建 tool loop(底層即 LibreChat 現用的 StateGraph + `recursionLimit`);ai-sdk 用 `streamText` / `ToolLoopAgent` 的 `stopWhen: stepCountIs(n)`。兩者都自動把工具結果回餵,取代手刻 graph loop。
- **動態工具集**:兩系都支援依 request 動態組裝工具——把「這個 agent 這次能用的工具」在 handler 裡算好(套 capability 閘門、解析 tool_options)再傳入 graph / `streamText` 的 `tools`。
- **provider schema 差異**:LibreChat 手動為 Gemini/Vertex 做 union-flatten(`sanitizeGeminiSchema`)。LangChain 系走 `@langchain/*` provider 套件群(與 LibreChat 同款);ai-sdk 的各 provider adapter 多半已處理相容性。無論哪家,複雜 union/`$ref` 的 MCP schema 都仍要實測。
- **structured tools**:LibreChat 的 DALLE/Wolfram/Tavily 等每個都收斂成一個 tool 物件(Zod 定 parameters、handler 打對應 API,憑證從 `tool_credentials` 表解密後注入)——這層寫法在四個框架幾乎一致,差別只在 `tool()` 匯入自哪個套件。

### Redis 的用途

LibreChat 用 `getLogStores` 的快取層(可接 Redis)做幾件事,新平台直接用 Redis:

- **MCP 工具清單快取**:對應 `getMCPServerTools` — key `mcp:tools:<userId>:<server>`,避免每次 run 都重連 MCP server 探索工具(動態探索是初始化階段的主要成本)。
- **OAuth flow state**:對應 `FlowStateManager`(`CacheKeys.FLOWS`)— action/MCP 的 OAuth 授權是跨 request 的非同步流程(發連結 → 使用者授權 → callback),需要一個短期 state store。Redis 的 `SETEX` + pub/sub 很適合。
- **domain 編碼快取**:對應 `ENCODED_DOMAINS` — 若沿用 base64 domain 編碼(建議別沿用,見下)。
- **rate limiting**:`toolCallLimiter` 的計數。

### Next.js 前端考量

- **工具選擇 UI**:對應 `getAvailableTools` 回傳的清單,前端用 React Query 抓 `/agents/tools`,依 `authenticated` 狀態顯示「需設定憑證」的提示。憑證輸入框由 `authConfig` 宣告式生成。
- **tool_options 編輯器**:讓使用者為每個工具設 `defer_loading` / `allowed_callers`,存回 agent 的 `tool_options` jsonb。
- **tool call 顯示**:工具執行結果(尤其 web search 的來源、code interpreter 的圖檔 artifact)要透過 SSE/streaming 逐步渲染,對應 LibreChat 的 `createOnSearchResults` attachment 事件。前端驅動方式視框架而定:ai-sdk 的 `useChat` 搭配 UIMessage stream 協定(前端協定四者最完整)可直接把 tool part 綁到 UI;LangChain 系則消費 `streamEvents` / LangGraph `streamMode` 的 tool 事件自建渲染(可參考 LibreChat 現制)。
- **OAuth 授權**:action/MCP 需要授權時,後端串流出授權 URL,前端開新視窗完成 OAuth,callback 後後端解除等待。

### 建議捨棄的部分

- **base64 domain 編碼 + legacy 相容**:LibreChat 因「工具名受 64 字元 regex 限制」才把 domain 塞進工具名,衍生大量 `normalizeActionToolName` / legacy encoding 複雜度。新平台用穩定的 `action_id`(UUID)當工具名(或 `act_<shortid>`),把 domain/operationId 存 registry,一勞永逸避開整套編碼/碰撞問題。
- **四處同步的 manifest / class / registry**:改用單一來源(Zod-first 工具模組)。
- **JS/TS 雙 workspace 的 orchestrator**:新平台全 TS。

---

## 出處索引(關鍵行號)

- 載入進入點:`api/server/services/ToolService.js:1077`(`loadAgentTools`)、`:542`(`loadToolDefinitionsWrapper`)、`:1439`(`loadToolsForExecution`)、`:214`(`processRequiredActions`)、`:510`(nativeTools)、`:518`(`isBuiltInTool`)。
- 實例化:`api/app/clients/tools/util/handleTools.js:166`(`loadTools`)、`:132`(`loadToolWithAuth`)、`:181`(`toolConstructors`)、`:64`(`validateTools`)。
- manifest:`api/app/clients/tools/manifest.json`、`manifest.js`、`index.js`;範例 class `structured/GoogleSearch.js`。
- 純邏輯:`packages/api/src/tools/definitions.ts:77`、`classification.ts:251`、`registry/definitions.ts:476`、`toolkits/mapping.ts`、`format.ts:28`(`checkPluginAuth`)、`mcp/auth.ts:7`(`getUserMCPAuthMap`)。
- 認證:`api/server/services/Tools/credentials.js:13`(`loadAuthValues`)、`api/server/services/PluginService.js:35`(`getUserPluginAuthValue`)。
- Actions:`api/server/services/ActionService.js:182`(`createActionTool`)、`:115`(`domainParser`)、`:161`(`loadActionSets`)。
- HTTP:`api/server/routes/agents/tools.js`、`api/server/controllers/tools.js`、`api/server/controllers/PluginController.js:41`。
- MCP:`api/server/services/Tools/mcp.js:30`(`reinitMCPServer`)、`api/server/services/Tools/search.js:26`。
- 型別/常數:`packages/data-provider/src/types/assistants.ts:18/32/186/222/228`、`config.ts:562`(AgentCapabilities)、`config.ts:2649`(mcp 常數)。
