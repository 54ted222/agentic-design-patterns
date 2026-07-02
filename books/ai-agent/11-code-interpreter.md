# 11. Code Interpreter 沙箱

## 定位

LibreChat 不在自己的 Node process 裡執行任何 Agent 產生的程式碼。所有「跑程式碼」的需求——`bash_tool` / `execute_code` 的 shell、Python 執行,以及 Skills 讀取參考檔案——最終都會被轉發到一個**外部沙箱微服務**(以下沿用程式碼註解裡的稱呼「codeapi」/ Code Interpreter API,官方對外文件稱為 Code Interpreter API,由 `@librechat/agents` 這個套件的 `createCodeExecutionTool` 負責建立 tool 實例並打 HTTP 呼叫)。LibreChat 後端在這個子系統裡扮演的角色純粹是:

1. **委託執行**:把 `lang`/`code`/`session_id`/`files` 組成請求丟給 codeapi 的 `/exec`,自己完全不解析、不沙盒化程式碼本身。
2. **身份與租戶橋接**:把 LibreChat 自己的使用者 session(Passport JWT)換成 codeapi 能理解的憑證——要嘛是靜態共享密鑰(`x-api-key`,legacy 模式),要嘛是短效、帶租戶宣告的 JWT(`mintCodeApiToken`)。
3. **檔案生命週期橋接**:codeapi 是一個「執行完就可能被回收」的暫存工作區;LibreChat 把 codeapi 產出的檔案下載下來、存進自己的持久化檔案系統(S3/本地/…),並把使用者之前上傳或產生的檔案在每個回合開始前重新「注水」(prime)進 codeapi 的儲存 session,讓沙箱看起來像是有跨回合記憶的檔案系統(`/mnt/data/...`)。
4. **能力與租戶隔離的把關者**:是否允許某個 Agent 使用程式碼執行,是 admin 層(`librechat.yaml` capabilities)與 Agent 層(`agent.tools` 是否勾選)的雙重 AND 閘門;codeapi 端則靠 JWT 裡的 `tenant_id` claim 做租戶邊界。

在整體架構中,本文件與 07-tool-system.md(工具載入四大類、認證解析的通用機制)、08-mcp-integration.md(MCP 的連線/session 管理)是同一層的兄弟文件,但聚焦在 `execute_code` 這一種 native tool 的**遠端委託細節**——這是四大工具類別裡唯一「後端完全不執行任何業務邏輯,只做轉發 + 檔案代理」的一種,值得獨立成篇。Skills 子系統（技能參考檔案如何借用同一個沙箱 session）只在「與其他子系統的邊界」這個角度略提,細節留給未來的 Skills 專篇。

---

## 核心概念

| 名詞 | 說明 |
|---|---|
| **codeapi / Code Interpreter API** | 外部沙箱微服務,LibreChat 透過 `getCodeBaseURL()`(`@librechat/agents` 匯出,讀取 `LIBRECHAT_CODE_BASEURL` 環境變數)拿到 base URL,再用一般 HTTP(`/exec`、`/upload`、`/upload/batch`、`/download/...`、`/sessions/.../objects/...`)呼叫它。 |
| **執行 session(execution session)** | 沙箱容器層級的暫存 session,第一次 `/exec` 呼叫時由 codeapi 建立並回傳 `session_id`;同一個 session 內連續呼叫可以共享檔案系統與已安裝套件,但有 TTL,過期即整個丟棄。 |
| **儲存 session(storage session,`storage_session_id`)** | 與執行 session 是不同概念但共用欄位名 `session_id` 的歷史包袱——這是「檔案快取」層級的長效 session,由**資源身份**(`kind` + `id` + `version?`)決定,不隨單次執行結束而消失。`CodeEnvRef`(見下)就是指向這個層的指標。 |
| **`CodeEnvRef` / `CodeEnvKind`** | LibreChat 檔案記錄裡指回 codeapi 儲存位置的型別化指標,`kind` 是封閉集合 `'skill' \| 'agent' \| 'user'`,決定這份檔案在 codeapi 端的快取是否跨使用者共享。`packages/data-provider/src/codeEnvRef.ts:19-59` |
| **`primeCodeFiles`(對外匯出名 `primeFiles`)** | 每次 run 開始前,把「這個 Agent/對話能看到的檔案」從 Mongo 查出來,逐一檢查其 `codeEnvRef` 指向的儲存 session 是否還「新鮮」(< 23 小時),新鮮就沿用,過期就重新上傳到 codeapi 換一組新的 `(storage_session_id, file_id)`。`api/server/services/Files/Code/process.js:766-969` |
| **`Graph.sessions` / `ToolSessionMap`** | `@librechat/agents` Graph 執行期的一個 run-scoped Map,鍵是 `Constants.EXECUTE_CODE`,值是 `{ session_id, files, lastUpdated }`。這是 LibreChat 把 `primeCodeFiles` 的結果「餵給」Agent Graph 的唯一管道——沒有它,第一次 `execute_code`/`bash_tool`/`read_file` 呼叫會拿不到任何先前檔案。**Skills 的參考檔案也寫進同一個 Map**,因此程式碼沙箱與 Skills 天然共享同一個沙箱 session(見下文「架構決策」)。`packages/api/src/agents/codeFilesSession.ts` |
| **`codeEnvAvailable`** | 執行期的能力閘門布林值,= `librechat.yaml` 的 admin capability(`endpoints.agents.capabilities` 是否包含 `execute_code`)**AND** 該 Agent 自己的 `tools` 是否勾選了 `execute_code`。兩者缺一,`bash_tool`/`read_file` 都不會註冊給 LLM。`api/server/services/Endpoints/agents/initialize.js:151`、`packages/api/src/agents/initialize.ts:1070-1093` |
| **`mintCodeApiToken` / `getCodeApiAuthHeaders`** | LibreChat → codeapi 的第二層身份憑證。把 LibreChat 自己已驗證的 `req.user`(角色、租戶、來源)濃縮成一組短效 JWT claims,簽名後當 `Authorization: Bearer` 送給 codeapi。`packages/api/src/auth/codeapi.ts` |
| **`processCodeOutput` / download 路由** | codeapi 執行完後回傳的產出檔案清單只是暫存在沙箱裡的指標;`processCodeOutput` 負責把每個檔案下載下來、存進 LibreChat 自己的檔案儲存策略、寫入 Mongo `File` 記錄,並讓前端可以透過 `/api/files/code/download/:session_id/:fileId` 再次取得。`api/server/services/Files/Code/process.js:316-662`、`api/server/routes/files/files.js:290-339` |

---

## 架構與流程

### 元件關係

```
┌───────────────┐   requireJwtAuth (LibreChat 自己的使用者 JWT)
│   前端 / SPA   │───────────────────────────────────────────┐
└───────────────┘                                             │
                                                                ▼
                                            ┌──────────────────────────────────┐
                                            │   LibreChat API (/api)            │
                                            │                                    │
                                            │  ToolService.js / handleTools.js  │
                                            │   └─ primeCodeFiles()  ───────────┼──┐
                                            │                                    │  │ 1. 檔案新鮮度檢查 / 重新上傳
                                            │  Endpoints/agents/initialize.js    │  │
                                            │   └─ codeEnvAvailable 閘門         │  │
                                            │                                    │  │
                                            │  @librechat/agents Graph          │  │
                                            │   ├─ Graph.sessions[EXECUTE_CODE] │  │
                                            │   └─ ToolNode → createCodeExecutionTool
                                            │        (authHeaders callback)      │  │
                                            │                                    │  │
                                            │  Files/Code/process.js            │  │
                                            │   └─ processCodeOutput() ─────────┼──┤ 2. 下載產出檔 → 存本地存 File 記錄
                                            │                                    │  │
                                            │  routes/files/files.js            │  │
                                            │   └─ GET /code/download/:sid/:fid │  │ 3. 前端再次下載
                                            └──────────────────────────────────┘  │
                                                                │                  │
                                          x-api-key(legacy) 或   ▼                  ▼
                                          Bearer <JWT>(mintCodeApiToken)  ┌────────────────────┐
                                          ─────────────────────────────► │  codeapi 沙箱微服務  │
                                                                          │  /exec /upload      │
                                                                          │  /download /sessions │
                                                                          └────────────────────┘
```

### 逐步流程(一個 Agent 回合)

1. **能力解析**:`initializeClient`/`initializeAgent` 讀 `appConfig.endpoints.agents.capabilities`,算出 admin 層 `codeEnvAvailable`;再跟該 Agent 的 `tools` 是否含 `execute_code` 做 AND,得到 per-agent 的 `effectiveCodeEnvAvailable`。只有兩者皆真,才把 `bash_tool` + `read_file`(或舊路徑的 `execute_code` 單一 tool)注入這回合的工具定義。
   `api/server/services/Endpoints/agents/initialize.js:151`、`packages/api/src/agents/initialize.ts:1070-1093`

2. **檔案 priming(`primeFiles`)**:在 tool 被真正建立前(`requestedTools[Tools.execute_code] = async () => {...}`),LibreChat 從 Mongo 撈出「這個 Agent 的 `tool_resources.execute_code.file_ids`」+「使用者直接附加的檔案」,逐一:
   - 沒有 `metadata.codeEnvRef` 的檔案直接跳過(它不是曾經進過沙箱的檔案)。
   - 同一個 `storage_session_id` 在本輪已經確認過新鮮的,直接複用(session 級快取,`sessions` Map)。
   - 呼叫 `getSessionInfo(ref, req)` → `GET /sessions/:sid/objects/:fid` 問 codeapi 這個物件的 `lastModified`;`checkIfActive` 用「距今 < 23 小時」當作新鮮度判斷。
   - 過期或查無資訊 → `reuploadFile()`:用 LibreChat 自己儲存策略的 `getDownloadStream` 把檔案內容讀出來,再用 `uploadCodeEnvFile` 傳給 codeapi 換一組新的 `(storage_session_id, file_id)`,並把新 ref 寫回 Mongo。
   `api/server/services/Files/Code/process.js:766-969`

3. **Session 注水(`Graph.sessions`)**:`primeFiles` 回傳的 `files` 陣列(含 `id`/`resource_id`/`storage_session_id`/`name`/`kind`/`version?`)經 `buildInitialToolSessions` 合併「主 Agent + 所有 handoff/子 Agent + Skills 已 prime 的檔案」,寫進同一張 `Graph.sessions[Constants.EXECUTE_CODE]`。這一步發生在 Graph 真正開始跑之前,否則第一次 `execute_code` 呼叫的 `_injected_files` 會是空的——因為此時根本還沒有「執行 session」可以問。
   `packages/api/src/agents/codeFilesSession.ts:44-169`、`api/server/controllers/agents/client.js:1362-1377`

4. **實際執行(不透明,交給 `@librechat/agents`)**:Graph 的 `ToolNode` 呼叫 `execute_code`/`bash_tool` 時,把 `tc.codeSessionContext`(即步驟 3 seed 的內容,執行過幾輪後會被最新的 `session_id`/`files` 取代)注入呼叫參數,由 `createCodeExecutionTool` 建出的 tool 實體去打 codeapi 的 `/exec`。這一段的 HTTP 呼叫細節屬於 `@librechat/agents` 內部(原始碼不在本 repo),LibreChat 只提供了建構參數:`user_id`、prime 好的 `files`、以及一個延遲求值的 `authHeaders` callback(見下一節認證)。
   `api/app/clients/tools/util/handleTools.js:289-308`

5. **產出檔案回收(`processCodeOutput`)**:codeapi 執行結果裡列出的每個輸出檔,都要靠 `GET {baseURL}/download/:session_id/:id?kind=user&id=<userId>` 下載下來(注意:所有程式碼「產出」的檔案在 LibreChat 這端一律用 `kind: 'user'` 存,不管是哪個 skill 觸發的執行)。下載後:
   - 依副檔名分流成圖片 / 一般檔案兩條路徑,套用 `fileSizeLimit`(超過就退化成「下載連結」而非內嵌檔案,見陷阱章節)。
   - `claimCodeFile` 用 Mongo `findOneAndUpdate` + `$setOnInsert` 原子性地用 `(filename, conversationId, context, tenantId)` 這組複合鍵去「認領」一個 `file_id`,同名檔案重複產生時更新舊記錄而不是造出新記錄。
   - 依檔案分類(`classifyCodeArtifact`)決定要不要跑「文字/HTML 預覽萃取」(`office` 類型:DOCX/XLSX/…走非同步、有 60 秒硬上限的背景轉檔,其餘類型同步萃取)。
   - 存進 LibreChat 自己的 `getStrategyFunctions(appConfig.fileStrategy).saveBuffer`(本地/S3/…),寫入 Mongo `File`,附上 `metadata.codeEnvRef` 讓下一回合的 `primeFiles` 能把它重新指回 codeapi。
   `api/server/services/Files/Code/process.js:316-662`

6. **下載路由**:前端要拿到這些檔案時打 `GET /api/files/code/download/:session_id/:fileId`(這裡的 `session_id`/`fileId` 是**codeapi 那邊**的 id,不是 Mongo 的 `file_id`),路由用 `isValidID`(21 碼 nanoid 正規表達式)過濾參數,再用 `getStrategyFunctions(FileSources.execute_code).getDownloadStream` 回頭問 codeapi 拿 stream 直接 pipe 給前端。
   `api/server/routes/files/files.js:286-339`

7. **`read_file` / `write_file` 的旁路**:當 Agent 要讀一個不是已知「skill 檔案命名空間」的路徑(典型是 `/mnt/data/...`)時,`handleReadFileCall`(`packages/api/src/agents/handlers.ts`)會退回呼叫 `readSandboxFile`——本質是對 codeapi `/exec` 送一個 `cat '<path>'` 的 bash 命令,而不是走專門的檔案 API。`writeSandboxFile` 同理,用一段內嵌的 Python 腳本 + base64 payload 寫檔,避免路徑/內容被拼進 shell 語法造成注入。這兩個函式都吃同一個 `session_id`/`files` 參數(來自 `tc.codeSessionContext`),確保讀寫落在同一個沙箱 session 裡。
   `api/server/services/Files/Code/process.js:971-1132`

### 兩種授權方式(LibreChat → codeapi)

`getCodeApiAuthHeaders(req)` 是唯一的出口:除非 `CODEAPI_JWT_ENABLED=true` 或 `CODEAPI_AUTH_PROVIDER` 為 `librechat-jwt`/`both`,否則一律回傳 `{}`(不加任何 header)。

```
CODEAPI_AUTH_PROVIDER=legacy-api-key   → getCodeApiAuthHeaders 回傳 {}
CODEAPI_AUTH_PROVIDER=librechat-jwt    → getCodeApiAuthHeaders 回傳 { Authorization: 'Bearer <JWT>' }
CODEAPI_AUTH_PROVIDER=both             → 同上(JWT 優先,legacy 由外部靜態金鑰另行處理)
```

- **legacy-api-key(靜態共享密鑰,`x-api-key`)**:這是舊版單租戶部署的模式——一把固定的 API key(環境變數層級,不在本 repo 程式碼路徑上出現,推測由 `@librechat/agents` 內部或反向代理直接附加)。`getCodeApiAuthHeaders` 在這個模式下**刻意什麼都不做**(見測試 `codeapi.spec.ts:271-280`),代表 LibreChat 應用層完全不參與這條認證路徑,是一個對本 repo 而言不透明的邊界——移植時要特別注意:不能假設「不加 JWT header 就等於沒有認證」。
- **librechat-jwt(短效 JWT,`mintCodeApiToken`)**:企業/多租戶模式。每次要打 codeapi 前,用當前 `req.user` 現簽一張 JWT:
  - 演算法 `EdDSA`(預設)或 `RS256`,私鑰來自 `CODEAPI_JWT_PRIVATE_KEY`(PEM)/`_BASE64`/`_PRIVATE_JWK_JSON` 三選一。
  - `iss`/`aud` 預設 `librechat`/`codeapi`,`kid` 預設 `lc-codeapi-2026-05`。
  - **TTL 硬上限 300 秒**(`MAX_TTL_SECONDS`,即使環境變數設更大也會被夾住),`nbf`/`iat`/`exp` 皆秒級。
  - Claims 帶 `tenant_id`、`role`、`principal_source`(`librechat_jwt` 或 `openid_reuse`,取決於 `req.authStrategy`)、可選的 `org_id`/`service_id`/`chc_user_id`/`plan_id`,以及一個 `auth_context_hash`(把上述欄位正規化後 SHA-256,codeapi 端可用來快速比對 context 是否變動)。
  - **絕不轉發上游 IDP 的 `refresh_token`/`access_token`**——即使 `principal_source === 'openid_reuse'`,也只帶 `chc_user_id` 這個外部身份識別碼,測試明確斷言 claims 裡不含任何憑證字串。
  - Claims 只信任 `req.user`(伺服器端已驗證的 session),完全忽略 `req.body`/`req.headers` 裡任何 `tenant_id` 相關欄位,防止客戶端偽造租戶。
  - **簽發快取**:同一個 `(alg, kid, sub, tenant_id, role, principal_source, ..., auth_context_hash)` 組合的 token 會被記憶體快取,快取視窗取 `min(CODEAPI_JWT_MINT_CACHE_SECONDS, TTL - 30s)`(預設 30 秒、上限 30 秒),避免同一回合裡多次工具呼叫每次都重新簽章;但快取絕不會讓 token 活過 TTL。
  `packages/api/src/auth/codeapi.ts:118-372`

---

## 關鍵資料結構

### `CodeEnvRef`(存在 Mongo `File.metadata.codeEnvRef`)

| 欄位 | 型別 | 用途 |
|---|---|---|
| `kind` | `'skill' \| 'agent' \| 'user'` | 決定 codeapi 端 sessionKey 的命名空間:`skill`/`agent` 是**跨使用者共享**(同租戶內任何人叫同一個 skill/agent 都命中同一份快取),`user` 是**使用者私有**(sessionKey 由請求者的 auth context 決定,`id` 只是佔位,codeapi 不採信)。 |
| `id` | `string` | 資源識別碼:skill 是 skill `_id`,agent 是 agent id,user 則僅供 shape 一致、不參與路由。 |
| `version` | `number`(僅 `kind==='skill'` 必填,其餘禁止) | skill 的單調遞增版本號,skill 內容一改版本就跳號,天然讓舊快取失效。TypeScript 用 discriminated union 在編譯期就擋掉「skill 缺 version」或「非 skill 帶 version」。 |
| `storage_session_id` | `string` | codeapi 儲存層的 session id(長效,不等於單次執行的 `session_id`)。 |
| `file_id` | `string` | codeapi 對這個檔案的內部 id。 |

`packages/data-provider/src/codeEnvRef.ts:19-59`

### `sessionAuth` 查詢參數(`buildCodeEnvDownloadQuery` / `appendCodeEnvFileIdentity`)

codeapi 端的 `sessionAuth` middleware 需要在 **每一個** download/objects/upload 請求上看到 `kind`/`id`/`version?`,才能反推出跟原始上傳一致的 sessionKey(格式:`<tenant>:<kind>:<id>[:v:<version>]`,或 `<tenant>:user:<userId>`)。少帶就會被 codeapi 400。這組工具函式在 upload(multipart 表單欄位)與 download(query string)兩處共用同一份驗證規則。
`packages/api/src/files/code/identity.ts:19-78`

### Mongo `File` schema 中與 code-execution 相關的欄位

| 欄位 | 型別 | 用途 |
|---|---|---|
| `file_id` | string(index) | LibreChat 自己的檔案 id(非 codeapi 的 id)。 |
| `context` | string | 產出檔固定為 `FileContext.execute_code`;使用者上傳給沙箱用的原始檔則是別的 context。 |
| `metadata.codeEnvRef` | 內嵌 schema(見上表) | 指回 codeapi 儲存位置的指標;沒有這個欄位的檔案不會被 `primeFiles` 考慮。 |
| `status` | `'pending' \| 'ready' \| 'failed'`(index) | 僅 office 類型檔案(DOCX/XLSX/…)使用的「延遲預覽」生命週期狀態;非 office 檔案這欄位是 `null`。 |
| `textFormat` | `'html' \| 'text'` | 標記 `text` 欄位的可信任程度——**只有 `'html'` 才可以被前端當 HTML 注入 iframe**,office 轉檔失敗絕不能悄悄退化成純文字顯示(否則會把「還沒轉好」誤判成「這就是內容」)。 |
| `previewError` | string(≤200 字) | `'timeout' \| 'parser-error' \| 'orphaned' \| 'unexpected'` 等機讀原因,刻意限長避免整段 stack trace 塞進文件。 |
| `previewRevision` | string(UUID) | 每次同名檔案重新產生就換一個新值;背景轉檔完成時用這個值做「樂觀鎖」條件更新,避免舊回合的慢轉檔覆蓋新回合已完成的結果。 |
| `usage` | number | 同一個 `(filename, conversationId)` 被重新產生的次數,決定圖片檔要不要加 `?v=timestamp` 破快取。 |
| `tenantId` | string(index) | 多租戶隔離,連同 `claimCodeFile` 的複合唯一索引一起生效。 |
| Mongo 索引 | `{ filename, conversationId, context, tenantId }` **唯一**,但只在 `context === 'execute_code'` 時生效(`partialFilterExpression`) | 這就是 `claimCodeFile` 能原子性防止 TOCTOU 重複建檔的底層機制。 |

`packages/data-schemas/src/schema/file.ts:1-168`

### `mintCodeApiToken` 的 JWT claims(`CodeApiClaims`)

| 欄位 | 說明 |
|---|---|
| `iss` / `aud` | 固定 `librechat` / `codeapi`(可配置)。 |
| `sub` | LibreChat 使用者 id。 |
| `iat` / `nbf` / `exp` | 秒級時間戳,`exp - iat` 即 TTL,硬上限 300 秒。 |
| `jti` | 每次簽發的隨機 UUID(重放追蹤用)。 |
| `tenant_id` | 來自 `req.user.tenantId`,缺省時退回 `getTenantId()` 或單租戶預設值 `'legacy'`(可覆寫);嚴格租戶模式(`TENANT_ISOLATION_STRICT=true`)下缺租戶直接拋錯,拒發 token。 |
| `role` | `req.user.role`,預設 `'USER'`。 |
| `principal_source` | `'librechat_jwt'` 或 `'openid_reuse'`,由 `req.authStrategy === 'openidJwt'` 判斷。 |
| `org_id` / `service_id` / `chc_user_id` / `plan_id` | 選填的企業上下文,僅在有值時才出現在 claims 裡(不塞空字串佔位)。 |
| `auth_context_hash` | 上述欄位正規化 JSON 後的 SHA-256,供 codeapi 快速比對「這個 token 代表的身份組合是否變過」。 |

`packages/api/src/auth/codeapi.ts:26-42, 253-294`

---

## 關鍵實作細節與陷阱

- **檔名路徑穿越防護是兩層疊加的**:`sanitizeArtifactPath` 先擋 `../`、絕對路徑、trailing slash 等穿越模式,並對每個路徑片段做字元清洗與長度截斷;但因為它**保留巢狀目錄結構**(`a/b/file.txt` → `a/b/file.txt`,不是全部拍平),真正要存進檔案系統時還要再過 `flattenArtifactPath` 把 `/` 換成 `__` 並壓進 `NAME_MAX(255) - file_id.length - 2` 的預算內,否則巢狀路徑攤平後單一路徑片段仍可能 `ENAMETOOLONG`。兩層都不做會導致 `saveBuffer` 直接丟例外、退化成「僅提供下載連結」的 fallback 分支。`api/server/services/Files/Code/process.js:390-396, 505-517`、有專門的迴歸測試 `__tests__/process-traversal.spec.js` 鎖住這個行為。
- **分類要用 basename,不能用清洗後的完整路徑**:`classifyCodeArtifact`/`extractCodeArtifactText` 是用字串裡「最後一個 `.`」猜副檔名,如果傳入 `reports.v1/Makefile` 這種帶點目錄名的巢狀路徑,會誤判副檔名而讓明明該萃取文字的檔案被歸類成 `other` 跳過萃取。修法是傳 `path.basename(safeName)` 而不是完整路徑。`api/server/services/Files/Code/process.js:530-541`——這是「保留巢狀結構」這個設計決策的直接代價,移植時要留意任何「用檔名字串猜型別」的邏輯都得先 basename。
- **TOCTOU 用資料庫層級的原子 upsert 解,不是應用層鎖**:多個並發的 `processCodeOutput` 對同一個檔名可能同時觸發,`claimCodeFile` 用 `findOneAndUpdate({ ..upsert: true, $setOnInsert })` + Mongo 的複合唯一索引,讓「認領 file_id」這個操作本身具備原子性,不需要分散式鎖。認領用的是**清洗後**的 `safeName`,不是原始 `name`,否則會出現「用髒名字認領、用乾淨名字寫入」導致認領記錄孤兒化的 bug。
- **同名檔案跨分支對話的 provenance 陷阱**:`processCodeOutput` 更新既有記錄時**刻意保留原始 `messageId`**,不覆寫成本次執行的 messageId——因為 `getCodeGeneratedFiles` 是用 `file_id IN threadFileIds`(從訊息的 `files` 陣列收集)過濾,不是用 `messageId IN threadMessageIds`。如果覆寫了 messageId,對話分支/重新生成時會讓某個 sibling 產生的檔案在另一個 sibling 的 thread 過濾條件下「憑空消失」。`api/server/services/Files/Code/process.js:430-438`、`packages/data-schemas/src/methods/file.ts:186-218` 有完整的三步驟情境說明。
- **23 小時新鮮度是啟發式,不是精確 TTL**:`checkIfActive` 純粹用「距上次 lastModified 是否 < 23 小時」判斷 session 是否還活著,並不知道 codeapi 容器真正的 TTL 是多少(留 1 小時緩衝)。這代表:(a) 在真正 TTL 邊界前一小時內仍可能誤判為新鮮而重複使用一個即將被回收的 session,首次呼叫失敗才會被動觸發重傳;(b) 反過來也可能在 TTL 還沒到就提早重傳,多付出一次下載+上傳的成本。這是「避免每回合都重傳」與「正確性」之間刻意選擇的權衡,沒有解決根本的時鐘不同步問題。
- **背景預覽轉檔的競態要用版本戳位守衛**:office 類檔案的 HTML 預覽是 fire-and-forget 的背景工作(`finalize` thunk),如果同一個 `(filename, conversationId)` 在轉檔完成前又被重新產生一次(游標亂序完成),舊的轉檔結果可能晚於新一輪的 `pending` 記錄才 resolve。`previewRevision` 就是解法——`updateFile` 的寫入條件式帶上這個版本戳,版本不符就靜默丟棄舊結果,不會覆蓋新記錄。同時有兩層逾時保護:內層萃取邏輯本身 12 秒逾時 + 外層 `PREVIEW_FINALIZE_TIMEOUT_MS = 60_000` 涵蓋佇列等待,逾時直接標記 `status: 'failed', previewError: 'timeout'`,避免檔案永遠卡在 `pending`。前端輪詢端點(`GET /files/:file_id/preview`)還有一個「lazy sweep」——輪詢當下發現 `pending` 已超過 2 分鐘就順手標記失敗,不必等專門的開機掃描任務。
- **HTTP Agent 特意關掉 keepAlive**:`codeServerHttpAgent`/`codeServerHttpsAgent` 都設 `keepAlive: false`,原因寫在註解裡——`follow-redirects`(axios 底層依賴)在 Node 19+ 預設 keepAlive 的情況下,會把 `socket.destroy` 洩漏成一個 timeout listener,汙染 socket 池,連累其他不相干的 HTTP client(例如 agents 套件內部用 `node-fetch` 打的 `CodeExecutor`)。這是一個相當隱晦但真實發生過的坑,移植到別的 HTTP client(如 undici/fetch)時要重新驗證是否還有類似的連線池汙染風險。`packages/api/src/utils/code.ts`
- **legacy-api-key 模式下,LibreChat 應用層完全不加任何 header**:`getCodeApiAuthHeaders` 在這個模式下回傳 `{}`,是刻意設計(測試明確驗證,見 `codeapi.spec.ts:271-280`)。這代表 `x-api-key` 這條認證路徑對本 repo 而言是**不透明邊界**——要嘛是 `@librechat/agents` 內部自己讀某個環境變數並附加 header,要嘛是反向代理層處理。移植時千萬不要假設「HTTP request 沒帶 Authorization header 就代表沒有認證」,一定要去確認實際部署的沙箱服務端是怎麼收這把共享密鑰的。
- **下載路由的參數白名單很窄**:`isValidID` 只接受 21 碼、`[A-Za-z0-9_-]` 的 nanoid 格式,任何不符合的 `session_id`/`fileId` 直接 400,這是防止把使用者可控字串拼進 codeapi URL path 造成路徑注入/SSRF 的第一道關卡(第二道是 codeapi 自己的驗證,但 LibreChat 不應該假設對方一定會擋)。`api/server/routes/files/files.js:286-303`
- **能力閘門是雙重 AND,任一邊關掉都會靜默不出現在工具清單**:`codeEnvAvailable`(admin)與 `agentRequestsCodeExec`(agent 自己的 `tools` 陣列)缺一,`bash_tool`/`read_file` 就不會被註冊——而且只有 debug 等級的 log(`[initializeAgent] Agent "..." requests execute_code but codeEnvAvailable=false; skipping...`),沒有任何面向使用者的錯誤訊息,排查「為什麼 code interpreter 用不了」時很容易忽略這條路徑。`packages/api/src/agents/initialize.ts:1070-1093`
- **程式碼沙箱的 session 機制與 MCP 的 session 機制是兩條完全獨立的路**:`Graph.sessions`(`ToolSessionMap`)只被 code-execution 與 Skills 寫入;MCP server 的連線狀態走完全不同的機制(`requestScopedConnections`、`userMCPAuthMap`,見 08-mcp-integration.md),兩者在型別、生命週期、多副本部署下的行為都不同(沙箱 session 是可以重新 prime 的儲存指標;MCP 連線是綁在單一 process 記憶體裡的 socket/子行程,無法跨副本共享)。不要把這兩個「聽起來都是 session」的概念混為一談。

---

## 設計決策分析

**為什麼把程式碼執行整個外包給獨立微服務,而不是在 Node process 裡跑一個沙箱(如 vm2/isolated-vm/子行程)?**
安全隔離是主因——任何嵌入主行程的沙箱方案都與應用伺服器共享作業系統層資源與網路命名空間,一旦被突破,波及範圍是整個 LibreChat 後端;獨立微服務可以用容器/gVisor/Firecracker 等更強的隔離手段,且能獨立擴縮容、獨立限流、獨立部署更新,不受主應用發版節奏綁死。代價是多了一整條網路邊界要處理認證、逾時、重試、檔案搬運,這也是本文件一半篇幅在講「認證」與「檔案橋接」的原因。

**為什麼要兩套認證模式(靜態 `x-api-key` + 短效 JWT),而不是直接統一成 JWT?**
`legacy-api-key` 保留給早期單租戶自架部署——那些場景下 LibreChat 與 codeapi 通常是同一個維運者部署在受信網路裡,一把共享密鑰已經夠用,強迫升級成 JWT 簽發基礎設施(金鑰管理、演算法選擇)對這些使用者是不必要的負擔。`librechat-jwt` 則是為多租戶/企業場景設計:短 TTL(300 秒硬上限)限制了金鑰外洩的暴露窗口,`tenant_id`/`auth_context_hash` claims 讓 codeapi 不需要回頭問 LibreChat 資料庫就能自行做租戶邊界判斷與快取失效決策。如果重新設計,可以考慮「所有部署一律走短效 JWT,單租戶只是把 `tenant_id` 固定成一個常數」,這樣少維護一條分支邏輯——但要接受「自架者也得管理一組簽名金鑰」的門檻提高。

**為什麼儲存快取要用 `kind`(skill/agent/user)分命名空間,而不是永遠以使用者為單位?**
如果所有檔案都掛在使用者身上,同一個 skill 被 100 個使用者呼叫,就要重複上傳 100 次一模一樣的參考檔案。用「資源身份」(skill/agent 的 id + 版本號)當快取鍵,讓跨使用者、同租戶的共享資源可以命中同一份 codeapi 儲存 session,只有真正屬於某次執行「產出」的檔案才強制 `kind: 'user'` 私有。這是一個明確的「預設隔離、顯式共享」模型:共享是靠型別系統(discriminated union)在編譯期強制標記出來的,不是靠事後的權限檢查補救。

**為什麼檔案優先權(priming)要做「新鮮度檢查 + 條件式重傳」,而不是每回合固定重傳,或是永遠信任快取?**
永遠重傳保證正確但浪費頻寬與延遲(尤其大檔案、長對話多輪工具呼叫時尤其明顯);永遠信任快取則會在 session 過期後產生難以除錯的「檔案讀不到」錯誤(因為錯誤只會在真正呼叫沙箱時才爆出來,而不是在 prime 階段)。折衷是用一次輕量的 `HEAD`-equivalent 查詢(`getSessionInfo`)加上 23 小時的啟發式閾值,把大部分正常對話都導向「快取命中、零額外上傳」的路徑,只有真正過期或首次使用的檔案才付重傳成本。這個設計已經在陷阱章節指出其時鐘誤差的侷限,但作為「盡量減少重複上傳」與「盡量避免對著已回收的 session 執行」之間的平衡,是合理的工程取捨。

**為什麼背景預覽轉檔要做成「立即持久化為 pending + fire-and-forget promise 完成後回填」,而不是同步阻塞?**
Office 檔案轉 HTML 預覽是 CPU 密集操作,若同步做,Agent 這一輪的回應會被卡住等轉檔完成,使用者體感延遲直接被沒有 SLA 保證的轉檔耗時綁架。把它變成非同步背景工作,讓「回應已送出」與「預覽何時就緒」解耦,前端用輪詢/SSE 補上狀態。代價是引入了本文件陷阱章節列出的整套版本戳競態保護、逾時保護、孤兒記錄掃描——如果重新設計且有現成的任務佇列基礎設施(如 BullMQ/Redis Streams),把這段搬到正式的背景 worker + 佇列會比「裸 Promise 不 await」更有交付保證(process 重啟不會丟任務),但也多引入一個外部依賴,對於這種「失敗了大不了顯示『預覽產生失敗,可下載原始檔』」的非關鍵路徑,目前的 fire-and-forget 設計未必不划算。

---

## 移植到新技術棧的建議

以下針對已定案的 **PostgreSQL + Hono + Next.js + pnpm + Redis + docker-compose** 給具體對應;AI agent 框架(LangGraph / LangChain / deepagents / Vercel AI SDK)尚未定案,四者選型比較見 19-framework-options.md,本文件只在牽涉框架能力的段落分別說明。前提假設:你依然選擇「外部沙箱微服務」這個架構(強烈建議保留,理由見上一節),新平台只是重新實作「LibreChat 這一側」的橋接邏輯——這件事本身與框架選擇關聯不大,沙箱委託的核心(HTTP 呼叫、檔案 priming、DB schema、下載路由)四個框架都要自己實作一遍,差異主要在「session 狀態怎麼串進 agent loop」這一小塊。

### PostgreSQL schema 草案

```sql
-- 對應 Mongo File 裡與 code-execution 相關的子集
CREATE TABLE code_files (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        text NOT NULL,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id       uuid,                 -- 保留「原始產生者」訊息,分支/regenerate 時不覆寫
  filename         text NOT NULL,        -- 已做過路徑清洗(等同 sanitizeArtifactPath 的輸出)
  storage_path      text NOT NULL,        -- 落在自家物件儲存(S3 相容)的 key
  mime_type        text NOT NULL,
  bytes            bigint NOT NULL,
  status           text CHECK (status IN ('pending','ready','failed')),
  preview_error    text,
  preview_revision uuid,                 -- 背景轉檔的樂觀鎖版本戳
  text_format      text CHECK (text_format IN ('html','text')),
  preview_text     text,
  code_env_kind    text NOT NULL CHECK (code_env_kind IN ('skill','agent','user')),
  code_env_id      text NOT NULL,        -- skill/agent id,或使用者 id(user kind 僅供 shape 一致)
  code_env_version int,                  -- 僅 kind='skill' 使用
  storage_session_id text NOT NULL,      -- codeapi 儲存 session
  sandbox_file_id  text NOT NULL,        -- codeapi 內部 file id
  usage_count      int NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz           -- 對應 LibreChat 的 retention expiredAt
);

-- 對應 claimCodeFile 的「同名檔案原子認領」語意:
-- 用 partial unique index,只在「這是程式碼產出檔」的資料列上強制唯一。
CREATE UNIQUE INDEX code_files_claim_key
  ON code_files (filename, conversation_id, tenant_id)
  WHERE code_env_kind = 'user';  -- 產出檔一律 user kind,對應 LibreChat 的 context = execute_code 條件

-- 認領邏輯用 INSERT ... ON CONFLICT DO UPDATE 取代 Mongo 的 $setOnInsert + findOneAndUpdate,
-- 一樣是資料庫層級原子操作,不需要應用層鎖:
-- INSERT INTO code_files (...) VALUES (...)
-- ON CONFLICT (filename, conversation_id, tenant_id) WHERE code_env_kind = 'user'
-- DO UPDATE SET bytes = EXCLUDED.bytes, usage_count = code_files.usage_count + 1, updated_at = now()
-- RETURNING *;
```

- `preview_revision` 的樂觀鎖寫法直接對應成 `UPDATE ... WHERE id = $1 AND preview_revision = $2`,受影響列數為 0 就代表被更新的回合已經過期,邏輯與 Mongo 版一致,SQL 反而更直覺。
- 不需要額外的 `expires_at`(短 TTL 上傳暫存)欄位用資料庫原生 TTL 機制,PostgreSQL 沒有 Mongo 的 `expires` index;改用一支排程 job(`pg_cron` 或應用層 cron)定期清理過期列即可。

### Hono route / middleware 對應

```ts
const files = new Hono();

// 對應 requireJwtAuth + configMiddleware + checkBan 疊加的順序
files.use('*', requireAuth, resolveTenant, checkBan);

// 對應 GET /code/download/:session_id/:fileId
files.get('/code/download/:sessionId/:fileId', async (c) => {
  const { sessionId, fileId } = c.req.param();
  if (!isValidSandboxId(sessionId) || !isValidSandboxId(fileId)) {
    return c.text('Bad request', 400);
  }
  const stream = await getCodeOutputDownloadStream(sessionId, fileId, {
    kind: 'user',
    id: c.get('user').id,
  }, c.get('sandboxAuthHeaders'));
  return new Response(stream, { headers: proxyHeaders });
});

// 對應 GET /:file_id/preview 的輪詢端點
files.get('/:fileId/preview', requireFileAccess, pollPreviewStatusHandler);
```

- `getCodeApiAuthHeaders(req)` 這種「延遲求值、每次呼叫前才決定要不要附加 JWT」的 callback 模式值得保留——用 Hono middleware 把 `mintSandboxToken` 掛在 context 上(`c.set('sandboxAuthHeaders', () => mintSandboxToken(c.get('user')))`),真正呼叫沙箱的地方才執行,而不是在 middleware 階段就先簽好(避免簽了用不到的 token,也讓「同一個請求內多次呼叫沙箱共用快取」的邏輯自然成立)。
- JWT 簽發邏輯(EdDSA/RS256、TTL 硬上限、tenant claims、`auth_context_hash`)幾乎可以整段搬過去,Node `crypto` 模組在 Hono(通常跑在 Node/Bun 環境)一樣可用;若目標是 Edge runtime(Vercel Edge/Cloudflare Workers),`crypto.subtle` 的 Ed25519 支援度要先確認,退回 RS256 + WebCrypto 更保險。

### Agent 框架層對應(依所選框架而異)

移植複雜度在這裡出現明顯的框架不對稱:LibreChat 的 `@librechat/agents` 本身就是 LangGraph 封裝,`Graph.sessions`/`ToolNode` 這套 run-scoped session 機制是「架在 LangGraph 之上的自製抽象」。選 LangGraph 系框架時這段可以近似照抄;選 ai-sdk 時則要另起爐灶,但爐灶不大。完整選型比較見 19-framework-options.md,這裡只列與沙箱委託直接相關的部分:

| 面向 | LangGraph | LangChain(`createAgent`) | deepagents | Vercel AI SDK |
|---|---|---|---|---|
| 沙箱 session 狀態容器 | 自訂 graph state channel(reducer 覆寫最新值),`primeFiles` 結果寫入圖 state——近似照抄 `Graph.sessions` 的角色 | 同 LangGraph(`createAgent` 回傳的就是編譯好的圖,可掛同一個 state channel) | 同 LangGraph;另有內建 filesystem backend(`StateBackend`/`StoreBackend`/`FilesystemBackend`/`CompositeBackend`)可直接接一個「沙箱 backend」,取代 LibreChat 現制裡 `readSandboxFile`/`writeSandboxFile` 兩支旁路函式 | 無圖 primitive,`execute` 函式用閉包變數捕捉 `{ sessionId?: string; files: FileRef[] }`,靠 `streamText`/`Agent` 的 `stopWhen: stepCountIs(n)` 多步驟 tool-calling 自然延續、每次工具呼叫更新它 |
| 工具定義方式 | `tool({ schema, func })`,`func` 內部打沙箱 `/exec` | 同左,middleware 可再包一層(如審批、重試) | 同左,或直接借用內建 filesystem 工具 + 沙箱 backend | `tool({ description, parameters: zodSchema, execute })`,`execute` 內部打沙箱 `/exec` |

不論選哪個框架都相同、與框架無關的部分:
- **跨回合檔案記憶**(對應 `primeCodeFiles`):一律是「建構這次工具定義之前,查 PostgreSQL 的 `code_files` 表做新鮮度檢查與必要的重傳」,邏輯幾乎可以照抄 `primeFiles` 的判斷順序(cache-hit by session → 查 codeapi 新鮮度 → 過期就重傳);差異只在「prime 完的結果要放進圖 state 還是閉包變數」。
- **檔案下載/預覽**:與 agent loop、與框架選擇都無關,是純粹的背景任務,可以維持原本「立即持久化 pending + 背景 worker 轉檔 + 輪詢/SSE 通知」的模式,用 Next.js 的 `after()`(15+)或獨立 queue worker 執行,不必綁在任何框架的執行生命週期裡。

### Redis 的用途

沙箱委託本身(HTTP 請求/回應)不需要 Redis——LibreChat 這裡也是同步 HTTP + Mongo 持久化,沒有用到快取層。合理的新增用途:

- **沙箱新鮮度查詢的短期快取**:同一回合內如果有多個工具呼叫都會觸發 `getSessionInfo`,可以用 Redis 存 `sandbox:freshness:<storage_session_id>` 幾十秒的 TTL,避免同一輪對話內對 codeapi 打好幾次一模一樣的查詢。
- **沙箱呼叫的速率限制**:對應 LibreChat `toolCallLimiter` 的概念,用 Redis 對 `(tenant, user)` 做 sliding window 限流,避免單一使用者的迴圈式工具呼叫把沙箱資源耗盡。
- **JWT 簽發快取**:LibreChat 這裡用 process 記憶體內的 `Map` 做,單一 replica 就夠用;多副本部署下**不建議**改成 Redis 共享快取——Ed25519 簽章本身很便宜(微秒級),多副本各自簽發、各自快取,遠比引入一個「簽發快取要不要跨副本共享」的分散式一致性問題來得簡單。

### Next.js 前端考量

- **預覽輪詢**:用 React Query 對 `/api/files/:fileId/preview` 做短間隔輪詢(對應 LibreChat 的 `useFilePreview`),`status !== 'pending'` 就停止輪詢;若已有 SSE/WebSocket 通道,優先用推播通知「該重新 fetch 了」,輪詢只當降級方案。
- **HTML 預覽的信任邊界**:前端渲染 office 轉檔出來的 HTML **必須**先檢查後端回傳的 `text_format === 'html'` 旗標,不能自己用副檔名或內容嗅探去猜——這個旗標的意義是「後端已經確認這段字串是可信任的沙箱轉檔輸出,不是任意上傳文件的純文字擷取」,漏掉這層檢查會讓 RAG 上傳的 `.docx` 純文字被誤判成 HTML 而有 XSS 風險(這正是 LibreChat 原始碼裡明確引用過的一次 code review 修復,`textFormat` 欄位的存在本身就是這個教訓的產物)。
- **下載連結**只暴露自家發的短 id(對應 `isValidID` 的 nanoid 白名單),永遠不要把沙箱端的原始 `storage_session_id`/內部 file id 直接串進可被使用者操縱的 URL 參數,即使目前的權限檢查已經夠嚴,最小暴露面仍是預設姿勢。

### 沒有直接對應、可以捨棄的部分

- **`Graph.sessions` 這種獨立於圖之外、自製的 `ToolSessionMap` 抽象**:若選 ai-sdk,如上一節所述,工具呼叫模型本身就讓這一層變得不必要,不用刻意模仿。若選 LangGraph 系(LangGraph/LangChain/deepagents),則不是「捨棄」而是「內化」——自己掌控的圖本身就有 state/channel 機制可以承接同樣的角色,不需要像 LibreChat 現制那樣另外維護一個並存於 Graph 之外的全域 Map(LibreChat 之所以做成獨立模組,某種程度是因為 `@librechat/agents` 的 Graph 介面對應用層是半黑盒,擴充圖 state schema 不方便;自建時沒有這層限制)。
- **legacy-api-key 這種不透明的靜態密鑰路徑**:新平台從第一天就用短效 JWT(即使是單租戶自架也一樣,只是把 `tenant_id` 固定成常數),沒有歷史包袱需要保留兩套認證分支。這一點與框架選擇無關。

---

## 出處索引(關鍵行號)

- 檔案 priming 與下載處理:`api/server/services/Files/Code/process.js:57-75`(下載失敗 fallback)、`:130-192`(背景預覽轉檔)、`:242-287`(finalize 執行與例外隔離)、`:316-662`(`processCodeOutput`)、`:664-670`(`checkIfActive`)、`:766-969`(`primeFiles`)、`:971-1043`(`readSandboxFile`)、`:1045-1132`(`writeSandboxFile`)。
- codeapi 檔案 CRUD:`api/server/services/Files/Code/crud.js:30-59`(下載 stream)、`:68-124`(刪除)、`:149-193`(單檔上傳)、`:217-274`(批次上傳)。
- 短效 JWT 認證:`packages/api/src/auth/codeapi.ts:61-70`(常數與 TTL 上限)、`:118-168`(簽章設定與快取失效)、`:216-230`(模式判斷)、`:253-294`(claims 組裝)、`:296-372`(簽章與快取)、`:374-380`(`getCodeApiAuthHeaders` 出口)。JWT 行為測試:`packages/api/src/auth/codeapi.spec.ts`。
- 下載/預覽路由:`api/server/routes/files/files.js:286-339`(`/code/download/:session_id/:fileId`)、`:341-398`(`/:file_id/preview` 輪詢與 lazy sweep)。
- 儲存策略選路:`api/server/services/Files/strategies.js:211-227, 309-343`。
- Session 注入 Graph:`packages/api/src/agents/codeFilesSession.ts:1-169`(`seedCodeFilesIntoSessions` / `buildInitialToolSessions`)、`api/server/controllers/agents/client.js:1362-1377`。
- 能力閘門:`api/server/services/Endpoints/agents/initialize.js:141-166`(`codeEnvAvailable` 計算)、`packages/api/src/agents/initialize.ts:1042-1093`(`effectiveCodeEnvAvailable` 與 `bash_tool`/`read_file` 註冊)。
- Skills 共用沙箱 session:`packages/api/src/agents/skillFiles.ts:322-540`(`primeInvokedSkills`)、`api/server/services/Endpoints/agents/skillDeps.js:351-360`(`LIBRECHAT_CODE_BASEURL` 與 `readSandboxFile`/`writeSandboxFile` 依賴注入)。
- 舊路徑工具建構:`api/app/clients/tools/util/handleTools.js:268-308`(`primedCodeFiles` 捕捉、`createCodeExecutionTool` 呼叫)、`api/server/services/ToolService.js:960-1061`(`loadToolDefinitionsWrapper` 的對應段落)。
- 資料模型:`packages/data-provider/src/codeEnvRef.ts:1-59`(`CodeEnvRef`/`CodeEnvKind`)、`packages/data-provider/src/config.ts:562-578`(`AgentCapabilities` enum)、`:679-694`(`defaultAgentCapabilities`)、`packages/api/src/files/code/identity.ts:1-78`(`buildCodeEnvDownloadQuery`/`appendCodeEnvFileIdentity`)、`packages/data-schemas/src/schema/file.ts:1-168`(Mongo `File` schema)、`packages/data-schemas/src/methods/file.ts:186-259, 298-331`(`getCodeGeneratedFiles`、`claimCodeFile`)。
- 連線層細節:`packages/api/src/utils/code.ts:1-12`(`codeServerHttpAgent`/`codeServerHttpsAgent`,`keepAlive: false` 的理由)。
- 路徑清洗:`packages/api/src/utils/files.ts:266-394`(`sanitizeArtifactPath`/`flattenArtifactPath`),迴歸測試 `api/server/services/Files/Code/__tests__/process-traversal.spec.js`。
- MCP session 對照組:見 08-mcp-integration.md;`api/server/services/ToolService.js:599-618, 753-794`(`userMCPAuthMap`/`requestScopedConnections`,與 `Graph.sessions` 分屬不同機制)。
