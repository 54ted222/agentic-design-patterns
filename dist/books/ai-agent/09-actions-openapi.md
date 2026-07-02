# 09. Actions(OpenAPI 工具)

> 讀者背景:你要用 **PostgreSQL + Hono + Next.js + pnpm + Redis + docker-compose** 從零打造 AI agent 平台;AI agent 框架(LangGraph / LangChain / deepagents / Vercel AI SDK)尚未定案,完整選型對照見 19-framework-options.md。本文件拆解 LibreChat 如何讓使用者「貼一份 OpenAPI spec」就能讓 agent 呼叫任意第三方 REST API(官方稱為 *Actions*),重點是「它為什麼這樣設計」與「移植時該怎麼取捨」,而不是照抄它的寫法。
>
> 前置:agent 工具池的整體載入路徑與 MCP 工具並用同一套 `loadTools`/`loadAgentTools` 管線,MCP 那條路徑見 08-mcp-integration.md;本文件只守 Actions(OpenAPI)這一塊,兩者的差異與交會點會在文中點出。

---

## 定位

Actions 是 LibreChat 讓「非開發者使用者」自助擴充 agent 能力的機制:使用者在 UI 貼上一份 OpenAPI 3.0 spec(或直接填 URL),系統把 spec 的每個 operation 轉成一個 function-calling 工具,綁定到某個 agent(`agent.actions` / `agent.tools`)。跟 MCP 相比:

| | MCP | Actions |
|---|---|---|
| 工具來源 | 外部長駐 server,走 JSON-RPC | 使用者貼的 OpenAPI spec,單純 HTTP request/response |
| 連線型態 | 有狀態連線(stdio/SSE/HTTP/WS) | 無狀態,每次呼叫都是獨立 HTTP request |
| 誰能新增 | operator(yaml)/admin(config)/user(UI,存 DB) | 只有 user(UI,存 DB),綁定在單一 agent 上 |
| 信任模型 | 三層 source + 沙箱化 placeholder 解析 | 單一使用者自訂,靠 domain allowlist + spec-vs-domain 交叉驗證做 SSRF 防護 |
| 認證 | OAuth 2.0(RFC 9728)/API key/customUserVars/OBO | OAuth 2.0(spec 內定義)/`service_http`(API Key/Bearer/Basic/Custom header)/`none` |

Actions 子系統要解決的核心問題是:**如何把一份使用者上傳、不可信的 OpenAPI spec,安全地變成 model 可呼叫的工具**,同時滿足:

1. 工具名稱要塞進 provider 的 function-name 字元/長度限制(尤其 Azure OpenAI)。
2. 憑證(API key / OAuth client secret / OAuth token)要加密存放,且更新時不能無聲遺失。
3. HTTP 呼叫本身是使用者提供 URL 的出站請求,天生是 SSRF 攻擊面,要多層防護。
4. OAuth 授權要能在一次 agent 對話串流「途中」暫停、等使用者跳窗授權、再恢復。

程式碼分布:核心邏輯仍以 `/api`(legacy Express/JS)的 `ActionService.js` / `ToolService.js` 為主;較新、可測試的規則(action 更新的合併/衝突偵測邏輯、domain/SSRF 驗證、OAuth token 交換)已抽到 TypeScript 的 `packages/api/src/actions/`、`packages/api/src/auth/`、`packages/api/src/oauth/`;OpenAPI→function 的轉換與型別留在 `packages/data-provider/src/actions.ts`(前後端共用,因為前端 UI 也要驗證使用者貼的 spec)。

---

## 核心概念

| 名詞 | 心智模型 |
|---|---|
| **Action** | 一筆 Mongo 文件:`{ action_id, agent_id, metadata, version }`。`metadata` 含 `domain`、`raw_spec`(完整 OpenAPI spec 字串)、`auth`、以及依認證方式而定的敏感欄位(`api_key` 或 `oauth_client_id/secret`)。定義見 `packages/data-provider/src/types/agents.ts:578`。 |
| **ActionMetadata / ActionAuth** | Action 的可設定欄位與認證設定;`ActionMetadataRuntime` 是執行期額外掛上 `oauth_access_token`/`oauth_refresh_token`/`oauth_token_expires_at` 的擴充型別(`types/agents.ts:607`)。 |
| **domain 編碼** | 因為 provider(尤其 Azure OpenAI)的 function name 只允許 `^[a-zA-Z0-9_.-]+$` 且有長度上限,工具名不能直接塞完整 domain,所以 domain 會被「編碼」成固定 10 字元的短字串再拼進工具名。見下文「domain 編碼」小節。 |
| **actionDelimiter / actionDomainSeparator** | `actionDelimiter = '_action_'`、`actionDomainSeparator = '---'`(`packages/data-provider/src/types/assistants.ts:619-620`)。前者是「operationId」與「編碼後 domain」之間的分隔符,後者是短 domain 編碼時取代 `.` 用的分隔符。 |
| **openapiToFunction** | 把整份 OpenAPI spec 轉成 `{ functionSignatures, requestBuilders, zodSchemas }` 的純函式(`packages/data-provider/src/actions.ts:455`)。每個 operation → 一個 `FunctionSignature`(name/description/JSONSchema 參數)+ 一個 `ActionRequest`(記住 method/path/contentType/參數位置,知道怎麼發 HTTP request)。 |
| **ActionRequest / RequestExecutor** | `ActionRequest` 是「請求藍圖」(per-operation,一份 spec 解析一次即可重用);`RequestExecutor` 是「一次呼叫」的執行狀態(`setParams` 填參數並做 path 替換、`setAuth` 掛認證 header、`execute` 真正發 axios 請求)。拆成兩個 class 是為了讓同一個 operation 能並發處理多次工具呼叫而不互相污染狀態。 |
| **toolToAction map** | 執行期把「完整工具名稱」映射回「(action, requestBuilder, zodSchema, encrypted 憑證)」的 `Map`,在 `registerActionTools`(`api/server/services/ToolService.js:125`)裡建立,見下文。 |
| **normalizeActionToolName** | 把工具名裡「編碼後 domain」部分的 `---` 收斂成 `_`,只用於**查表比對**,不影響儲存或顯示(`ToolService.js:97`)。 |
| **createActionTool** | 把一個 `(action, requestBuilder)` pair 變成真正可執行的工具:內含完整的認證分支(none/service_http/oauth)、SSRF-safe HTTP agent、OAuth 授權暫停/恢復邏輯(`api/server/services/ActionService.js:182`)。 |
| **actionFlowManager** | 專供 Action OAuth 用的 `FlowStateManager` 實例,TTL 3 分鐘(比 MCP OAuth 的 flow 短很多),與 MCP 共用同一個 Keyv 儲存但是不同 manager 物件(`api/config/index.js:39`)。 |
| **agent.tools / agent.actions** | Agent 文件上兩個平行的 `string[]` 欄位。`tools` 是 model 實際會看到的工具名清單(含 action 工具、MCP 工具、內建工具);`actions` 只記錄「這個 agent 綁定了哪些 action_id」,供 CRUD 時反查/刪除用。兩者的字串格式**不對稱**,見下文陷阱。 |

---

## 架構與流程

### 元件關係

```
┌───────────────────────────── 設定期(CRUD,使用者在 UI 編輯 Agent) ─────────────────────────────┐
│  POST /api/agents/actions/:agent_id                                                           │
│    encryptMetadata → validateAndParseOpenAPISpec → validateActionDomain(防 SSRF)               │
│    → isActionDomainAllowed(admin allowlist) → planAgentActionUpdate(合併/憑證續用判斷)          │
│    → db.updateAgent({tools, actions}) + db.updateAction(metadata)                              │
│  DELETE /api/agents/actions/:agent_id/:action_id → 從 agent.tools/actions 移除 + 刪 Action 文件  │
└──────────────────────────────────────────────┬──────────────────────────────────────────────────┘
                                                 │ 存進 Mongo: Action collection + Agent.tools/actions
                                                 ▼
┌───────────────────────────── 執行期(對話中,agent 要用工具) ───────────────────────────────────┐
│ 第一階段(definitionsOnly,給 model 選工具用,不建立可執行實例):                                  │
│   loadToolDefinitionsWrapper → getActionToolDefinitions(agentId, toolNames)                    │
│     → loadActionSets(agent_id) → 逐 action: domain allowlist → validateAndParseOpenAPISpec      │
│       → validateActionDomain(spec.servers[0].url 是否等於 stored domain,防「事後偷換 spec」)     │
│       → openapiToFunction(spec) → 只取 name/description/parameters 回傳給 model 當工具 schema   │
│                                                                                                  │
│ 第二階段(model 真的呼叫某個 action 工具時才觸發,definitionsOnly=false):                          │
│   loadToolsForExecution → loadActionToolsForExecution                                          │
│     → loadActionSets → openapiToFunction(spec, generateZodSchemas=true)                        │
│     → registerActionTools(toolToAction, functionSignatures, normalizedDomain, legacyNormalized) │
│     → toolToAction.get(normalizeActionToolName(toolName)) → createActionTool(...)               │
│     → 回傳一個 `tool()` 實例給 agent runtime,_call 內做認證 + SSRF-safe axios 請求               │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

兩階段拆分(definitions-only vs. 真正建立工具實例)是為了配合 `@librechat/agents` 的**事件驅動延遲載入**架構:一次對話裡 agent 工具池可能有幾十個 action/MCP 工具,若每一輪都把所有 spec 重新 parse 一遍、把每個工具都 wrap 成帶完整認證邏輯的 closure,成本很高;所以先只給 model「看得到工具長什麼樣子」的輕量 schema,等 model 真的選中某個工具、發出 tool call 時,才在 `loadActionToolsForExecution`(`ToolService.js:1665`)裡把該 action 完整具現化。

### 流程 A:建立/更新 Action(`POST /api/agents/actions/:agent_id`)

出處:`api/server/routes/agents/actions.js:85`。

1. 中介層先做資源存取控制:`canAccessAgentResource({ requiredPermission: PermissionBits.EDIT })` + `checkAgentCreate`(`CREATE`+`USE` 權限)。
2. `encryptMetadata(removeNullishValues(metadata, true))`(`ActionService.js:430`)——依 `auth.type` 只加密該類型會用到的欄位:`service_http` → `api_key`;`oauth` → `oauth_client_id`/`oauth_client_secret`。加密用 `encryptV2`(AES-CBC,每次隨機 IV,`packages/data-schemas/src/crypto/index.ts:74`),值先 `encodeURIComponent` 再加密以保留特殊字元(`:` 等)。
3. **SSRF 防護第一層**:`validateAndParseOpenAPISpec(metadata.raw_spec)` 解析 spec、取出 `servers[0].url`;再用 `validateActionDomain(metadata.domain, serverUrl)`(`packages/data-provider/src/actions.ts:645`)比對「使用者填的 domain 欄位」跟「spec 裡實際的 server URL」是否同一個 host——防止使用者把 `domain` 填成一個已在 allowlist 內的網域,但 `raw_spec` 裡的 `servers[0].url` 卻指向內網位址。
4. **SSRF 防護第二層**:`isActionDomainAllowed(metadata.domain, appConfig.actions.allowedDomains, allowedAddresses)`(`packages/api/src/auth/domain.ts:372`)。若 admin 沒設 `allowedDomains`,退回「阻擋私網位址」的預設防護(`isSSRFTarget` + DNS resolve 檢查真實 IP);若有設,則做 hostname/protocol/port 的白名單比對(支援 `*.example.com` 萬用字元)。
5. `domainParser(metadata.domain, true)` 把 domain 編碼成工具名可用的短字串(見下文)。
6. `planAgentActionUpdate`(`packages/api/src/actions/update.ts:112`)是這條路徑最核心的純函式,做三件事:
   - `mergeActionMetadataForUpdate`(`packages/api/src/actions/credentials.ts:177`):比較 stored 與 incoming metadata,判斷「認證邊界」(domain / spec server URL / auth 端點)是否改變。若改變但使用者沒有重新填憑證,標記 `requiresCredentialRefresh = true`,路由直接回 400 拒絕(不能讓舊 API key 沿用到一個新目標上)。
   - `mergeAgentActionTools`(`packages/api/src/actions/tools.ts:81`):把 `agent.tools` 陣列裡屬於這個 action 的舊條目(依 encodedDomain **和** legacy 編碼、以及舊 raw_spec 反推出的 operationId 集合)整批換成新的。
   - 回傳 `deleteOAuthTokens`:當認證邊界改變且是「更新既有 action」(非新建),要求呼叫端刪除舊的 OAuth token(`buildActionOAuthTokenDeleteQueries`,用正規表達式匹配 `identifier` 欄位),同時**保留 OAuth callback URL 不變**(因為 callback URL 綁的是 `action_id`,不是 domain)。
7. `validateActionOAuthMetadata`(`packages/api/src/oauth/validation.ts:61`)驗證 `authorization_url`/`client_url` 必須是 HTTPS,且不能指向私網位址(SSRF 第三層,這次是驗證 OAuth 端點而非 API 本身)。
8. `db.updateAgent(..., { forceVersion: true })` 強制觸發 agent 版本號更新(action 內容變了,agent 的可重現性快照也要跟著變),`db.updateAction(...)` upsert Action 文件。
9. 回應前把 `api_key`/`oauth_client_id`/`oauth_client_secret` 從回傳的 `metadata` 裡刪掉——**永遠不把加密後的憑證回吐給前端**,前端表單只知道「已設定」,不知道值。

刪除路由(`DELETE /:agent_id/:action_id`,`agents/actions.js:255`)反過來:先在 `agent.actions` 裡用 `action_id` 找出對應的 `encodedDomain`,再用這個 domain 去過濾 `agent.tools`(見下文「陷阱」裡兩個陣列格式不對稱的說明),最後刪 Action 文件。

> 對照:`api/server/routes/assistants/actions.js` 是給舊版 OpenAI Assistants API(`assistant_id` 而非 `agent_id`)用的簡化版本,**沒有** `planAgentActionUpdate` 的合併/憑證續用判斷,也沒有第 3 步的 spec-vs-domain 交叉驗證。它是遺留相容路徑,新功能不會加在這裡。

### 流程 B:對話時載入 action 工具(執行階段)

出處:`api/server/services/ToolService.js:1665`(`loadActionToolsForExecution`),被 `loadToolsForExecution`(`ToolService.js:1439`)在偵測到 `isActionTool(name)` 的工具名時呼叫。

1. `loadActionSets({ agent_id })`(`ActionService.js:161`,實際就是 `getActions({ agent_id }, true)` 帶 `includeSensitive=true`,因為執行期需要用到加密的憑證)拿出該 agent 綁定的所有 Action 文件。
2. 對每個 action:重算 `normalizedDomain`(新編碼)與 `legacyNormalized`(舊編碼,相容用),過 `isActionDomainAllowed` 再檢查一次(admin 可能在 action 建立後才緊縮 allowlist),`validateAndParseOpenAPISpec` + `validateActionDomain` 再驗一次 spec 完整性與 domain 一致性(**這是 defense-in-depth**:即使建立時驗過,執行時 spec 內容理論上不會變,但仍不信任 DB 內容,重新驗證一次)。
3. `decryptMetadata(action.metadata)` 把 `api_key`/`oauth_client_id`/`oauth_client_secret` 解回明文(存在記憶體中,隨這次 request 的生命週期)。
4. `openapiToFunction(spec, generateZodSchemas=true)` 產生 `functionSignatures`(給 model 的工具 schema)、`requestBuilders`(HTTP 請求藍圖)、`zodSchemas`(執行期輸入驗證,`@librechat/agents` 的 `tool()` 用它做 runtime 型別檢查)。
5. `registerActionTools`(下文詳述)把每個 operation 註冊進 `toolToAction` map,同時掛新舊兩種 domain 編碼的 key。
6. 對 `agent.tools` 裡每個要求的工具名,`toolToAction.get(normalizeActionToolName(toolName))` 查出對應 entry,呼叫 `createActionTool(...)` 生出真正的 `tool()` 實例。

### 流程 C:`createActionTool._call` 執行一次工具呼叫

出處:`ActionService.js:182-401`。

```
_call(toolInput, config)
  ├─ executor = requestBuilder.createExecutor().setParams(toolInput)   // path 參數替換
  ├─ if auth.type !== 'none':
  │    ├─ 'oauth' 且有 authorization_url → 走 OAuth 分支(見流程 D)
  │    │    ├─ validateActionOAuthMetadata(SSRF 檢查 authorization_url/client_url)
  │    │    ├─ 查 Token model:有 access token → 直接用
  │    │    │                  無 access token 但有 refresh token → refreshAccessToken()
  │    │    │                  都沒有 → requestLogin()(掛起等使用者授權)
  │    │    └─ 把拿到的 token 寫回 metadata.oauth_access_token/...
  │    └─ preparedExecutor.setAuth(metadata)                            // 組 Authorization header
  ├─ response = preparedExecutor.execute(ssrfAgents)                    // 真正發 HTTP 請求
  └─ 回傳 JSON.stringify(response.data) 或原始 response.data
```

`setAuth`(`packages/data-provider/src/actions.ts:208`)依 `authorization_type` 決定 header 組法:`Basic`(base64 `api_key`)、`Bearer`、`Custom`(自訂 header 名稱)。OAuth 分支則要求 `oauth_access_token` 存在且未過期,否則丟 `No access token found` / `Access token is expired` 讓上層決定要不要觸發登入。

`execute`(`actions.ts:286`)用一個**每次呼叫都新建**的 axios instance,關鍵防護:`maxRedirects: 0`(防止外部 domain 用 3xx 導到內網服務繞過 domain allowlist,即「SSRF via redirect」)+ 可選的 `httpAgent`/`httpsAgent`(`createSSRFSafeAgents`,在 TCP connect 時重新 DNS resolve 並檢查真實 IP,防 DNS rebinding TOCTOU)。`useSSRFProtection` 只在 **admin 沒設 `allowedDomains` 時**才啟用(`!Array.isArray(_allowedDomains) || _allowedDomains.length === 0`,`ToolService.js:447,1383,1768`)——邏輯是:設了明確 allowlist 就已經是白名單模式,額外的連線期 SSRF agent 主要防「allowlist 沒設時的預設防護」,兩者是互補而非疊加的關係。

### 流程 D:Action 專用 OAuth 授權(掛起-恢復模式)

```
Model 呼叫某個需要 OAuth 的 action 工具,且使用者尚未授權
  │
  ▼
createActionTool._call → requestLogin()
  │  組 authURL(authorization_url + client_id + scope + redirect_uri + state=JWT(nonce,user,action_id))
  │  flowManager.createFlowWithHandler(..., 'oauth_login', handler)
  │     └─ handler: 透過 SSE 把 ON_RUN_STEP_DELTA 事件(tool_call.auth = authURL)推給前端,
  │                 UI 在該 tool call 卡片上顯示「Authorize」按鈕(見 ToolCall.tsx)
  │  flowManager.createFlow(identifier, 'oauth', {state, client_url, encrypted_client_id/secret,...})
  │     └─ await,最長等到 actionFlowManager 的 TTL(3 分鐘)或使用者完成
  ▼
使用者點「Authorize」
  │  前端先 POST /api/actions/:action_id/oauth/bind(setOAuthCsrfCookie,綁定 flowId=`${userId}:${actionId}`)
  │  window.open(authURL)  ← 新分頁開向外部 IdP
  ▼
外部 IdP 授權完成 → 導回 GET /api/actions/:action_id/oauth/callback?code&state
  │  jwt.verify(state) → 取回 action_id / user,比對 action_id 是否一致
  │  validateOAuthCsrf(cookie) OR validateOAuthSession(session cookie) 二選一通過即可
  │    (跨站導回時 SameSite=Strict 的一般認證 cookie 不會帶上,靠 SameSite=Lax 的 CSRF/session cookie)
  │  flowManager.getFlowState(identifier, 'oauth') 確認 flow 仍存在(防重放/過期)
  │  getAccessToken(code, client_url, redirect_uri, encrypted_client_id/secret) → 換 token
  │     (getAccessToken 內部也用 SSRF-safe agent 打 client_url,並先 validateActionOAuthEndpoint)
  │  processAccessTokens → Token model 存 access/refresh token(encryptV2 加密)
  │  flowManager.completeFlow(identifier, 'oauth', tokenData)  ← 喚醒還在等待的 _call
  │  redirect 到 /oauth/success
  ▼
_call 恢復執行:拿到 access_token → setAuth → 真正發出原本被卡住的 API 呼叫
```

出處:`api/server/routes/actions.js:30`(bind)、`:55`(callback);OAuth CSRF/session cookie 工具函式與 MCP OAuth 共用同一套實作(`packages/api/src/oauth/csrf.ts`),但 Action 用的 cookie path 限定在 `/api/actions`(`OAUTH_CSRF_COOKIE_PATH`),與 MCP 的 `/api/mcp` 互不干擾。

值得注意:action OAuth 用的是**獨立的** `actionFlowManager`(`api/config/index.js:39`),TTL 只有 3 分鐘,遠短於 MCP OAuth flow;理由寫在原始碼註解裡:「an unclicked action login does not leave the tool call waiting for the MCP OAuth window」——action tool call 通常發生在使用者仍盯著這一輪對話的當下,沒必要讓整個 agent run 為了一個沒人理的登入請求卡好幾分鐘。

---

## 關鍵資料結構

### `Action`(Mongo,`packages/data-schemas/src/schema/action.ts:19`)

| 欄位 | 型別 | 用途 |
|---|---|---|
| `action_id` | string(nanoid) | 主鍵,拼進工具名/callback URL |
| `agent_id` / `assistant_id` | string | 恰好其一;新系統一律 `agent_id` |
| `metadata.domain` | string,必填 | 原始(未編碼)domain,可含或不含協定 |
| `metadata.raw_spec` | string | 完整 OpenAPI spec(JSON 或 YAML 字串),**未加密**明文存 DB |
| `metadata.auth` | 子文件 | `{ type, authorization_type, custom_auth_header, authorization_url, client_url, scope, token_exchange_method }` |
| `metadata.api_key` | string | `service_http` 用,`encryptV2` 加密後存 |
| `metadata.oauth_client_id` / `oauth_client_secret` | string | `oauth` 用,`encryptV2` 加密後存 |
| `tenantId` | string,索引 | 多租戶隔離欄位 |
| `version` | number\|string | 版本號(未見複雜版本追蹤邏輯,主要供未來擴充) |

`getActions(searchParams, includeSensitive)`(`packages/data-schemas/src/methods/action.ts:34`)預設 `includeSensitive=false`,會**在回傳前刪掉三個敏感欄位**——這是 API 讀取路徑(GET /actions)的預設安全行為;只有執行期工具載入會明確傳 `true`。

### `agent.tools` / `agent.actions` 條目格式(⚠️ 兩者順序相反)

| 陣列 | 條目格式 | 範例 | 用途 |
|---|---|---|---|
| `agent.tools[]` | `${operationId}${actionDelimiter}${encodedDomain}` | `getWeather_action_api---example---com` | model 實際看到、呼叫的工具名 |
| `agent.actions[]` | `${encodedDomain}${actionDelimiter}${action_id}` | `api---example---com_action_V1StGXR8_Z5j` | 反查「這個 agent 綁了哪些 action_id」,domain 只是輔助過濾 |

同一個 `actionDelimiter`,但 domain 在 `tools` 裡是**後綴**、在 `actions` 裡是**前綴**。刪除 action 時(`agents/actions.js:274-289`)靠這個不對稱 split 出 `storedDomain` 再去過濾 `tools`;移植時若沒注意這點,很容易寫出「刪除 action 卻沒清乾淨 agent.tools 殘留條目」的 bug。

### `toolToAction` map entry(執行期,存在記憶體,per-request)

| 欄位 | 說明 |
|---|---|
| `action` | 已 `decryptMetadata` 的完整 Action 物件(含明文憑證) |
| `requestBuilder` | 該 operation 的 `ActionRequest` |
| `zodSchema` | 該 operation 的輸入 zod schema(執行階段才會有;definitions-only 階段不需要) |
| `functionSignature` | `{name, description, parameters}`,用來給 `createActionTool` 當工具的 name/description |
| `encrypted` | `{oauth_client_id, oauth_client_secret}` 的**加密原文**,OAuth 換 token 時要重新解密使用(不能重用已解密的 `action.metadata`,因為那份在 refresh 過程中會被就地改寫成新 token) |

### OAuth Token(`Token` model,`packages/data-schemas`)

| 欄位 | 說明 |
|---|---|
| `userId` | 授權使用者 |
| `identifier` | `${userId}:${action_id}`(access)、`${identifier}:refresh`(refresh) |
| `type` | `'oauth'` \| `'oauth_refresh'` |
| `token` | `encryptV2` 加密後的 token 字串 |
| `expiresIn` / `expiresAt` | 存活秒數/到期時間,到期後靠 refresh token 續期 |

---

## 關鍵實作細節與陷阱

- **domain 編碼是兩條路徑,長度門檻是硬編碼 10**(`Constants.ENCODED_DOMAIN_LENGTH`,`packages/data-provider/src/config.ts:2635`,註解明講是「for Azure OpenAI Assistants Function name parsing」)。hostname ≤10 字元 → 直接把 `.` 換成 `---`(可逆,不需要額外狀態);>10 字元 → base64 編碼後**截斷成 10 字元**(不可逆,必須靠 `CacheKeys.ENCODED_DOMAINS` 這張 Mongo-backed Keyv 表存「10 字元 key → 完整 base64」才能反查)。這代表**長 domain 的 action 依賴一份額外的、獨立於 Action 文件之外的持久化狀態**——備份/搬遷資料庫時若漏了這個 cache collection,理論上會影響 decode,但目前生產路徑(`ToolService.js` 四處呼叫)全部都是 `domainParser(domain, true)` 的 encode 方向,decode 方向(`inverse=false`)在目前的 `/api` 路由裡沒有任何呼叫點,只在測試中被驗證——這是個「寫了完整雙向邏輯,但只用單向」的訊號,移植時可以直接簡化掉。

- **domain 編碼曾經有過 collision bug,修法是「雙重註冊」而非資料遷移**:舊版 `legacyDomainEncode`/`legacyActionDomainEncode` 是對**含協定的完整字串**做 base64(所有 `https://` 開頭的 domain,base64 前綴高度相似,10 字元截斷後極易碰撞);新版 `domainParser` 改成**先 `stripProtocol` 再編碼**修掉碰撞。但既有 agent 的 `tools`/`actions` 陣列裡已經存了舊編碼字串,LibreChat 選擇不做 DB migration,而是在 `registerActionTools`(`ToolService.js:125`)裡**對每個 operation 同時註冊新舊兩種編碼的 key**(`normalizedDomain` 與 `legacyNormalized`),讓查表對舊資料和新資料都命中。好處是零停機、零遷移風險;代價是這段邏輯要在四個呼叫點(`processRequiredActions`、`loadToolDefinitionsWrapper`、`loadAgentTools`、`loadActionToolsForExecution`)重複做同樣的雙重計算,永久留在程式碼裡。

- **`normalizeActionToolName` 只收斂 domain 後綴,絕不能動 operationId 部分**(`ToolService.js:97`)。`openapiToFunction` 允許 operationId 保留連字號(`sanitizeOperationId` 只濾掉不合法字元,不強制轉底線),所以 `get_foo---bar` 與 `get_foo_bar` 可能是**兩個不同的合法 operationId**。如果查表 normalize 時連 operationId 一起把 `---` 換成 `_`,兩個不同的 operation 會被誤判成同一把 key、彼此覆蓋——這正是 `registerActionTools` 內 `setKey` 對 collision 特意加 warning log 的原因(`ToolService.js:132-141`):它防的不是「正常情況」,是「防禦回歸」。

- **三層 SSRF 防護,任一層被繞過另兩層仍擋得住**:① 建立/更新時 `validateActionDomain` 比對 `metadata.domain` 與 spec 內 `servers[0].url`(防止「domain 填白名單網域,spec 裡的 server URL 填別的」);② `isActionDomainAllowed` 查 admin allowlist(或退回私網 IP 阻擋);③ 執行時 `RequestExecutor.execute` 用 `maxRedirects:0` + SSRF-safe agent(DNS resolve 後在 connect 層再驗一次,防 TOCTOU/DNS rebinding)。三層分別防「使用者惡意填值」「admin 事後緊縮設定」「DNS/redirect 層面的攻擊」,單一層都不足以應付全部場景。

- **`isConsequential`(`x-openai-isConsequential`)被完整解析、儲存,但目前沒有任何地方讀取它來做「執行前需要人工確認」的邏輯**(`packages/data-provider/src/actions.ts:164,394,562`)。這是繼承自 OpenAI ChatGPT Plugin manifest 的欄位,語意上該欄位為 `true` 的 operation(例如刪除、下單)理論上該要求二次確認,但 LibreChat 現在直接執行。移植時如果要做「危險操作需確認」功能,這裡有現成的 spec 解析,但執行邏輯要自己補。

- **前端顯示 domain 的反解是「半殘」的**:`ToolCall.tsx` 從工具名切出 domain 後只做 `replaceAll(actionDomainSeparator, '.')`(純字串替換),完全沒有處理 base64-truncate 這條路徑。結果是:長 hostname 的 action 在 UI 的 tool call 卡片上會顯示一串看起來像亂碼的 10 字元 base64 片段,而不是真正的 domain。這不是 bug(不影響功能),但移植時若要做同等 UI,要嘛把真正的 domain 存在 tool call 的 metadata 裡直接帶著走,不要指望從工具名反解。

- **憑證的「認證邊界改變」判斷是白名單欄位比對,不是整份 metadata diff**:`didAuthBoundaryChange`(`packages/api/src/actions/credentials.ts:99`)只比對 `type/authorization_type/custom_auth_header/authorization_url/client_url/scope/token_exchange_method` 這固定七個欄位。新增 `ActionAuth` 欄位時,若忘記把它加進 `authBoundaryFields`,該欄位改變將不會觸發「要求重新輸入憑證」——這是個容易在加欄位時漏掉的隱性契約,而非 fail-closed 設計(跟 08 文件提到的 OBO 欄位鎖定白名單方向相反,這裡是漏了不會報錯,只會靜默允許憑證延用)。

- **`agent.tools` 允許放進「查無實體」的 action 工具名而不報錯**:`filterAuthorizedTools`(`api/server/controllers/agents/v1.js:226-234`)在更新 agent 的工具清單時,只要字串符合 `isActionTool()` 格式就直接放行,不驗證是否真的有對應的 Action 文件。真正的存在性檢查延後到執行期 `toolToAction.get(...)` 查不到就 `continue` 跳過(`ToolService.js:1365-1368` 等處),表現為「model 想呼叫但工具悄悄消失」而非明確錯誤。這是刻意的寬鬆(避免因為一個壞掉的 action 卡死整個 agent 更新),但除錯時容易誤以為工具設定成功了。

- **Action OAuth 與 MCP OAuth 共用 CSRF/session cookie 基礎設施,但 flow store 與 TTL 各自獨立**:兩者都用 `packages/api/src/oauth/csrf.ts` 的 `OAUTH_CSRF_COOKIE`/`OAUTH_SESSION_COOKIE`,差異只在 cookie `path`(`/api/actions` vs `/api/mcp`)避免互相污染;但 `FlowStateManager` 是兩個獨立 new 出來的 singleton(`getFlowStateManager` vs `getActionFlowStateManager`,`api/config/index.js:24,39`),TTL 分別是 MCP 的較長設定與 Action 固定 3 分鐘——共用同一個底層 Keyv cache(`CacheKeys.FLOWS`),靠 `identifier` 字串(action 用 `userId:action_id`,MCP 用 `userId:serverName` 或含 tenant)天然不會撞 key。

---

## 設計決策分析

**為什麼要把 domain 編碼進工具名,而不是單純用 `action_id` 當工具名前綴?**
因為 tool name 需要對 model **可讀**(model 靠工具名判斷該不該呼叫、以及呼叫哪個 API),`action_id`(nanoid)對 model 毫無語意;而 `operationId`(如 `getWeather`)加上 domain 才能讓 model 明白「這是 example.com 的 getWeather」。真正的複雜度來源是 provider 對函式名稱的字元/長度限制(尤其 Azure OpenAI),逼得 LibreChat 得把 domain「壓縮」成定長編碼並維護一份反查表。**若重做**:多數新一代 provider(Anthropic、近期 OpenAI Responses API)對 function name 的長度限制寬鬆很多,且你完全掌控 tool-name → handler 的映射層(不像 LibreChat 還要相容 Azure 的舊限制),可以直接用 `${operationId}::${action_id}` 這種「本來就唯一、不需要編碼還原」的組合鍵,把整個 domain 編碼/雙重註冊/legacy 相容的複雜度全部砍掉。

**為什麼三處(建立時、載入定義時、真正執行時)都要重新驗證 domain/spec?**
這是「不信任已落地資料」的 defense-in-depth 思路:admin 的 allowlist 可能在 action 建立後才變嚴;DB 裡的 `raw_spec` 理論上不該變但畢竟是明文字串,直接信任等於信任整個資料庫沒被竄改過。多驗幾次的成本是「每次載入工具都要重新 parse 一次 OpenAPI spec」(沒有做 parse 結果快取),在工具數量多的 agent 上是可觀的 CPU 成本。**若重做**:把「驗證通過的 parse 結果」快取(對應 08 文件 MCP 那邊做的 `toolFunctions` 快取),用 `raw_spec` 的 hash 當快取失效判斷依據,而不是每次重新驗證+重新 parse。

**為什麼 OAuth 授權要走「SSE 事件掛起 tool call,等前端跳窗完成後恢復」而不是「先跳窗授權完再讓 model 呼叫工具」?**
這是跟 MCP 完全一致的模式(見 08-mcp-integration.md 的 Discovery mode/OAuth 討論):讓 model 不需要「知道」授權狀態,直接呼叫工具,授權缺失變成執行期才發現、且能在**同一個 tool call 生命週期內**恢復,不需要 model 重新規劃、重新發 tool call。這是比較符合 agentic loop 直覺的使用者體驗,值得照搬概念。

**為什麼要在 `agent.tools` 用工具名字串陣列,而不是存一份結構化的 `{type, action_id, operation}[]`?**
歷史包袱:`agent.tools` 是跟內建工具(`web_search`、`execute_code`…)共用同一個「字串陣列」欄位,MCP 工具、action 工具、內建工具全部塞在同一個 `string[]` 裡,靠字串格式(是否含 `_mcp_`、是否含 `_action_`)分類。優點是 schema 簡單、UI 端一個 multi-select 就能編輯所有工具;代價正是本文件一路在講的字串編碼/解碼複雜度。**若重做**:拆成結構化欄位(如 `{ builtIn: string[], mcp: {server,tool}[], actions: string[] /* 直接存 action_id,不編碼 domain */ }`),犧牲一點 schema 簡潔換掉幾乎所有 domain 編碼相關的坑。

---

## 移植到新技術棧的建議

> AI agent 框架尚未定案(LangGraph / LangChain / deepagents / Vercel AI SDK,見 19-framework-options.md);以下除「框架對應」一節外,均與框架選型無關。

### 資料模型(PostgreSQL)

因為你不需要相容 Azure OpenAI 舊有的工具名長度限制,`action_id` 可以直接當工具名的一部分,完全不需要 domain 編碼/反查表這一整套機制。

```sql
CREATE TYPE action_auth_type AS ENUM ('none', 'service_http', 'oauth');
CREATE TYPE action_authz_type AS ENUM ('bearer', 'basic', 'custom');
CREATE TYPE token_exchange_method AS ENUM ('default_post', 'basic_auth_header');

CREATE TABLE actions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  agent_id          uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  domain            text NOT NULL,                 -- 未編碼,原樣存
  raw_spec          text NOT NULL,                 -- OpenAPI spec 原文(JSON/YAML)
  spec_server_url   text NOT NULL,                  -- 建立時解析出的 servers[0].url,供後續 diff 用
  auth_type         action_auth_type NOT NULL DEFAULT 'none',
  authorization_type action_authz_type,
  custom_auth_header text,
  authorization_url text,
  client_url        text,
  scope             text,
  token_exchange_method token_exchange_method,
  -- 加密後的憑證,建議用應用層 AES-GCM(帶認證,比 LibreChat 的 AES-CBC 更抗竄改)
  api_key_encrypted            text,
  oauth_client_id_encrypted    text,
  oauth_client_secret_encrypted text,
  version           int NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- 解析 spec 後的 operation 快取,避免每次載入工具都重新 parse OpenAPI
CREATE TABLE action_operations (
  action_id     uuid NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
  operation_id  text NOT NULL,           -- 直接用 spec 的 operationId,不做 domain 編碼
  method        text NOT NULL,
  path          text NOT NULL,
  description   text,
  input_schema  jsonb NOT NULL,          -- JSON Schema,可直接轉 zod(LangGraph 系 tool())或 ai-sdk 的 inputSchema
  param_locations jsonb NOT NULL,        -- {paramName: 'query'|'path'|'header'|'body'}
  spec_hash     text NOT NULL,           -- raw_spec 的 sha256,判斷是否需要重新 parse
  PRIMARY KEY (action_id, operation_id)
);

-- Agent 綁定關係(取代 LibreChat 的 agent.tools/agent.actions 字串陣列)
CREATE TABLE agent_actions (
  agent_id   uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  action_id  uuid NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, action_id)
);

-- OAuth token(对应 LibreChat 的 Token model,identifier 拆成结构化欄位)
CREATE TABLE action_oauth_tokens (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action_id   uuid NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
  kind        text NOT NULL,             -- 'access' | 'refresh'
  token_encrypted text NOT NULL,
  expires_at  timestamptz,
  PRIMARY KEY (user_id, action_id, kind)
);
```

工具名建議格式:`${operationId}::${action_id}`(`action_id` 用 UUID 或 nanoid,天生 URL/JSON-safe,不需要編碼還原);查表直接用 `action_id` 做 `agent_actions` JOIN `actions`,完全省掉 `domainParser`/`normalizeActionToolName`/legacy 雙重註冊那一整套。

### Hono route / middleware 對應

| LibreChat | Hono 對應 |
|---|---|
| `POST /api/agents/actions/:agent_id`(`agents/actions.js:85`) | `actions.post('/:agentId', requireAuth, requireAgentEdit, validateSpec, planUpdate, ...)` |
| `DELETE /api/agents/actions/:agent_id/:action_id` | `actions.delete('/:agentId/:actionId', requireAgentEdit, ...)` |
| `GET /api/agents/actions/`(列出使用者可編輯的所有 actions) | `actions.get('/', requireAuth, ...)` |
| `POST /api/actions/:action_id/oauth/bind` | `actionsOAuth.post('/:actionId/oauth/bind', requireAuth, setSessionCookie, setCsrfCookie)` |
| `GET /api/actions/:action_id/oauth/callback`(**不掛全域 auth middleware**,IdP 導回時沒有一般登入 cookie) | `actionsOAuth.get('/:actionId/oauth/callback', ...)`,身分靠 state JWT + CSRF/session cookie 還原 |

`validateSpec`/`planUpdate` 這兩個 middleware 直接對應 `validateAndParseOpenAPISpec` + `validateActionDomain` + `planAgentActionUpdate` 三個純函式的邏輯,移植時原樣搬邏輯即可(這三個函式本身就是無副作用的 TS 函式,搬移成本很低)。

### 框架對應:OpenAPI action 工具怎麼接

四個候選框架都沒有內建「OpenAPI spec → tool 定義」的轉換層,取代 `openapiToFunction` 的做法與框架選型無關:離線用 openapi-zod-client / openapi-typescript 之類的套件把 spec 轉成 zod schema + operation 清單,存進上面的 `action_operations` 表,執行期不用重新 parse OpenAPI,直接從表裡讀 `input_schema` 建 schema。差異在「怎麼把這份 schema 包成框架原生的 tool」以及「OAuth 掛起-恢復怎麼接」,兩者選哪個框架落差不小,完整能力對照見 19-framework-options.md。

**若選 LangGraph 系(LangGraph / LangChain / deepagents)**:用 `@langchain/core/tools` 的 `tool()` 包 `zodSchema` + `func`,行為與 LibreChat 現有的 `createActionTool` 幾乎一一對應——畢竟 `@librechat/agents` 底層本就是 LangGraph 封裝——`registerActionTools`/`toolToAction` map 這套「把 operation 註冊進工具池」的邏輯可以高度直接參考,只是把 domain 編碼查表換成上面 DDL 的 `action_id` 直查即可,不需要另外設計。

**若選 Vercel AI SDK**:

```ts
import { tool } from 'ai';
import { z } from 'zod';

function buildActionTool(op: ActionOperation, action: Action) {
  return tool({
    description: op.description,
    inputSchema: jsonSchemaToZod(op.input_schema), // 對應 openAPISchemaToZod
    execute: async (input) => {
      const url = buildUrl(action.domain, op.path, op.param_locations, input);
      const headers = await buildAuthHeaders(action); // 對應 setAuth
      const res = await ssrfSafeFetch(url, { method: op.method, headers, redirect: 'manual' });
      return res.json();
    },
  });
}
```

`streamText({ tools })` / `Agent` 的內建 tool-calling 迴圈可以直接吃這些工具,不用自己維護 `ToolMap`/`ActionToolMap` 這類手刻映射,這點跟 LangGraph 系一樣省事;但這條路線沒有 LibreChat 既有程式碼可以照搬結構,`createActionTool` 的認證分支/SSRF 防護邏輯要在 `execute` 內自行組裝。

**OAuth 掛起-恢復這一段,四個框架的落差最大**(對應 19-framework-options.md 能力矩陣的「HITL interrupt/resume」一列):

| | LangGraph | LangChain | deepagents | ai-sdk |
|---|---|---|---|---|
| 掛起目前 tool call、等外部事件恢復 | `interrupt()` + `Command({resume})` + checkpointer,跨 process/replica 都能 resume | `humanInTheLoopMiddleware` 開箱 | `interruptOn` 參數開箱(底層即 LangGraph interrupt) | 無對應原語;v7 tool approvals 是「執行前政策核准」,不是「執行中掛起等外部事件」;需自建 |

- **選 LangGraph 系**:LibreChat 現制「`flowManager.createFlow` 內部 `await` 一個由外部 `completeFlow` resolve 的 Promise」這套自建 flow store,可以直接換成 `interrupt()` 丟出待授權狀態、`Command({resume: tokenData})` 恢復——語意更貼近「掛起-恢復」本意,且天生跨 process/replica(某種程度上,LibreChat 現制要自己刻 flow store,正是因為它沒有 checkpointer 可用)。
- **選 Vercel AI SDK**:沒有「掛起 tool call 等外部事件」的內建機制,做法與 LibreChat 現制相同(這段可以照抄):`execute` 內部檢查沒有有效 token 時,先把 authURL 用你自己的 SSE/data-stream 事件推給前端,再 `await` 一個由 Redis pub/sub 或輪詢 resolve 的 Promise;`streamText`/`Agent` 的單次 `execute` 呼叫可以安全地跑很久(它就是個 async function),這點跟 LibreChat 的模型相容。

不論選哪個框架,框架本身都不管 OAuth 授權流程本身(code 換 token、refresh),這段都要照抄 `packages/api/src/oauth/tokens.ts` 的邏輯(HTTPS-only 端點驗證、SSRF-safe agent、`maxRedirects:0`)。

### Redis 的用途

- **OAuth flow state**:對應 `actionFlowManager`。用 `SET action-oauth:{userId}:{actionId} <state> EX 180`(3 分鐘,比照 LibreChat 的 action TTL)+ Pub/Sub 或短輪詢通知等待中的 `execute()` 恢復執行。
- **解析後的 operation 快取**(可選):若不想每次工具載入都查 `action_operations` 表,可以把「spec_hash → parsed operations」快取進 Redis,TTL 抓長一點(spec 不常變)。
- **CSRF/session cookie 驗證**不需要 Redis(HMAC 驗證是無狀態的,跟 LibreChat 一樣用 `crypto.createHmac` 簽章 + timing-safe compare 即可,見 `packages/api/src/oauth/csrf.ts:51`)。

### Next.js 前端考量

- **Action 編輯表單**:domain 輸入框、OpenAPI spec 貼上框(建議前端就先跑一次 `validateAndParseOpenAPISpec` 等價的 client-side 驗證,減少無效 round-trip)、依 `auth_type` 動態顯示 API Key / OAuth 欄位。永遠不要把已加密的憑證值傳回前端——POST 回應要把敏感欄位剝掉,前端表單用「已設定/未設定」的布林值表示,而非顯示遮罩過的假值。
- **OAuth 授權 UX**:工具呼叫卡片偵測到「需要授權」狀態(對應 LibreChat 把 authURL 塞進 tool-call 的 SSE delta)時顯示按鈕;點擊前先呼叫 `/actions/:id/oauth/bind` 設 CSRF cookie,再 `window.open(authURL)`。回呼頁面(`/oauth/success` / `/oauth/error`)是獨立分頁,完成後靠原分頁的串流事件自然恢復,不需要 postMessage 或輪詢父視窗。
- **不要嘗試從工具名反解 domain 給使用者看**:直接在 tool-call 的 metadata/SSE event 裡把人類可讀的 domain 或 action 名稱一起帶著走(這是 LibreChat 前端目前的弱點,見前文陷阱),移植時原生解決掉,不用重蹈覆轍。

---

### 一句話總結

Actions 子系統的核心價值不是「把 OpenAPI 轉成工具」(這件事本身很直觀,`openapiToFunction` 一兩百行就能做完),而是圍繞它的**安全與相容性工程**:三層 SSRF 防護、憑證加密與「認證邊界改變即拒絕沿用」的更新語意、OAuth 授權在 agent 串流中掛起-恢復的模式、以及為了塞進 provider 工具名限制而生的 domain 編碼/雙重註冊複雜度。移植時,最後一項(domain 編碼)可以因為你不受 Azure 舊限制束縛而整個砍掉;前三項是真正值得照搬概念、用你自己的技術棧重寫的部分。
