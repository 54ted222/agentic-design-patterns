# 03. Agent 資料模型

## 定位

這份文件描述 LibreChat「一個 agent 是什麼」——也就是使用者在 Agent Builder 裡建立、儲存、分享、版本化的那個持久化實體的資料模型。它是整個 agents 子系統的核心 schema:上層的對話執行(runtime / agent loop)、工具載入、權限檢查、市集(marketplace)全部都圍繞這份 schema 打轉。

在整體架構裡,agent 文件扮演「設定的單一事實來源(single source of truth)」:

- **前端** Agent Builder 讀寫這份文件(透過 `/agents` REST API)。
- **執行期**在收到一則對話訊息時,用 `agent_id` 把文件撈出來,轉成 runtime agent 餵給 `@librechat/agents` 的 graph。
- **權限系統(ACL)**用文件的 `_id` 當 resourceId 做分享與存取控制。
- **檔案系統**把 `file_id` 掛在 `tool_resources` 下,讓 agent 能存取使用者上傳的檔案。

本文只負責「資料模型與其 CRUD」。工具/MCP 的載入細節、ACL 權限位元的語意、runtime agent loop 的執行,分別由其他文件負責(見 07-tool-system.md 與 08-mcp-integration.md、見 16-permissions-sharing.md、見 04-execution-engine.md)。這裡只在必要時點到為止。

核心檔案:

- Schema:`packages/data-schemas/src/schema/agent.ts`
- TypeScript 型別:`packages/data-schemas/src/types/agent.ts`(DB 端 `IAgent`)、`packages/data-provider/src/types/assistants.ts:262`(共享 `Agent` 型別)
- DB 方法:`packages/data-schemas/src/methods/agent.ts`
- 驗證 schema(zod):`packages/api/src/agents/validation.ts`
- REST 路由:`api/server/routes/agents/v1.js`
- Controller:`api/server/controllers/agents/v1.js`
- Ephemeral agent:`packages/api/src/agents/load.ts`、`packages/data-provider/src/parsers.ts:508`

---

## 核心概念

在動手看欄位之前,先建立幾個心智模型,否則欄位表會很難懂。

- **兩種 ID**:每個 agent 有兩個識別碼。MongoDB 的 `_id`(ObjectId)是內部主鍵,ACL 權限、favorites 都用它;`id`(字串,格式 `agent_<nanoid>`)才是對外暴露、URL 上出現、edges/subagents 互相引用的「公開 ID」。這個刻意的雙 ID 設計是後面很多陷阱的根源。

- **持久 agent vs ephemeral agent**:持久 agent 是資料庫裡的一筆文件(`id` 以 `agent_` 開頭)。ephemeral agent 是「臨時 agent」——使用者在一般聊天視窗(非 agents endpoint)勾了「開啟 web search / code interpreter / 某個 MCP server」,系統在單次請求內合成一個 runtime agent,**從不落地資料庫**。判斷方式極其簡單:`isEphemeralAgentId` 就是 `!id.startsWith('agent_')`(`parsers.ts:590`)。

- **Capabilities 是「endpoint 級開關」,不是 agent 欄位**:`AgentCapabilities` 列舉(`config.ts:562`)控制的是「這個部署的 agents endpoint 允許哪些功能」,存在 `librechat.yaml` 的 `endpoints.agents.capabilities`。agent 文件本身不存 capabilities;它存的是「有沒有用到某個能力」的具體設定(例如 `tools` 裡有沒有 `execute_code`)。runtime 會用 capabilities 當白名單去過濾 agent 想用的功能。

- **版本內嵌(embedded versions)**:agent 的歷史版本不是另一張表,而是內嵌在同一份文件的 `versions` 陣列裡。每次有意義的更新都會 push 一個當前狀態的快照。

- **衍生欄位(derived fields)**:`mcpServerNames` 不是使用者填的,而是每次寫入時從 `tools` 反推出來、反正規化(denormalize)存起來,單純為了查詢效率。

- **多租戶靠 async context 隱式注入**:`tenantId` 欄位加上一個 Mongoose plugin,把租戶隔離做成「查詢時自動注入 where 條件」,方法層的程式碼幾乎看不到它。

---

## 架構與流程

### 一次「更新 agent」的完整資料流

```
PATCH /agents/:id
   │
   ▼
[route] v1.js
   requireJwtAuth ─► checkAgentCreate (USE+CREATE 權限)
                   └► canAccessAgentResource(EDIT bit, ACL)
   │
   ▼
[controller] updateAgentHandler (controllers/agents/v1.js:598)
   1. agentUpdateSchema.parse(body)         ← zod 驗證 + strip 未知欄位
   2. removeNullishValues                    ← 清掉 null/undefined
   3. validateEdgeAgentAccess                ← edges 引用的 agent 要有 VIEW 權限
   4. validateSubagentReferences             ← subagents.agent_ids 存在且可存取
   5. convertOcrToContextInPlace             ← 舊 ocr → 新 context 遷移
   6. pruneToolResourceFileIdsForOwner       ← 只留下 owner 擁有的 file_id
   7. filterAuthorizedTools                  ← MCP 工具授權過濾
   │
   ▼
[method] updateAgent (methods/agent.ts:464)
   ├─ findOne(searchParameter)               ← 抓當前文件
   ├─ filterExistingSkillIds                 ← 清掉已刪除的 skill(fail-closed)
   ├─ extractMCPServerNames(tools)           ← 同步衍生 mcpServerNames
   ├─ generateActionMetadataHash             ← actions 內容雜湊,用於版本比對
   ├─ isDuplicateVersion?                    ← 內容沒變就不建新版本(除非 forceVersion)
   ├─ $push versions: {snapshot, updatedBy}  ← 建立版本快照
   └─ findOneAndUpdate(..., {new:true})
   │  (tenantIsolation plugin 在此隱式注入 { tenantId } 到 filter)
   ▼
回傳更新後文件 + version 計數
```

### Ephemeral agent 的合成流程

一般聊天(非 agents endpoint)送出訊息時,payload 帶著 `ephemeralAgent`(型別 `TEphemeralAgent`,`types.ts:104`),runtime 呼叫 `loadEphemeralAgent`(`load.ts:48`)當場組出一個 `Agent` 物件:

```
req.body.ephemeralAgent = { web_search:true, execute_code:true, mcp:['github'] }
   │
   ▼
loadEphemeralAgent
   ├─ 依 flag 把 Tools.web_search / execute_code / file_search / memory 推進 tools[]
   ├─ 依 mcp[] 展開 MCP server 的工具(或用 sys__all__sys 佔位)
   ├─ instructions ← promptPrefix / modelSpec.promptPrefix
   ├─ id ← encodeEphemeralAgentId({endpoint, model, sender})
   │        例:'openAI__gpt-4o___GPT-4o'
   └─ 回傳 Partial<Agent>(沒有 _id、author、versions,絕不寫 DB)
```

`loadAgent`(`load.ts:170`)是統一入口:`isEphemeralAgentId(agent_id)` 為真就走合成路徑,否則 `getAgent({id})` 撈 DB。

---

## 關鍵資料結構

### agent schema 全欄位

出處:`packages/data-schemas/src/schema/agent.ts`、型別 `packages/data-schemas/src/types/agent.ts`。

| 欄位 | 型別 | 用途 / 備註 |
|---|---|---|
| `_id` | ObjectId | Mongo 主鍵。ACL resourceId、favorites 都用它,不對外當識別碼。 |
| `id` | String, required | 公開 ID,格式 `agent_<nanoid>`(controller `v1.js:412` 生成)。edges/subagents 互引、URL 都用它。 |
| `name` | String | 顯示名稱。 |
| `description` | String | 市集/清單顯示用簡介。 |
| `instructions` | String | 系統提示(system prompt)本體。 |
| `avatar` | Mixed `{filepath, source}` | 頭像。`source` 可為 `s3`/`local` 等;S3 來源會在讀取時 refresh 簽名 URL。 |
| `provider` | String, required | LLM 供應商 / endpoint(如 `openAI`、`anthropic`、custom endpoint 名)。 |
| `model` | String, required | 模型名。 |
| `model_parameters` | Object | temperature、max_output_tokens、top_p、`useResponsesApi` 等(型別 `AgentModelParameters`,`assistants.ts:163`)。 |
| `artifacts` | String | artifacts 模式:`default` / `shadcnui` / `custom`(`ArtifactModes`,`artifacts.ts:1`)。 |
| `access_level` | Number | 遺留/保留欄位,agent 流程未實際使用(源自 Assistants 文件型別)。 |
| `recursion_limit` | Number | runtime graph 的最大遞迴步數上限。 |
| `tools` | String[] | 工具識別字串。三種格式:內建工具名(`execute_code`)、action(`domain{actionDelimiter}id`)、MCP(`toolName_mcp_serverName`)。 |
| `skills` | String[] | Skill 的 ObjectId 白名單。空陣列 + `skills_enabled` 代表「全部 skill」。 |
| `skills_enabled` | Boolean | skill 功能總開關。`true`=啟用(白名單為空則全開),`false`/undefined=關閉。 |
| `tool_kwargs` | Mixed[] | 每個工具的額外 kwargs。 |
| `actions` | String[] | OpenAPI action 的完整 ID 陣列。實際 metadata 存在另一個 `actions` collection。 |
| `author` | ObjectId → User, required | 建立者。回應時常轉字串,且非本人時會被刪掉。 |
| `authorName` | String | 建立者顯示名快取。 |
| `hide_sequential_outputs` | Boolean | multi-agent chain 時是否隱藏中間 agent 的輸出。 |
| `end_after_tools` | Boolean | 工具呼叫後是否直接結束(不再讓 LLM 收尾)。 |
| `agent_ids` | String[] | **@deprecated**,已被 `edges` 取代。舊的 chain 直連。 |
| `edges` | Mixed[] (`GraphEdge[]`) | multi-agent 圖的邊。見下方 GraphEdge 結構。 |
| `conversation_starters` | String[] | 建議開場白(上限 `MAX_CONVO_STARTERS=4`)。 |
| `tool_resources` | Mixed (`AgentToolResources`) | 各工具可用的 `file_ids`。見下方結構。 |
| `versions` | Mixed[] | 版本歷史快照陣列。見「版本機制」。 |
| `category` | String, indexed, default `'general'` | 市集分類。 |
| `support_contact` | Mixed `{name, email}` | 市集上顯示的支援聯絡方式。 |
| `is_promoted` | Boolean, indexed, default false | 市集「推薦」置頂旗標。 |
| `mcpServerNames` | String[], indexed | **衍生欄位**,從 `tools` 反推的 MCP server 名集合,供高效查詢。 |
| `tool_options` | Mixed (`AgentToolOptions`) | 每工具設定:`defer_loading`、`allowed_callers`。見下方。 |
| `subagents` | Mixed (`AgentSubagentsConfig`) | 子 agent 生成設定。見下方。 |
| `tenantId` | String, indexed | 多租戶隔離用租戶 ID。 |
| `createdAt` / `updatedAt` | Date | `timestamps: true` 自動維護。 |

### 索引(`agent.ts:138`)

| 索引 | 用途 |
|---|---|
| `{ id: 1, tenantId: 1 }` unique | 公開 ID 在租戶內唯一(注意:是複合唯一,不是 `id` 單獨唯一)。 |
| `{ updatedAt: -1, _id: 1 }` | cursor 分頁排序鍵(見清單分頁)。 |
| `{ 'edges.to': 1 }` | 刪除 agent 時反向清 handoff 邊。 |
| 單欄:`category`、`is_promoted`、`mcpServerNames`、`tenantId` | 市集篩選與 MCP 查詢。 |

### `tool_resources`(`assistants.ts:186`)

```ts
interface AgentToolResources {
  image_edit?:   { file_ids?: string[]; files?: TFile[] };
  execute_code?: { file_ids?: string[]; files?: TFile[] };   // 上限 20 檔
  file_search?:  { file_ids?: string[]; files?: TFile[]; vector_store_ids?: string[] };
  context?:      { file_ids?: string[]; files?: TFile[] };
  ocr?:          { file_ids?: string[]; files?: TFile[] };   // @deprecated → context
}
```

- `file_ids` 是持久化的關聯;`files` 是 runtime 才 populate 的完整檔案物件(zod 驗證時 `files` 用 `z.unknown()`,不接受使用者輸入,`validation.ts:34`)。
- `ocr` 是舊格式,系統會在更新/複製時就地遷移成 `context`(`convertOcrToContextInPlace`、`mergeAgentOcrConversion`)。
- `addAgentResourceFile`(`methods/agent.ts:597`)以 `$addToSet` 原子操作把 `file_id` 加到 `tool_resources.<resource>.file_ids`,同時把該 resource 名加進 `tools`。

### `tool_options`(`assistants.ts:228`)

以 `tool_id` 為鍵的 map,控制單一工具行為:

```ts
type ToolOptions = {
  defer_loading?: boolean;              // true = 延遲載入,靠 tool search 才發現
  allowed_callers?: ('direct' | 'code_execution')[];  // 誰能呼叫:LLM 直呼 / 只能 PTC 沙箱
};
type AgentToolOptions = Record<string, ToolOptions>; // key: 例如 "search_mcp_github"
```

### `subagents`(`assistants.ts:254`)

```ts
type AgentSubagentsConfig = {
  enabled?: boolean;      // 只有 === true 才算開啟(undefined/null/false 皆為關)
  allowSelf?: boolean;    // 預設 true:可把自己當子 agent 在隔離 context 生成
  agent_ids?: string[];   // 可被生成的具體 agent(上限 MAX_SUBAGENTS = 10)
};
```

runtime 還有一層深度限制 `MAX_SUBAGENT_DEPTH = 5`(`config.ts:2678`),防止 A→B→A 無限展開。

### `GraphEdge`(`packages/data-provider/src/types/agents.ts:647`)

multi-agent 圖的一條邊。這是 LibreChat 從「線性 chain」演進到「圖」的關鍵結構:

| 欄位 | 型別 | 用途 |
|---|---|---|
| `from` | `string \| string[]` | 來源 agent ID(可多來源)。 |
| `to` | `string \| string[]` | 目標 agent ID(可多目標)。 |
| `edgeType` | `'handoff' \| 'direct'` | `handoff`=生成動態路由工具讓 supervisor 決定轉交;`direct`=直接邊,可平行執行。 |
| `condition` | `(state) => boolean\|string\|string[]` | 條件路由(僅 runtime,不持久化函式)。 |
| `prompt` | `string \| fn` | direct:轉場時附加的 prompt(可用 `{results}` 變數);handoff:轉交工具的參數描述。 |
| `promptKey` | `string` | handoff:自訂輸入參數名(預設 `instructions`)。 |
| `excludeResults` | `boolean` | 用 `{results}` 時自動為 true。 |
| `description` | `string` | 邊的說明。 |

注意:`condition`/`prompt` 可以是函式,但這些只在程式化建構圖時存在;經 REST 進來的 agent,zod 會把空字串轉 `undefined`,而函式型 `prompt` 走 `z.function()`(`validation.ts:281`),實務上使用者介面只送字串。

### `AgentCapabilities` 全清單(`config.ts:562`)

endpoint 級能力開關,共 16 個:

`hide_sequential_outputs`、`programmatic_tools`、`end_after_tools`、`deferred_tools`、`execute_code`、`file_search`、`web_search`、`artifacts`、`subagents`、`actions`、`context`、`skills`、`memory`、`tools`、`chain`、`ocr`。

`defaultAgentCapabilities`(`config.ts:679`)是預設開啟集合——注意 `programmatic_tools` 預設**被註解掉**(需要最新 Code Interpreter API)。部署者可在 `librechat.yaml` 覆寫。controller 用 `isSubagentsCapabilityEnabled`(`v1.js:180`)這種方式讀 `req.config.endpoints.agents.capabilities` 來決定要不要做對應的驗證。

---

## 版本機制

出處:`methods/agent.ts` 的 `createAgent`、`updateAgent`、`isDuplicateVersion`、`revertAgentVersion`、`getAgentVersions`、`getAgentWithVersionCount`。

### 快照怎麼建

- **建立時**(`createAgent:336`):把整份 agentData(除了 `author`)複製一份當作 `versions[0]`,帶上 `createdAt`/`updatedAt`。
- **更新時**(`updateAgent:464`):
  1. 撈當前文件,去掉 `_id`/`id`/`versions`/`author`,剩下的當作「當前版本快照基底」。
  2. 若這次更新有實質內容變更(`directUpdates` 非空,或有 `$push`/`$pull`/`$addToSet`),且未 `skipVersioning`,就準備建立新版本。
  3. 呼叫 `isDuplicateVersion` 判斷「套用這次更新後的狀態」是否等於最後一個版本;若相同且非 `forceVersion`,**直接回傳、不建版本**(避免頭像 refresh 這類無意義更新灌爆歷史)。
  4. 否則把 `{...當前快照, ...directUpdates, updatedAt, updatedBy}` 用 `$push` 推進 `versions`。

### 去重(dedup)的細節與陷阱

`isDuplicateVersion`(`methods/agent.ts:70`)逐欄位比對,排除 `_id`/`id`/時間戳/`author`/`updatedBy`/`versions`/`actionsHash` 等。要留意幾個 edge case:

- **陣列**:長度不同直接視為不同;物件陣列會 `JSON.stringify` 後排序再逐一比對(順序無關)。
- **物件**:`JSON.stringify` 整體比對(**對鍵順序敏感**——這是潛在的假陰性來源)。
- **primitive 的「空值等價」**:`false` vs `undefined`、`''` vs `undefined` 視為相同(`methods/agent.ts:182`),避免「使用者沒填」和「明確填 false/空字串」被當成不同版本而產生噪音版本。
- **actions 雜湊**:agent 有 actions 時,會抓 action metadata 算 SHA-256 雜湊(`generateActionMetadataHash:208`)。若最後版本的 `actionsHash` 與現在不同,就一定當作新版本——因為 action 的 metadata 存在別的 collection,光比對 agent 文件看不出 action 內容變了。

### revert

`revertAgentVersion(searchParameter, versionIndex)`(`methods/agent.ts:961`):

- 取 `versions[versionIndex]`,刪掉 `_id`/`id`/`versions`/`author`/`updatedBy`,直接 `findOneAndUpdate` 覆寫當前欄位。
- **注意:revert 本身不 push 新版本**(它是直接覆寫,不走 `updateAgent`),但 controller 端後續若因工具授權/檔案清理而再 `updateAgent`,那次才會產生版本。
- **skills 自癒**:版本快照可能早於某次 skill 刪除,直接還原會復活「懸空的 skill 白名單 ID」(白名單非空但實際交集為空 = 靜默停用 skill)。所以 revert 時也會 `filterExistingSkillIds`,若清空則 fail-closed(`skills_enabled = false`)。同樣的自癒在 `createAgent`/`updateAgent` 都有。

### 惰性載入

版本陣列可能很大,所以:

- `getAgentWithVersionCount`(`methods/agent.ts:395`):用 aggregate 算 `version = size(versions)`,再 `$project: { versions: 0 }` 把陣列排除。編輯器載入 agent 時用這個。
- `getAgentVersions`(`methods/agent.ts:378`):只投影 `versions` 欄位,經 `GET /agents/:id/versions` 惰性抓取(route `v1.js:92`)。

---

## Ephemeral Agent(臨時 agent)

出處:`packages/api/src/agents/load.ts`、`packages/data-provider/src/parsers.ts`、`config.ts:2668`。

- **常數 `EPHEMERAL_AGENT_ID = 'ephemeral'`**(`config.ts:2668`)是佔位符;實際的 ephemeral ID 由 `encodeEphemeralAgentId` 編碼出來,格式 `endpoint__model___sender____index`:
  - `:` → `__`(因為 `:` 在 graph node 名裡是保留字元)
  - `___`(三底線)分隔 sender
  - `____`(四底線)分隔可選的 index(multi-convo 用)
  - 例:`openAI__gpt-4o___GPT-4o`、`openAI__gpt-4o___GPT-4o____1`
- **判定**:`isEphemeralAgentId(id) = !id?.startsWith('agent_')`(`parsers.ts:590`)。這個「非黑即白」的判定意味著任何不以 `agent_` 開頭的 ID 都被當作 ephemeral,包含 encode 出來的字串。
- **來源資料**:`TEphemeralAgent`(`types.ts:104`)—— `{ mcp?, web_search?, file_search?, execute_code?, artifacts?, skills?, memory? }`,由前端在聊天 payload 裡帶上。
- **合成**:`loadEphemeralAgent`(`load.ts:48`)把這些 flag 轉成 `tools[]`,套上 modelSpec 的預設(`executeCode`/`webSearch`/`mcpServers`/`subagents`/`skills`),組出一個 `Partial<Agent>`。**沒有 `_id`、`author`、`versions`,完全不落地。**
- **設計目的**:讓「一般聊天 + 幾個開關」不必逼使用者先去 Agent Builder 建一個持久 agent,降低使用門檻,同時重用同一套 runtime。

---

## 市集(Marketplace)欄位

- **`category`**(String, indexed, 預設 `'general'`):agent 的分類。另有一張 `AgentCategory` collection(`schema/agentCategory.ts`)存分類的顯示資訊(`value`/`label`/`description`/`order`/`isActive`/`custom`),同樣帶 `tenantId` 並有 `{ value: 1, tenantId: 1 }` 複合唯一索引。
- **`is_promoted`**(Boolean, indexed, 預設 false):市集置頂「推薦」。`countPromotedAgents`(`methods/agent.ts:1009`)算數量,`getAgentCategories`(`controllers/agents/v1.js:1319`)在分類清單最前面插入一個虛擬的 `promoted` 分類(僅當有推薦 agent 時)、最後補一個 `all`。
- **`support_contact`** / runtime 附掛的 **`owner_contact`**:市集頁顯示的聯絡資訊。清單查詢會 `attachOwnerContacts` 補上作者聯絡資料。
- **清單篩選**(`getListAgentsHandler:980`):支援 `category`、`search`(對 `name`/`description` 做 regex,已跳脫特殊字元且截長至 100)、`promoted`(`1`/`0`)、`cursor`、`limit`、`requiredPermission`。

---

## 多租戶(tenantId)

出處:`schema/agent.ts:128`、`models/agent.ts`、`packages/data-schemas/src/models/plugins/tenantIsolation.ts`。

多租戶不是在每個 query 手動加 `tenantId`,而是靠 Mongoose plugin + AsyncLocalStorage 隱式完成:

- **模型層套用**:`createAgentModel`(`models/agent.ts`)在建立 model 前呼叫 `applyTenantIsolation(agentSchema)`。
- **查詢注入**:plugin 對 `find`/`findOne`/`findOneAndUpdate`/`updateMany`/`countDocuments`/`aggregate`/... 全部掛 `pre` hook,從 async context 取當前 `tenantId`,自動 `this.where({ tenantId })`(aggregate 則 unshift 一個 `$match`)。
- **寫入注入**:`pre('save')`/`pre('insertMany')` 若文件沒有 `tenantId` 就補上當前租戶。
- **變更防護**:`updateGuard`/`replaceGuard` 阻止跨租戶把 `tenantId` 改掉;`$unset`/`$rename` tenantId 一律 strip。
- **system 逃生門**:`tenantId === SYSTEM_TENANT_ID` 時跳過注入(平台級跨租戶操作,例如遷移)。
- **strict 模式**:`TENANT_ISOLATION_STRICT=true` 時,沒有租戶 context 就 throw(fail-closed);否則放行(過渡期/未啟用多租戶)。
- **唯一性**:因為隔離是查詢層加的,`id` 的唯一索引必須是複合的 `{ id, tenantId }`,不同租戶才能有相同 `id`。

結論:方法層程式碼(`methods/agent.ts`)幾乎看不到 `tenantId`,它是被「攔截式中介層」偷偷加進去的。這是很優雅但也很容易踩雷的設計——見下方陷阱。

---

## CRUD API(`api/server/routes/agents/v1.js`)

所有路由都先過 `requireJwtAuth`。權限用兩層:endpoint 級 RBAC(`checkAgentAccess`/`checkAgentCreate`)+ 資源級 ACL(`canAccessAgentResource`,檢查 VIEW/EDIT/DELETE 位元)。

| Method & Path | 中介層 | Controller | 說明 |
|---|---|---|---|
| `POST /agents` | `checkAgentCreate` | `createAgent` | 建立 agent;生成 `agent_<nanoid>`,授予 owner ACL(AGENT + REMOTE_AGENT)。 |
| `GET /agents/:id` | `checkAgentAccess` + ACL VIEW | `getAgent` | 精簡資訊(不含敏感設定),附 `version` 計數。 |
| `GET /agents/:id/expanded` | ACL EDIT | `getAgent(…, true)` | 完整設定(編輯用)。 |
| `GET /agents/:id/versions` | ACL EDIT | `getAgentVersions` | 惰性取版本歷史。 |
| `PATCH /agents/:id` | `checkAgentCreate` + ACL EDIT | `updateAgent` | 更新;建立版本快照。 |
| `POST /agents/:id/duplicate` | `checkAgentCreate` + ACL EDIT | `duplicateAgent` | 複製 agent + 其 actions(去敏感欄位)。 |
| `DELETE /agents/:id` | `checkAgentCreate` + ACL DELETE | `deleteAgent` | 刪除 + 級聯清理。 |
| `POST /agents/:id/revert` | `checkAgentCreate` + ACL EDIT | `revertAgentVersion` | 還原到 `version_index`。 |
| `GET /agents` | `checkAgentAccess` | `getListAgents` | ACL-aware cursor 分頁清單。 |
| `GET /agents/categories` | (只 JWT) | `getAgentCategories` | 市集分類 + 計數。 |
| `POST /agents/:agent_id/avatar` | `checkAgentAccess` + ACL EDIT | `uploadAgentAvatar` | 上傳頭像(resize、換檔、清舊檔)。 |
| `/agents/actions`、`/agents/tools` | `configMiddleware` | 子路由 | action / 可用工具清單(見 07-tool-system.md、09-actions-openapi.md)。 |

刪除的**級聯清理**(`deleteAgent`,`methods/agent.ts:724`):除文件本身外,還清 ACL 權限(AGENT + REMOTE_AGENT)、把其他 agent `edges.to` 指向它的邊 `$pull` 掉、把使用者 `favorites` 裡的引用清掉。`deleteUserAgents` 則處理帳號刪除時的批次清理,並特別照顧「pre-ACL 的舊 agent(只有 author、沒有 ACL entry)」不被遺漏。

---

## 關鍵實作細節與陷阱

- **`id` vs `_id` 的雙軌**:edges/subagents/favorites/URL 都用字串 `id`,ACL/刪除級聯用 `_id`。程式裡到處要在兩者間轉換,回應時還要把 `author`(ObjectId)`toString()` 並在非本人時 `delete`。移植時若只保留一個 ID 會簡化很多,但要留意 `id` 需要在租戶內唯一且對外穩定(不隨主鍵策略改變)。

- **`mcpServerNames` 必須與 `tools` 同步**:這是反正規化欄位。`createAgent`/`updateAgent` 都在寫入前 `extractMCPServerNames(tools)` 重算(`methods/agent.ts:50`)。若哪條寫入路徑忘了同步,MCP 相關查詢(如 `hasAgentWithMCPServerName`)就會失準。任何「衍生欄位」都有這種一致性維護成本。

- **每次寫入都重跑工具授權**:`filterAuthorizedTools`(`controllers/agents/v1.js:206`)在 create/update/duplicate/revert 都會跑,把使用者無權使用的 MCP 工具剔除。特例:MCP registry 暫時不可用(伺服器重啟)時,若工具本來就在 agent 上,會保留而非誤刪(`existingTools` 白名單)。安全考量:MCP 工具鍵格式必須剛好 `name_mcp_server`(2 段),多段一律拒絕以防授權/執行對不上。

- **檔案擁有權過濾**:`pruneToolResourceFileIdsForOwner`(`v1.js:299`)確保 `tool_resources` 裡的 `file_id` 都屬於 agent owner,否則剔除。防止使用者透過 API 把別人的檔案掛到 agent 上。

- **skills fail-closed 語意**:「白名單為空 + 啟用 = 全部 skill」。所以當自癒把懸空 ID 清光導致白名單變空時,必須同時 `skills_enabled = false`,否則會「意外放大範圍」變成全開。這個 invariant 在 create/update/revert 三處都要維持——是很容易在移植時漏掉的安全細節。

- **版本去重對鍵順序敏感**:物件欄位用 `JSON.stringify` 比對(`methods/agent.ts:174`),若兩次寫入的物件內容相同但鍵順序不同,會被誤判為「不同版本」而產生噪音版本。移植時建議改用穩定序列化或深度相等比較。

- **subagents ACL 檢查的 gate 要與 runtime 一致**:controller 只在「capability 開 **且** `subagents.enabled === true` **且** `agent_ids` 非空」時才做嚴格 ACL 檢查(`v1.js:388`)。因為 runtime 用「truthy 判斷 `enabled`」,若 ACL gate 更嚴格,會出現「存不了但跑起來會 no-op」的矛盾;反之若更寬鬆,則有權限繞過風險。edges 的檢查則更寬鬆(允許 `from` 自我引用尚未存在的 agent)。這種「驗證層與執行層必須對齊」是 multi-agent 授權的通用陷阱。

- **tenant plugin 依賴 async context**:任何在 async context 之外(背景 job、CLI、migration)對 Agent 的查詢,strict 模式會直接 throw;非 strict 則不做隔離、可能跨租戶讀到資料。移植成 PostgreSQL 時,對應物是 request-scoped 的 tenant 過濾(見下)——要小心背景任務同樣要帶租戶。

- **Mixed 型別 = DB 端零驗證**:`tool_resources`/`versions`/`tool_options`/`subagents`/`edges` 在 schema 都是 `Schema.Types.Mixed`,MongoDB 不驗結構,全靠 zod 在 API 層把關。這是「彈性換掉型別安全」的取捨,任何繞過 API 直接寫 DB 的路徑都沒有保護。

- **duplicate 去敏感**:複製 agent 時會複製其 actions,但清掉 `api_key`/`oauth_client_id`/`oauth_client_secret`(`v1.js:787`),並只保留 `context`/`ocr` 類的 `tool_resources`(不帶其他人的檔案)。

---

## 設計決策分析

- **內嵌版本 vs 獨立版本表**:LibreChat 把 `versions` 內嵌在同一份文件。優點是讀寫版本無需 join、原子性天然(一份文件一次寫完);缺點是文件會隨版本數膨脹(MongoDB 單文件 16MB 上限)、每次讀取容易誤帶整個歷史(所以才需要 `getAgentWithVersionCount` 這種投影排除的補救)。對「版本數有限、且大多不需要」的場景是合理取捨,但不是可無限成長的設計。

- **反正規化 `mcpServerNames`**:用空間與一致性維護成本,換 MCP 查詢的速度(避免對 `tools` 陣列做字串掃描)。符合專案「用資料結構減少迭代」的原則,但代價是多一個必須手動保持同步的欄位。

- **公開 `id` 與內部 `_id` 分離**:好處是對外識別碼(`agent_xxx`)可讀、可跨系統引用、與主鍵策略解耦(換 DB 也不影響對外 ID);壞處是全程要在兩套 ID 間轉換,程式碼變囉嗦。

- **ephemeral 用「編碼字串」而非 flag**:把 endpoint/model/sender 塞進 ID 字串,讓 runtime 不必查 DB 就能還原 agent 身分,也讓同一套 graph 執行邏輯同時服務持久與臨時 agent。代價是那套多層底線的編碼/解碼規則很脆弱(model 名可能含 `:`、sender 可能含 `:`),`parseEphemeralAgentId` 為此寫了一堆還原邏輯。

- **capabilities 放 endpoint 而非 agent**:讓管理者一次控制整個部署允許的功能,agent 只描述「用了什麼」。好處是治理集中;壞處是同一個 agent 在不同部署行為可能不同(某能力被關掉時 runtime 會靜默剝除)。

- **若重做會怎麼選**:版本改成獨立表(agent_versions)配 cursor 分頁,主文件只留 `latest_version` 指標;`tool_resources`/`tool_options` 這類半結構化資料用 `jsonb` + 應用層 zod;衍生欄位(`mcpServerNames`)改由 DB 觸發器或寫入時的單一 service 函式保證同步,而不是散落在多個方法裡各自 `extractMCPServerNames`。

---

## 移植到新技術棧的建議

目標棧已定案:PostgreSQL + Hono + Next.js + pnpm + Redis + docker-compose。AI 框架尚未定案,候選為 LangGraph / LangChain(1.x `createAgent`)/ deepagents / Vercel AI SDK 四者之一;完整選型比較見 19-framework-options.md。以下 schema/route/Redis/前端建議與框架選擇無關,`### 框架相關對應` 一節則按框架分開討論。

### PostgreSQL schema 草案

用 `jsonb` 承接半結構化欄位,關聯性強的(檔案、版本、ACL)拆表。

```sql
CREATE TABLE agents (
  pk            BIGSERIAL PRIMARY KEY,          -- 內部主鍵(等同 _id)
  id            TEXT NOT NULL,                  -- 公開 ID: 'agent_<nanoid>'
  tenant_id     TEXT NOT NULL,
  author_id     BIGINT NOT NULL REFERENCES users(pk),
  name          TEXT,
  description   TEXT,
  instructions  TEXT,
  avatar        JSONB,                          -- { filepath, source }
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  model_parameters JSONB NOT NULL DEFAULT '{}',
  artifacts     TEXT,                           -- 'default' | 'shadcnui' | 'custom'
  recursion_limit INT,
  tools         TEXT[] NOT NULL DEFAULT '{}',
  skills        TEXT[],
  skills_enabled BOOLEAN,
  actions       TEXT[],
  edges         JSONB NOT NULL DEFAULT '[]',    -- GraphEdge[]
  tool_resources JSONB NOT NULL DEFAULT '{}',
  tool_options  JSONB,
  subagents     JSONB,
  conversation_starters TEXT[] DEFAULT '{}',
  hide_sequential_outputs BOOLEAN,
  end_after_tools BOOLEAN,
  category      TEXT NOT NULL DEFAULT 'general',
  support_contact JSONB,
  is_promoted   BOOLEAN NOT NULL DEFAULT FALSE,
  mcp_server_names TEXT[] NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id)                        -- 對應 { id, tenantId } 複合唯一
);
CREATE INDEX agents_tenant_updated_idx ON agents (tenant_id, updated_at DESC, pk);
CREATE INDEX agents_category_idx  ON agents (tenant_id, category);
CREATE INDEX agents_promoted_idx  ON agents (tenant_id, is_promoted);
CREATE INDEX agents_mcp_gin       ON agents USING GIN (mcp_server_names);
CREATE INDEX agents_edges_gin     ON agents USING GIN (edges jsonb_path_ops);

-- 版本拆表,避免主文件膨脹;查詢計數用 count(*) 或維護一個 version_count 欄位
CREATE TABLE agent_versions (
  pk         BIGSERIAL PRIMARY KEY,
  agent_pk   BIGINT NOT NULL REFERENCES agents(pk) ON DELETE CASCADE,
  version_index INT NOT NULL,
  snapshot   JSONB NOT NULL,                    -- 整份 agent 狀態
  actions_hash TEXT,
  updated_by BIGINT REFERENCES users(pk),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_pk, version_index)
);
```

要點:
- `UNIQUE (id, tenant_id)` 直接對應複合唯一索引,天然支援多租戶同 `id`。
- `edges` 的反向清理(刪 agent 時清別人指向它的邊)用 `edges @> '[{"to":"agent_x"}]'` 配 GIN 索引查,再更新;比 MongoDB 的 `edges.to` 索引稍麻煩,但可行。
- 版本拆表後,「惰性載入」自然成立:list/detail 不 join `agent_versions`,只在 `/agents/:id/versions` 才查。
- 去重邏輯改在應用層做(拉最後一版 snapshot 做深度相等),或用 `snapshot` 的穩定序列化 + hash 欄位比對,避免 MongoDB 版本那種鍵順序敏感的坑。

### Hono route/middleware 對應

Hono 的 middleware 鏈可直接對應 Express 版:

```ts
const agents = new Hono();
agents.use('*', requireJwt);                        // ← requireJwtAuth
agents.use('*', tenantContext);                     // ← 建立 AsyncLocalStorage 租戶 context
agents.post('/', rbac('AGENTS', ['USE','CREATE']), createAgent);
agents.get('/:id', rbac('AGENTS',['USE']), acl('VIEW','id'), getAgent);
agents.get('/:id/expanded', acl('EDIT','id'), getAgentExpanded);
agents.patch('/:id', rbac('AGENTS',['USE','CREATE']), acl('EDIT','id'), updateAgent);
agents.delete('/:id', acl('DELETE','id'), deleteAgent);
agents.post('/:id/revert', acl('EDIT','id'), revertAgent);
agents.get('/', rbac('AGENTS',['USE']), listAgents);
```

- 用 Hono 的 `c.set('tenantId', …)` + `AsyncLocalStorage`(或 request context)重現隱式租戶注入;但更建議在 PostgreSQL 端用 **Row-Level Security(RLS)**:`SET LOCAL app.tenant_id = ...` 搭配 `CREATE POLICY`,把「查詢自動加租戶條件」下推到 DB,比 ORM plugin 更難繞過。這正好對應 LibreChat 那個 tenantIsolation plugin,但更安全。
- zod schema(create/update)幾乎可原封不動搬過來,它本來就不綁 Mongo。

### 框架相關對應

AI 框架四選一尚未定案(LangGraph / LangChain / deepagents / Vercel AI SDK),完整比較見 19-framework-options.md。這裡只列 agent 資料模型欄位在各框架下的落地方式;核心不對稱是:LibreChat 的 `@librechat/agents` 本身就是 LangGraph 封裝,選 LangGraph 系(LangGraph / LangChain / deepagents)時,`edges`、`subagents`、`recursion_limit` 的對應可高度直接參考 LibreChat 現行 runtime;選 Vercel AI SDK 時,multi-agent graph、subagent 隔離、deferred tool loading 等能力多數要自建。

| agent 欄位 | LangGraph | LangChain | deepagents | Vercel AI SDK |
|---|---|---|---|---|
| `tools[]` / `tool_options.defer_loading` | 自建 tool node,defer 靠自建工具搜尋節點 | `createAgent({ tools })`,defer 需自建 middleware | 同 LangChain,可疊加官方 middleware | `tools` 參數(`tool({ description, inputSchema, execute })`);defer 無直接對應,需自建工具目錄 + `search_tools` 元工具 |
| `recursion_limit` / `end_after_tools` | `recursionLimit`(LibreChat 現制,可直接沿用) | 同左(`createAgent` 底層仍是 LangGraph `recursionLimit`) | 同左(`createDeepAgent` 回傳編譯好的 LangGraph 圖) | `stopWhen: stepCountIs(N)`(預設 20);`end_after_tools` 需用 `prepareStep` 手動終止 |
| `edges`(multi-agent graph / handoff) | 原生任意拓撲、subgraph、conditional edges——`edges` 幾乎是現行 graph 模型的直接映射 | 單 agent 為主,圖狀 handoff 通常要下探 LangGraph | subagent 委派內建,但 `direct` 平行拓撲仍要下探 LangGraph | 無圖原語:`handoff` 可包成 handoff 工具;`direct` 平行需自建 orchestrator(handoff-as-tool + 外層 loop,`prepareStep` 可做輕量版) |
| `subagents` | subgraph + 自建 spawn 邏輯 | 可掛 deepagents 的 `createSubAgentMiddleware` | 內建 `task` 工具原生 spawn ephemeral subagent、隔離 context、回傳單一報告,與 `enabled`/`allowSelf`/`agent_ids` 語意最接近 | tool 的 `execute` 內再開一個 agent 呼叫;`MAX_SUBAGENTS`/`MAX_SUBAGENT_DEPTH` 需自建計數器把關,usage 回流也要自理 |
| `model_parameters` | 展開成 model 呼叫參數 | 同左 | 同左 | 展開成 `streamText({ model, temperature, topP, maxOutputTokens, ... })` |

若最終選 Vercel AI SDK,上表「自建」項目的落地細節(orchestrator、subagent context 隔離、defer_loading 工具目錄)在移植前應先評估工作量;若選 LangGraph 系,則可先讀 04-execution-engine.md、05-multi-agent.md 對照現行實作再裁剪。

### Redis 的用途

對應 LibreChat 用 cache 的地方:

- **頭像 S3 簽名 URL 快取**:`getListAgentsHandler` 用 `${userId}:agents_avatar_refresh` 快取 30 分鐘,避免每次列表都重簽 URL。移到 Redis,key TTL 30m。
- **工具/MCP registry 快取**:`getCachedTools()`、MCP server 設定的解析結果,適合放 Redis 讓多個 Hono 實例共享。
- **分類計數**:`getAgentCategories` 的 category counts 與 promoted count 可短 TTL 快取,降低市集頁的聚合查詢壓力。
- ephemeral agent **不需要** Redis——它本來就只活在單次請求內。

### Next.js 前端考量

- Agent Builder 表單用 React Server Components 拉 `/agents/:id/expanded`(EDIT),清單頁用 `/agents`(VIEW);對應 LibreChat 前端的 React Query 資料流(見 CLAUDE.md 的 data-provider 慣例)。
- **cursor 分頁**:沿用 LibreChat 的 base64 cursor(`{ updatedAt, _id }`)概念,PostgreSQL 版改成 `(updated_at, pk)` 的 keyset 分頁——`WHERE (updated_at, pk) < ($cursor_ts, $cursor_pk) ORDER BY updated_at DESC, pk ASC`。適合無限捲動的市集清單。
- 版本歷史頁才去打 `/agents/:id/versions`,對應惰性載入,別在編輯頁一次撈整個歷史。
- 敏感欄位(`author`、完整 `tool_resources`、`api_key` 類 action metadata)在後端就要依權限剝除,不要靠前端隱藏——LibreChat 的 `getAgent` 精簡回應正是這個原則。
