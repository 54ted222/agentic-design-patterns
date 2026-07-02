# 08. MCP 整合

> 讀者背景:你要用 **PostgreSQL + Hono + Next.js + pnpm + Redis + docker-compose** 從零打造 AI agent 平台;AI agent 框架(LangGraph / LangChain / deepagents / Vercel AI SDK)尚未定案,完整選型對照見 19-framework-options.md。本文件拆解 LibreChat(MongoDB + Express + 自製 `@librechat/agents`——底層即 LangGraph 封裝 + Vite/React)如何整合 MCP(Model Context Protocol),重點是「它為什麼這樣設計」與「移植時該怎麼取捨」,而不是照抄它的寫法。
>
> 前置:agent 工具池與 tool calling 的整體脈絡見 07-tools-and-agents(若存在);本文件只守 MCP 這一塊。

---

## 定位

MCP 是一個開放協定,讓 LLM agent 能連到外部「工具伺服器」(檔案系統、GitHub、資料庫、SaaS API…),透過標準化的 `tools/list`、`tools/call`、`resources`、`prompts` 等 JSON-RPC method 取得能力。LibreChat 的 MCP 子系統負責:

- **接上多種 transport**:stdio(本機子行程)、SSE、Streamable HTTP、WebSocket。
- **把 MCP server 宣告的 tools 轉成 agent 可用的 function tools**,並注入到每次對話的工具池。
- **管理連線生命週期**:app 層共享連線 vs. per-user 連線 vs. per-request 短命連線。
- **處理認證**:OAuth 2.0(含 RFC 9728 discovery)、API key、customUserVars、OBO(On-Behalf-Of)委派 token。
- **多來源設定與權限**:operator 的 `librechat.yaml`、admin 的 config override、user 從 UI 自建的 server,各有不同信任等級與 ACL。

在整體架構中,MCP 子系統夾在「設定系統」(見 03-config 之類)與「agent 執行迴圈」之間:啟動時把 server 設定 inspect 成工具定義快取,對話時把工具實例化並在 tool call 觸發時建立/複用連線、必要時打斷去跑 OAuth,再把結果格式化回傳給 model。

程式碼分布:
- 型別、連線、registry、OAuth、工具轉換等**核心邏輯在 TypeScript** 的 `packages/api/src/mcp/`。
- `/api`(legacy Express/JS)只是**薄封裝**:啟動接線(`api/server/services/initializeMCPs.js`)、singleton 取用(`api/config/index.js`)、HTTP route/controller、以及把 MCP tool 接進 LangChain-style `tool()` 實例(`api/server/services/MCP.js`)。

---

## 核心概念

| 名詞 | 心智模型 |
|---|---|
| **MCP server** | 一個外部工具提供者。有 `type`(stdio/sse/streamable-http/websocket)、URL 或 command、認證方式、以及一組 tools。 |
| **Server source(信任等級)** | `yaml`(operator 在 `librechat.yaml` 定義,開機 inspect,全信任)、`config`(admin 透過 config override 定義,lazy inspect,全信任)、`user`(使用者 UI 自建,存 DB,**沙箱化**:只解析 `customUserVars`,不解析 runtime placeholder)。見 `packages/api/src/mcp/types/index.ts:155`。 |
| **Registry** | `MCPServersRegistry`,所有 server 設定的唯一真相來源。三層儲存:YAML cache → Config cache → DB。負責 inspect、快取、合併、per-request 解析。 |
| **Inspect** | 連上 server 抓 capabilities/instructions/tools,把 raw config 加工成 `ParsedServerConfig`(含 `toolFunctions`、`requiresOAuth`、`tools` 摘要)。 |
| **Manager** | `MCPManager`(繼承 `UserConnectionManager`),singleton,管所有連線與 `callTool`。 |
| **App connection vs. User connection vs. Ephemeral connection** | app 層共享連線(無 per-user 內容);user 層連線(OAuth/OBO/customUserVars/runtime placeholder 需要使用者上下文);ephemeral(request-scoped,含 `{{LIBRECHAT_BODY_*}}` 這種每次請求都變的 placeholder,用完即拋)。 |
| **mcp_delimiter / mcp_all / mcp_server** | 工具命名協定。tool 在 agent 工具池的 key 是 `<toolName>_mcp_<serverName>`;`mcp_all` 是特殊值代表「這個 server 的全部工具」;`mcp_server` 是 UI 佔位符。見 `packages/data-provider/src/config.ts:2649`。 |
| **Flow / FlowStateManager** | OAuth 這種跨 HTTP 請求、跨 replica 的非同步流程,用 Keyv-backed 的 flow state(PENDING/COMPLETED/FAILED)協調。 |
| **OBO(On-Behalf-Of)** | server 用「當前使用者」的委派 token 呼叫下游 API(如 Microsoft Graph)。每次 tool call 重新 mint token,並重新檢查設定者是否仍有權限。 |

---

## 架構與流程

### 元件關係

```
                 ┌─────────────────────────────────────────────────┐
  librechat.yaml │            MCPServersRegistry (singleton)        │
  admin config ─▶│  YAML cache │ Config cache │ DB repo (+ ACL)     │
  UI (DB)        │  read-through cache · allowlist resolver         │
                 └───────▲──────────────────────────┬──────────────┘
                         │ getServerConfig          │ inspect()
                         │                          ▼
                         │                 ┌──────────────────┐
                         │                 │ MCPServerInspector│  detectOAuth / fetchTools
                         │                 └──────────────────┘
                 ┌───────┴──────────────────────────────────────────┐
                 │              MCPManager (singleton)               │
                 │  extends UserConnectionManager                    │
                 │  ┌────────────────┐  ┌──────────────────────────┐ │
                 │  │ appConnections │  │ userConnections          │ │
                 │  │ (Repository)   │  │ Map<userId,Map<srv,conn>>│ │
                 │  └────────────────┘  └──────────────────────────┘ │
                 │  getConnection · callTool · discoverServerTools   │
                 └───────┬───────────────────────────────┬──────────┘
                         │ MCPConnectionFactory.create    │
                         ▼                                ▼
                 ┌──────────────┐              ┌───────────────────┐
                 │ MCPConnection│──JSON-RPC──▶ │ external MCP server│
                 │ (transport)  │  circuit brk │ (stdio/http/sse/ws)│
                 └──────────────┘              └───────────────────┘

  OAuth 側:  routes/mcp.js (initiate/callback) ─▶ MCPOAuthHandler ─▶ FlowStateManager
             OAuthReconnectionManager(登入後重連) · MCPTokenStorage(token 存 DB)
```

### 流程 A:啟動初始化

出處:`api/server/index.js:319`(`runAsSystem` 內先 `initializeMCPs()` 再 `initializeOAuthReconnectManager()`)。

1. `initializeMCPs()`(`api/server/services/initializeMCPs.js:24`)取得 base config,呼叫 `createMCPServersRegistry(mongoose, allowedDomains, allowedAddresses, resolveMCPAllowlists)` 建立 registry singleton。注意這裡注入了一個 **allowlist resolver**,讓 registry 每次要決策時能拿到「租戶/使用者 scope 的合併 config」而不需重啟(`initializeMCPs.js:13`)。
2. `createMCPManager(mcpServers)` → `MCPManager.createInstance`(`MCPManager.ts:57`)→ `initialize()` → `MCPServersInitializer.initialize(configs)`。
3. `MCPServersInitializer`(`registry/MCPServersInitializer.ts:62`)做 **cluster leader-follower 協調**:用 config 的 sha256 fingerprint 判斷是否已初始化;只有 leader 真的 reset cache 並逐一 `initializeServer`,follower 輪詢 `statusCache`(3 秒 retry,有 max wait 後自行初始化以防 leader crash)。
4. 每個 server:`registry.addServer(name, rawConfig, 'CACHE')` → `MCPServerInspector.inspect()`(`registry/MCPServerInspector.ts:42`)。inspect 會:先驗 domain allowlist、`detectOAuth()`、若 `startup !== false` 且無需使用者上下文則建臨時連線抓 instructions/capabilities/tools,存成 `toolFunctions`。inspect 失敗則存一個 `inspectionFailed: true` 的 stub(`addServerStub`)供之後 reinitialize 復原。
5. 回到 `initializeMCPs`:`mcpManager.getAppToolFunctions()` 蒐集所有 config 的 `toolFunctions`,`mergeAppTools()` 寫進全域工具快取(`tools.ts:125`)。
6. `initializeOAuthReconnectManager()` 建立 `OAuthReconnectionManager` singleton,注入 flowManager + tokenMethods(`api/server/services/initializeOAuthReconnectManager.js`)。

### 流程 B:對話時把 MCP 工具注入 agent 工具池

出處:`api/app/clients/tools/util/handleTools.js:239-545`(`loadTools`)。

1. 判斷 `tools` 陣列裡是否有符合 `mcpToolPattern`(`/^.+_mcp_.+$/`,`packages/api/src/mcp/utils.ts:5`)的工具名,並用 `mcpPermissionContext.canUseServers(user)` 檢查權限(`handleTools.js:242`)。
2. 若有,`resolveConfigServers(req)` 先把 admin config-source server lazy-init(`MCP.js:120`)。
3. 逐一分類每個 MCP tool 名稱(`handleTools.js:374-417`):`tool.split(mcp_delimiter)` 得 `[toolName, serverName]`;`mcp_server` 跳過(UI 佔位);`getServerConfig` 拿不到就 warn 跳過;`toolName === mcp_all` 標記為 `type: 'all'`(載入整個 server),否則 `type: 'single'` 記下 `toolKey`。
4. 實例化(`handleTools.js:472-544`):對每個 server,`type: 'all'` 走 `createMCPTools`(重連並產生全部工具),`single` 走 `createMCPTool`(從快取 `availableTools` 拿定義,拿不到才重連)。這裡用 `requestScopedConnections`(WeakMap-per-req 的 request context,`packages/api/src/mcp/request.ts`)讓同一次請求的短命連線可共用、請求結束自動 disconnect。
5. `createMCPTool`(`MCP.js:624`)最終回傳一個 `@librechat/agents` 的 `tool()` 實例:name 是 normalize 過的 `<toolName>_mcp_<normalizedServerName>`,`_call` 內做權限複查 + `mcpManager.callTool`。工具找不到定義時回傳 `createUnavailableToolStub`(給 model 一個「暫時無法使用」的假工具而非直接消失,`MCP.js:211`)。

### 流程 C:tool call 執行(含 OAuth 打斷)

出處:`MCP.js:769`(`_call`)→ `MCPManager.callTool`(`MCPManager.ts:342`)。

1. `_call` 先權限複查(`canUseServers`),建立 `oauthStart`/`oauthEnd`(把 auth URL 透過 SSE run-step event 推給前端)、abort handler。
2. `callTool` → `getConnection`(`MCPManager.ts:77`):依 config 決定走 app 連線還是 `getUserConnection`。若 `requiresUserScopedConnection`(OAuth/OBO/customUserVars/runtime placeholder)一定走 user 連線。
3. 連線建立時,若需要 OAuth 但沒有有效 token,`MCPConnectionFactory` 會透過 `oauthStart` 發出 auth URL 並(依 `returnOnOAuth`)拋 `OAuth flow initiated - return early`。tool loading 階段(`returnOnOAuth: false`)會等使用者完成;discovery 階段(`returnOnOAuth: true`)則早退。
4. 執行前:`preProcessGraphTokens`(async 解析 Graph token)→ `processMCPEnv`(同步解析 env/header placeholder)→ 若有 OBO,`resolveOboToken` 重新 mint 並檢查設定者權限(`MCPManager.ts:447-485`)→ `connection.setRequestHeaders`。
5. `connection.client.request({ method: 'tools/call', params: { name, arguments } })`,結果經 `formatToolContent`(`parsers.ts:141`)轉成 `[text, artifacts]`。ephemeral 連線在 finally 內 disconnect。

### 流程 D:OAuth 授權(discovery + reconnect)

出處:`api/server/routes/mcp.js`(initiate/callback/status/cancel)、`packages/api/src/mcp/oauth/`。

```
使用者點「連線」
   │  POST /:server/reinitialize ─▶ reinitMCPServer (returnOnOAuth=true)
   │     └─ getConnection 拋 OAuth ─▶ discoverServerTools(免認證列工具, MCP spec 允許)
   │        回傳 oauthRequired + 已探索的 tools + 設 CSRF cookie
   ▼
GET /:server/oauth/initiate  ── 驗 userId/flowId/PENDING/新鮮度 ─▶ redirect 到 auth URL
   ▼
外部 IdP 授權 → GET /:server/oauth/callback?code&state
   │  resolveStateToFlowId → CSRF/session/active-flow 驗證 → completeOAuthFlow(換 token)
   │  MCPTokenStorage.storeTokens(存 access/refresh/client 到 DB, identifier=mcp:<server>)
   │  getUserConnection 重連 → fetchTools → updateMCPServerTools(寫快取)
   │  completeFlow(toolFlowId) 喚醒仍在等的 tool call
   ▼
redirect 到 /oauth/success
```

- **Discovery mode**(`MCPManager.discoverServerTools`,`MCPManager.ts:123`):即使需要 OAuth,也先嘗試免認證列出工具(RFC 對 `tools/list` 允許),讓 model 先看到工具 schema、UI 先顯示「需授權」。
- **OAuth 偵測**(`oauth/detectOAuth.ts:38`):RFC 9728 對齊 —先探 401 challenge 取 `resource_metadata` hint(**會做 SSRF 驗證**,因為 hint 是 server 回傳的、attacker-controlled),再打 protected-resource-metadata,最後 fallback 到 `Bearer` challenge 或 `MCP_OAUTH_ON_AUTH_ERROR`。
- **登入後自動重連**(`OAuthReconnectionManager.reconnectServers`,`oauth/OAuthReconnectionManager.ts:65`):列出所有 OAuth server,對每個判斷 `canReconnect`(有未過期 access token 或有 refresh token 且未在重連中),用 `RECONNECT_STAGGER_MS`(500ms)錯開避免連線風暴。失敗會標 `failed` 停止重試。
- **Flow ID 格式**:`tenant:<tenantId>:<userId>:<serverName>`(無租戶則 `<userId>:<serverName>`),見 `oauth/handler.ts:937`。State→flowId 有獨立 mapping。

---

## 關鍵資料結構

### `ParsedServerConfig`(`packages/api/src/mcp/types/index.ts:157`)

registry 的核心產物,inspect 後的 server 設定。

| 欄位 | 型別 | 用途 |
|---|---|---|
| `type` | `'stdio'\|'sse'\|'streamable-http'\|'websocket'` | transport |
| `url` / `command` / `args` / `env` | string / … | 連線目標與 stdio 參數 |
| `headers` / `oauth` / `oauth_headers` / `apiKey` | object | 各種認證方式 |
| `requiresOAuth` | boolean | inspect 偵測結果;決定連線是否走 OAuth 機制 |
| `oauthMetadata` | object\|null | RFC 9728 protected-resource-metadata |
| `capabilities` / `tools` | string | inspect 抓到的能力與工具名摘要(供 log/UI) |
| `toolFunctions` | `LCAvailableTools` | **key=`<tool>_mcp_<server>`** 的工具定義 map,注入 agent 用 |
| `serverInstructions` | string\|boolean | 注入 system context 的 server 說明 |
| `customUserVars` | `Record<string,{title,description,sensitive?}>` | 需使用者提供的變數宣告 |
| `obo` | object\|null | On-Behalf-Of 委派 token 設定 |
| `source` | `'yaml'\|'config'\|'user'` | 信任等級,決定 placeholder 解析與 ACL |
| `consumeOnly` | boolean | 只能透過 agent 用,不直接給 user |
| `inspectionFailed` | boolean | inspect 失敗的 stub,待 reinspect 復原 |
| `dbId` / `author` | string | DB-sourced 專用;`author` 用於 runtime 重查 OBO 權限 |
| `updatedAt` / `initDuration` | number | 連線 staleness 判斷 / 觀測 |

### `LCAvailableTools`(`types/index.ts:49`)

```ts
type LCFunctionTool = { type: 'function'; function: LCTool };  // LCTool = {name, description, parameters(JSONSchema)}
type LCAvailableTools = Record<string /* `${tool}_mcp_${server}` */, LCFunctionTool>;
```

### 連線狀態與 registry 快取層

| 結構 | 位置 | 說明 |
|---|---|---|
| `appConnections: ConnectionsRepository` | `MCPManager` | app 層共享連線,lazy load;`isAllowedToConnectToServer` 排除需使用者上下文的 server(`ConnectionsRepository.ts:155`) |
| `userConnections: Map<userId, Map<server, MCPConnection>>` | `UserConnectionManager.ts:52` | per-user 連線池,含 idle timeout 清理 |
| `pendingConnections: Map<`userId:server`, PendingConnection>` | `UserConnectionManager.ts:56` | 併發連線去重(coalescing),含 OAuth listener fan-out |
| `readThroughCache` / `readThroughCacheAll` | `MCPServersRegistry.ts:129` | Keyv,memoize 單一/全部 server 查詢,TTL=`MCP_REGISTRY_CACHE_TTL` |
| `configCacheRepo`(key = `server:hash(config+allowlist)`) | `MCPServersRegistry.ts:877` | config-source server 的 lazy-init 結果,**用 config+allowlist 的 hash 當 key 防跨租戶污染** |
| `CircuitBreakerState`(static Map) | `connection.ts:939` | per-server 連線斷路器,防連線風暴 |

### OAuth token 儲存(`oauth/tokens.ts`)

以 `userId + identifier` 存 DB(Token model):`mcp:<server>`(access)、`mcp:<server>:refresh`、`mcp:<server>:client`(動態註冊的 client 資訊)。access token 用 TTL 自然過期,靠 refresh token 續期。

---

## 關鍵實作細節與陷阱

- **工具命名衝突與 normalize**:agent 工具 key 用 `_mcp_` 當分隔符(`mcp_delimiter`),所以 server 名或 tool 名內含 `_mcp_` 會歪。Azure/Vertex 對 function name 有 `^[a-zA-Z0-9_.-]+$` 限制,`normalizeServerName`(`utils.ts:337`)會把非法字元換底線,全非 ASCII 時 fallback 成 `server_<hash>`。移植時務必選一個**不可能出現在 server/tool 名內**的分隔符,或改用結構化 key。

- **三種連線 scope 的判定是核心**(`utils.ts`):
  - `requiresUserScopedConnection`:`requiresOAuth === true` OR `obo` OR 有 `customUserVars` OR 有 runtime context placeholder → 走 user 連線。
  - `requiresEphemeralUserConnection`:含 `{{LIBRECHAT_BODY_*}}`(每次請求都變)→ request-scoped,每次 tool call 重連、**絕不進工具快取**(`tools.ts:58` `isRequestScoped`)。
  - user-sourced server 一律**沙箱**:`isUserSourced` 時所有 runtime placeholder 判定直接回 false(`utils.ts:131,242`),只解析 `customUserVars`。這是防止使用者自建 server 用 `{{LIBRECHAT_USER_*}}` 之類 placeholder 偷資料。

- **SSRF 是貫穿全文的安全主線**:
  - 沒有設 `allowedDomains` allowlist 時,自動開啟 SSRF private-IP 保護(`shouldEnableSSRFProtection`,`MCPServersRegistry.ts:218`)。
  - OAuth discovery 的 `resource_metadata` hint 是 attacker-controlled,fetch 前先 `validateHintUrl`(`detectOAuth.ts:139`)。
  - runtime URL placeholder 解析後會**再驗一次 domain**(`assertResolvedRuntimeConfigAllowed`,`UserConnectionManager.ts:582`),因為 URL 是解析後才知道最終目標(TOCTOU)。

- **allowlist 必須 per-request 解析,不能 process-global**:`mcpSettings.allowedDomains` 是租戶/principal scope 的 admin config;registry 注入一個 resolver 每次現算(`resolveAllowlists`,`MCPServersRegistry.ts:233`),resolver 失敗時 fallback 到 YAML base(fail 到 operator baseline 而非關掉 allowlist)。

- **config-source server 的跨租戶快取污染**:兩個租戶可能定義同名但不同設定的 server,或同設定但不同 allowlist。所以 config cache key = `serverName:sha256(rawConfig + allowlists)`(`MCPServersRegistry.ts:877`),一個租戶的 `inspectionFailed` stub 不會滿足另一個租戶的查詢。

- **OBO 的執行期權限重查**:OBO server 每次 tool call 都重新 mint token,並用 `oboTrustChecker` 檢查**當初設定者**是否仍有 `CONFIGURE_OBO` 權限(`MCPManager.ts:447`)。若設定者被降權,即使 config 還在,也拒絕 mint。UI 端更新 OBO server 時對非權限者鎖定所有可能改 token 流向的欄位(`url/proxy/headers/oauth/apiKey/customUserVars`),只放行 `title/description/iconPath`(`controllers/mcp.js:296,307`)。這是 fail-closed 白名單:schema 新增欄位預設落入鎖定集。

- **negative cache 與 unavailable stub**:找不到工具定義時,`missingToolCache`(10s TTL,`MCP.js:52`)避免每次都重連;超過就回 unavailable stub。request-scoped server **不進 negative cache**(每次請求本來就會變)。

- **reconnect 節流**:非 request-scoped server 的重連有 10s throttle(`MCP.js:50,414`);request-scoped 故意不節流(每則訊息本來就該重連)。

- **connection staleness**:config `updatedAt` 變了就視連線為 stale 並重建(`ConnectionsRepository.ts:61`、`UserConnectionManager.ts:414`)。這讓 admin 改設定不必重啟就能生效。

- **idle 清理**:user 連線閒置超過 `USER_CONNECTION_IDLE_TIMEOUT`(15 分)整批斷線(`UserConnectionManager.ts:404,762`)。`userLastActivity` 即使連線沒建成也會清,避免 leak。

- **OAuth callback 的 tenant/cookie 問題**:callback 是外部 IdP 的 cross-origin redirect,SameSite=Strict cookie(含 JWT)不會帶上;所以 tenant context 從 flow metadata 還原(`routes/mcp.js:368`),身分驗證改用 CSRF cookie / session cookie / active PENDING flow 三選一(`routes/mcp.js:300-327`)。

- **paginated `tools/list` 的護欄**:server 可能分頁回工具,設有 max pages/tools/bytes/timeout(`mcpConfig.ts:26-34`),防惡意 server 拖垮 discovery。

- **image/UI resource 大小限制**:MCP 回傳的 base64 image 有 `MCP_IMAGE_DATA_MAX_BYTES`(預設 10MB)上限(`parsers.ts:6,41`),超過直接丟錯。

---

## 設計決策分析

**為什麼把核心放 TS package、`/api` 只做薄封裝?**
`packages/api/src/mcp/` 是純 TS、可被其他 backend 專案重用的邏輯;`/api` 的 JS 檔只負責接線(singleton、route、把 tool 包成 agents 的 `tool()`)。優點是型別安全、可測試、與 Express 解耦;缺點是 JS/TS 邊界要靠 `@librechat/api` re-export,跨層追程式碼較累。移植時你不需要這個分裂——直接全 TS。

**為什麼三層 registry(YAML / Config / DB)+ 三種 source?**
對應三種責任:operator(基礎設施信任)、admin(租戶管理者信任)、user(不可信、需沙箱)。合併優先序 DB < YAML,但 config override 可覆蓋(user 條目不被 config 覆蓋)。好處是同一套機制支援「開機固定 server」「admin 動態調」「使用者自助」;代價是合併/快取/失效邏輯相當複雜(`getServerConfig`、`getAllServerConfigs`、`ensureConfigServers` 三個入口 + 多層快取 + pending dedup)。**若重做,我會保留「信任等級」這個維度(它直接對應安全邊界),但簡化儲存層**:單一 Postgres 表 + source 欄位 + 一層 Redis cache,不要 in-memory Keyv + config-hash-key 這種為了無狀態多 replica 硬湊的設計。

**為什麼 connection scope 分那麼細(app / user / ephemeral)?**
純粹是**效能 vs. 正確性**的權衡:app 連線可跨使用者複用(省連線成本),但只要有任何 per-user 內容就必須隔離;含 per-request placeholder 的更得每次拋棄。這個分類是整個子系統最有價值的抽象,移植時值得照搬概念(不是程式)。LibreChat 官方也已規劃讓 user 連線走向全 ephemeral(`UserConnectionManager.ts:44` 註解)。

**為什麼 OAuth 用 flow state 而非 in-memory?**
因為要跨 HTTP 請求(initiate→callback)、跨 SSE tool call、跨 replica。用 Keyv(可 Redis-backed)存 flow state,配 state→flowId mapping、CSRF cookie、tenant 還原。這是分散式部署的必要複雜度。

**Discovery mode 為什麼重要?**
讓「未授權時也能列出工具」成為預設體驗:model 先看到工具 schema、UI 先顯示需授權,而非等使用者授權完才知道有什麼工具。這是 UX 決策,值得學。

**斷路器 / 節流 / staggered reconnect**:全是為了防「連線風暴」——大量使用者同時登入、或某 server 掛掉時的重試雪崩。分散式 agent 平台一定會遇到,移植時要預留。

---

## 移植到新技術棧的建議

> AI agent 框架尚未定案(LangGraph / LangChain / deepagents / Vercel AI SDK,見 19-framework-options.md);以下除「框架的 MCP client 支援」一節外,均與框架選型無關。

### 資料模型(PostgreSQL)

LibreChat 把 YAML server 放記憶體/Redis、user server 放 Mongo + ACL。在 pgsql 你可以統一成幾張表,用 `source` 區分信任等級:

```sql
CREATE TYPE mcp_source AS ENUM ('yaml', 'config', 'user');
CREATE TYPE mcp_transport AS ENUM ('stdio', 'sse', 'streamable_http', 'websocket');

CREATE TABLE mcp_servers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  name          text NOT NULL,                    -- 對應 serverName
  source        mcp_source NOT NULL,
  transport     mcp_transport NOT NULL,
  -- 連線與認證原始設定(含 command/args/env/url/headers/oauth/apiKey/obo)
  config        jsonb NOT NULL,
  -- inspect 產物(可為 null,失敗時 inspection_failed=true)
  requires_oauth      boolean,
  oauth_metadata      jsonb,
  server_instructions text,
  custom_user_vars    jsonb,                       -- {name:{title,description,sensitive}}
  inspection_failed   boolean NOT NULL DEFAULT false,
  author_id     uuid REFERENCES users(id),         -- user-source 專用,OBO 權限重查
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)                          -- 名稱在租戶內唯一
);

-- inspect 出來的工具定義(key = tool_mcp_server 在應用層組)
CREATE TABLE mcp_tools (
  server_id     uuid NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  tool_name     text NOT NULL,
  description   text,
  input_schema  jsonb NOT NULL,                     -- JSON Schema
  PRIMARY KEY (server_id, tool_name)
);

-- OAuth token(對應 MCPTokenStorage;identifier 拆成欄位)
CREATE TABLE mcp_oauth_tokens (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_name  text NOT NULL,
  kind         text NOT NULL,                       -- 'access' | 'refresh' | 'client'
  payload      jsonb NOT NULL,                       -- 加密後的 token / client info
  expires_at   timestamptz,
  PRIMARY KEY (user_id, server_name, kind)
);

-- user-source server 的 ACL(對應 LibreChat 的 resource permission)
CREATE TABLE mcp_server_acl (
  server_id  uuid NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  principal  jsonb NOT NULL,                         -- {type:'user'|'role', id}
  bits       int  NOT NULL,                          -- VIEW/EDIT/DELETE bitmask
  PRIMARY KEY (server_id, principal)
);
```

要點:
- `source='yaml'` 的可從設定檔在啟動時 upsert 進表(或不落 DB,只放 Redis,看你要不要 DB 當真相來源)。**我建議一律落 DB**,省掉 LibreChat 那套 config-hash cache key 的複雜度。
- `mcp_oauth_tokens.payload` 一定要加密(LibreChat 用 Token model 存;你至少 pgcrypto 或應用層 AES-GCM)。
- `mcp_tools` 讓工具 schema 可被 query,不必每次連線重抓;config `updated_at` 變更時重新 inspect 覆寫。

### Hono route / middleware 對應

LibreChat 的 `api/server/routes/mcp.js` 幾乎可 1:1 搬到 Hono:

| LibreChat | Hono 對應 |
|---|---|
| `requireJwtAuth` | `app.use('/mcp/*', jwtAuthMiddleware)` |
| `checkMCPUsePermissions` / `checkMCPCreate` | 自寫 `requirePermission(type, perms)` middleware,查角色權限 |
| `canAccessMCPServerResource({requiredPermission})` | per-resource ACL middleware,讀 `mcp_server_acl` |
| `GET /mcp/tools` | `mcp.get('/tools', ...)` 回傳使用者可見的工具清單 |
| `POST /:server/reinitialize` | `mcp.post('/:server/reinitialize', ...)` 觸發重連 + discovery |
| `GET /:server/oauth/initiate` / `callback` | OAuth 兩段式;callback 不吃 SameSite=Strict cookie,照 LibreChat 用 flow state 還原 tenant + CSRF/session/active-flow 三選一驗證 |
| `GET /connection/status[/:server]` | 連線狀態(disconnected/connecting/connected/error) |
| `POST/PATCH/DELETE /servers` | user-source server CRUD,含 OBO 欄位鎖定 |

Hono 的 `c.set()`/context 很適合放 request-scoped MCP connection store(對應 `MCPRequestContext` 的 WeakMap-per-req);在 response 結束時 disconnect ephemeral 連線。

### 框架的 MCP client 支援

四個候選框架都有 MCP client,但成熟度不同,完整版對照見 19-framework-options.md:

| | LangGraph | LangChain | deepagents | Vercel AI SDK |
|---|---|---|---|---|
| MCP client | `@langchain/mcp-adapters` 1.1.3 | 同左 | 同左 | `experimental_createMCPClient`(v7:tools/resources/prompts/elicitation,HTTP 建議生產、stdio experimental)+ v7 MCP Apps |

**若選 LangGraph 系(LangGraph / LangChain / deepagents,三者共用 `@langchain/mcp-adapters`)**:`loadMcpTools` / `MultiServerMCPClient` 把 MCP server 的 tools 轉成 LangChain `StructuredTool`,可直接餵進 `createAgent`、`createDeepAgent` 或自建的 StateGraph 節點。這條路線與 LibreChat 現有轉換邏輯(`toolFunctions` → `tool()`)概念高度重疊——LibreChat 的 `@librechat/agents` 底層本就是 LangGraph 封裝——`normalizeJsonSchema`、`sanitizeGeminiSchema` 這類 schema 轉換可直接參考現有實作,不必重新設計。

**若選 Vercel AI SDK**:

```ts
import { experimental_createMCPClient as createMCPClient } from 'ai';
import { Experimental_StdioMCPTransport as StdioTransport } from 'ai/mcp-stdio';

const client = await createMCPClient({
  transport: { type: 'sse', url, headers },   // 或 StdioTransport / StreamableHTTP
});
const mcpTools = await client.tools();          // 直接得到 AI SDK tool 定義,含 zod/JSONSchema
```

`client.tools()` 直接產出可餵給 `streamText({ tools })` 的工具,同樣省掉一層手動轉換,但這是 experimental API(stdio 尤其未到 stable),風險需自行評估;此路線沒有 LibreChat 既有程式碼可直接參考,轉換層要自建。Agent loop 用 `stopWhen: stepCountIs(N)`,對應 LangGraph 系的 `recursionLimit`。

**不論選哪個框架都不變的部分**:**多來源設定與信任等級、per-user/ephemeral 連線 scope、OAuth discovery+flow、OBO、SSRF allowlist、斷路器/節流**。這些是 LibreChat 真正的價值,與 agent 框架無關,整套移植即可;差異只在「MCP tool 定義轉成框架原生 tool」這一層薄封裝——LangGraph 系有 LibreChat 程式碼可抄,ai-sdk 則要照 SDK 的 API 自建。

- OAuth:兩條路線的 MCP client 都不管 OAuth 授權流程本身,你要自己在建立 transport/client 前備妥 token(從 `mcp_oauth_tokens` 拿、必要時 refresh),並保留 initiate/callback route。discovery mode(免認證列工具)可用一個「無 token 的短命 client 只呼叫 `tools()`」實現,兩條路線做法一致。

### Redis 的用途

- **OAuth flow state**(對應 Keyv-backed `FlowStateManager`):PENDING/COMPLETED/FAILED + state→flowId mapping + TTL。跨 replica 必須用 Redis。
- **registry / tools 快取**:server config 與 inspect 出的工具定義,設短 TTL,取代 LibreChat 的 in-memory Keyv + read-through cache。
- **cluster 協調**:對應 `MCPServersInitializer` 的 leader-follower。用 Redis lock(如 `SET NX PX`)讓單一 node 做 inspect,其他等 `initialized:<configHash>` flag。
- **斷路器 / 節流狀態**:reconnect throttle、circuit breaker 若要跨 replica 一致,也放 Redis(LibreChat 目前是 process-local static Map,單機才對)。
- **連線本身不能放 Redis**:MCP connection 是有狀態的 socket/子行程,只能綁在特定 node 的記憶體。多 replica 時要嘛 sticky session,要嘛全部走 ephemeral 連線(每次 tool call 現連現關)。

### Next.js 前端考量

- **工具管理 UI**:server 列表、CRUD、customUserVars 表單、連線狀態燈(輪詢 `/connection/status`)。用 React Query 對應 LibreChat 的 data-provider 模式。
- **OAuth 流程**:前端開新視窗到 `/oauth/initiate`,輪詢 `/oauth/status/:flowId` 或聽 SSE run-step event;完成後 refetch 工具與連線狀態。注意先呼叫 `/:server/oauth/bind` 設 CSRF cookie(對應 SSE 期間發起的 OAuth)。
- **UI resources**:MCP tool 回傳的 `ui://` resource 會被 `formatToolContent` 標成 `\ui{resourceId}` marker 並放進 `artifacts.ui_resources`(`parsers.ts:182,226`)。前端要能解析這些 marker、把對應 UIResource inline render(carousel/single)。這是 MCP 的 interactive UI 能力,若你要支援得在渲染層對應。
- **串流事件**:OAuth 打斷會透過 run-step delta event 把 auth URL 推給前端(`MCP.js` 的 `createRunStepDeltaEmitter`);Next.js 端要在對話串流中辨識這種 event 並彈出授權提示。

---

### 一句話總結

LibreChat 的 MCP 整合真正值錢的不是「呼叫工具」——不論最終選 LangGraph 系或 Vercel AI SDK,都有現成 MCP client 可用(`@langchain/mcp-adapters` 或 `experimental_createMCPClient`,對照見 19-framework-options.md)——而是**圍繞連線的一切治理**:三層信任等級的設定來源、app/user/ephemeral 三種連線 scope、per-request 的 SSRF allowlist、OAuth discovery+flow+reconnect、OBO 委派與執行期權限重查、以及分散式部署下的 leader-follower/斷路器/節流。這些治理邏輯與框架選型無關,移植時一律用 Postgres + Redis + Hono middleware 重寫並簡化;唯獨「MCP tool 定義轉成框架原生 tool」這薄薄一層,依你選的框架而異。
