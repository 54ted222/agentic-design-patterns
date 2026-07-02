# 17. 認證與安全

> 讀者背景:你要用 **PostgreSQL + Hono + Next.js + pnpm + Redis + docker-compose** 從零打造 AI agent 平台;AI agent 框架(LangGraph / LangChain / deepagents / Vercel AI SDK)尚未定案,完整選型對照見 19-framework-options.md。本文件拆解 LibreChat(MongoDB + Express + Passport.js + Vite/React)的認證與安全子系統,重點是「它為什麼這樣設計」與「移植時該怎麼取捨」,而不是照抄它的寫法。
>
> 前置知識:設定系統見 02-config-system.md;多租戶 `appConfig` 解析(`resolveAppConfigForUser`)、角色/權限 ACL 屬於另一個範疇,本文件只點到為止,不深入。SSRF/domain allowlist 在 agent 工具呼叫外部 API 時的用途見 07-tool-system.md、09-actions-openapi.md、08-mcp-integration.md。

---

## 定位

這個子系統回答四個問題:「你是誰」(認證)、「你這次登入還要不要多一道關卡」(2FA)、「你被允許做什麼樣的請求頻率與內容」(rate limiting / moderation / PII 過濾)、「你搞破壞的話系統怎麼反制」(ban 系統)。

在整體架構中,它是所有其他子系統的**前門**:`api/server/routes/*` 幾乎每條路由的第一層 middleware 都是 `requireJwtAuth`(見 04-execution-engine.md 的路由總覽),而 `requireJwtAuth` 本身又依賴這裡的 JWT/Session 設計。認證失敗、被封鎖、內容被 moderation 擋下,都會在請求「進到業務邏輯之前」就短路掉——這是刻意的分層:業務邏輯(agent 執行、工具呼叫、對話儲存)完全不必關心「這個使用者是否可信」,因為進到 controller 時 `req.user` 已經是驗證過的。

程式碼分布(和其他文件一致的模式):
- **核心無狀態邏輯**(domain 驗證、密碼比對、cookie 安全性判斷、rate-limit store 工廠、OAuth 失敗訊息組裝)在 TypeScript 的 `packages/api/src/auth/`、`packages/api/src/oauth/`、`packages/api/src/cache/`。
- `/api`(legacy Express/JS)是**接線層**:10 個 Passport strategy(`api/strategies/`)、Express route/controller(`api/server/routes/auth.js`、`oauth.js`)、middleware(`api/server/middleware/`)、violation/ban 的 Mongo 讀寫(`api/cache/`)。
- 使用者/Session 的 Mongoose schema 與 CRUD 方法在 `packages/data-schemas/src/{schema,methods}/{user,session,token}.ts`。

---

## 核心概念

| 名詞 | 心智模型 |
|---|---|
| **Access Token** | 短命(預設 15 分鐘,`SESSION_EXPIRY`)、無狀態的 JWT,由 `JWT_SECRET` 簽,存 `{id, username, provider, email}`。放在回應 body 交給前端記憶體/localStorage,**不放 cookie**。每個 API 請求走 `Authorization: Bearer` header。 |
| **Refresh Token** | 長命(預設 7 天,`REFRESH_TOKEN_EXPIRY`)、由 `JWT_REFRESH_SECRET` 簽的 JWT,存 `{id, sessionId}`。放在 **httpOnly cookie**。同時把它的 hash 存進 Mongo `Session` collection——伺服器端可撤銷、可看到「使用者目前有幾個活躍 session」。 |
| **Session(DB 記錄)** | 不是 Express session,是 `Session` collection 裡「一個 refresh token 的存證」,欄位含 `refreshTokenHash`、`expiration`、`user`。`/auth/refresh` 用它驗證 refresh token 沒被撤銷,並輪替出新的 refresh token(rotate)。 |
| **express-session(OIDC/SAML 專用)** | 另一條完全不同的路:只給 OpenID/SAML 用,伺服器端儲存(Redis 或記憶體),存放 federated tokens(access/id/refresh token)。目的是避免這些 token 太大塞爆 cookie / HTTP header。 |
| **2FA 溫層 Token** | 登入密碼正確但使用者開了 2FA 時,`loginController` 不發 access/refresh token,改發一個 5 分鐘效期的 JWT(`{userId, twoFAPending: true}`),前端拿它打 `/2fa/verify-temp`。 |
| **Passport Strategy** | 每種登入方式(local/jwt/google/…)是一個 `passport.use(name, strategy)`,對應一個 `verify` callback,最終都要 `done(null, user)` 才算通過。LibreChat 幾乎所有 social/enterprise strategy 共用同一份 `socialLogin()` 工廠,行為高度一致。 |
| **Violation(違規)** | 一個帶 `type`(如 `LOGINS`、`MESSAGE_LIMIT`、`TOOL_CALL_LIMIT`)、`user_id`、`violation_count` 的物件。所有 rate limiter 命中上限時都會產生一個 violation,寫進 per-type 的計數快取,並嘗試觸發 ban。 |
| **Ban(封鎖)** | 違規次數達到 `BAN_INTERVAL` 的整數倍時觸發,對 `userId` **和** `req.ip` 同時下 ban 記錄(TTL = `BAN_DURATION`,預設 2 小時),並清掉該使用者所有 session + cookie(「軟撤銷」:access token 在到期前仍可用,但下一次 refresh/login 會被擋)。 |
| **Domain Allowlist(信箱網域白名單)** | `appConfig.registration.allowedDomains`,套用在**所有**認證入口(local 註冊、密碼重設、所有 social/OIDC/SAML/LDAP 登入)。空陣列/未設定=不限制。 |
| **Moderation** | 呼叫 OpenAI `/v1/moderations` API,對「使用者這次輸入的文字」做內容審查,flagged 就整個請求被 `denyRequest` 擋掉(不會進到 LLM)。 |
| **PII/Secret 過濾** | 純正規表示式的訊息前置過濾(`messageFilterPii`),攔截 API key、Bearer token 等看起來像機密的字串,400 擋下,**不呼叫任何外部服務**,跟 moderation 是兩條獨立管線。 |

---

## 架構與流程

### 元件關係(登入請求會經過的 middleware 疊層)

```
POST /api/auth/login
   │
   ▼
logHeaders ──▶ loginLimiter(rate limit) ──▶ checkBan(IP/user 是否被封) ──▶
   requireLocalAuth / requireLdapAuth(passport strategy) ──▶ setBalanceConfig ──▶ loginController
                                                                                     │
                                                                    twoFactorEnabled?├─ 是 → 5 分鐘 temp JWT
                                                                                     └─ 否 → setAuthTokens()
                                                                                              ├─ access token (body)
                                                                                              ├─ refreshToken cookie (httpOnly)
                                                                                              └─ Session collection 寫入 (hash)
```

```
之後每個受保護 API
   │
   ▼
requireJwtAuth ──▶ passport 'jwt' (或 'openidJwt' 優先, 見下方) ──▶ tenantContextMiddleware
   ──▶ (CloudFront cookie 續期, 選用) ──▶ req.user 可信 ──▶ controller
```

### 流程 A:本地帳密登入 + 2FA

出處:`api/server/routes/auth.js:42-51`、`api/strategies/localStrategy.js`、`api/server/controllers/auth/LoginController.js`、`api/server/controllers/TwoFactorController.js`。

1. `POST /login` 依序過 `loginLimiter`(見下方限流)→ `checkBan` → `requireLocalAuth`(或 LDAP,若 `LDAP_URL` 有設就整條走 LDAP,取代 local)。
2. `passportLogin()`(`localStrategy.js:17`)：Zod 驗證 body → `findUser({email}, '+password')`(注意 `+password`,schema 預設 `select: false`)→ `bcrypt.compare` → email 未驗證且未放行未驗證信箱登入(`ALLOW_UNVERIFIED_EMAIL_LOGIN`)則擋下。**注意**:帳號不存在、密碼錯誤、email 存在但密碼有 `select:false` 問題,三種失敗路徑的 log 訊息不同,但回給前端的 HTTP 語意都刻意模糊(見下方「陷阱」)。
3. `loginController`(`LoginController.js:5`)：若 `req.user.twoFactorEnabled`,**不**呼叫 `setAuthTokens`,而是 `generate2FATempToken(userId)` 回傳 `{twoFAPending:true, tempToken}`,狀態碼仍是 200。
4. 前端拿 `tempToken` 打 `POST /2fa/verify-temp`,走 `setTwoFactorTempUser`(從 tempToken 解出 `req.user = {id}`,讓後面的 rate limiter 認得使用者)→ `twoFactorTempLimiter`(IP + user 兩層限流)→ `checkBan` → `verify2FAWithTempToken`(`TwoFactorAuthController.js:14`):重新 `jwt.verify(tempToken, JWT_SECRET)`,拿 `+totpSecret +backupCodes` 查使用者,`verifyTOTP` 或 `verifyBackupCode` 過了才 `setAuthTokens`。
5. 沒開 2FA 的路徑直接 `setAuthTokens(userId, res, null, req)`(`AuthService.js:652`):建立 `Session`(Mongo)、簽 refresh token(JWT,裡面含 `sessionId`)存 `session.refreshTokenHash`、簽 access token(JWT)、把 `refreshToken`/`token_provider` 設成 httpOnly cookie。

### 流程 B:JWT 驗證(含 OpenID token-reuse 的雙策略 fallback)

出處:`api/server/middleware/requireJwtAuth.js`。

這是全系統唯一一個「同時掛兩種 Passport strategy、失敗會自動退回下一種」的認證 middleware,設計動機是讓 OpenID 使用者在 `OPENID_REUSE_TOKENS=true` 時,可以直接拿 IdP 發的 id_token 當 access token(省一次 LibreChat 自己的 JWT 簽發/驗證往返)：

1. 讀 `token_provider` cookie 判斷這個使用者上次是不是 OpenID 登入的;若是且功能開關開著,且 `openid_user_id` cookie(另一個 JWT,裝著 userId)驗證通過,策略陣列變成 `['openidJwt', 'jwt']`,否則就只有 `['jwt']`。
2. `openidJwt` strategy(`openIdJwtStrategy.js`)用 `jwks-rsa` 動態抓 IdP 的公鑰驗簽,**同時檢查 issuer 是否吻合**(含 Azure AD 多租戶的 `{tenantid}` 樣板比對,`issuerMatchesTemplate`)。找不到使用者時會退化用 email 做 fallback lookup 並就地把 `openidId` 補回去(遷移舊帳號)。
3. 第一策略失敗(或驗出的 user id 跟 cookie 裡的不一致——防止 token 冒用)就往下一個策略試,兩者都失敗才 401。每次 fallback 都寫一筆帶原因分類的 debug/warn log,方便排查「為什麼這個使用者一直被退回 JWT fallback」。
4. 成功後鏈式呼叫 `tenantContextMiddleware`(把 tenant 資訊放進 AsyncLocalStorage,供下游 Mongoose 查詢自動加租戶過濾)與 CloudFront cookie 續期 middleware。

### 流程 C:Refresh Token 輪替

出處:`api/server/controllers/AuthController.js:155`(`refreshController`)。

1. 非 OpenID 使用者:從 cookie 拿 `refreshToken`(JWT)→ `jwt.verify(JWT_REFRESH_SECRET)` 拿出 `payload.id`、`payload.exp`。
2. 用 `findSession({userId, refreshToken})` 查 Mongo——這一步是**真正的撤銷檢查點**:`findSession` 內部把明文 refresh token 重新 hash 一次去比對 `refreshTokenHash`,查不到代表這個 refresh token 已經被撤銷(登出、被 ban、密碼重設都會清 session)。
3. Session 存在且未過期 → `setAuthTokens(userId, res, session, req)`:注意這裡傳入既有 `session` 物件,`setAuthTokens` 會**重用同一個 session document 的 `_id` 和 `expiration`**,只重新簽一次 refresh token JWT 並覆寫 `refreshTokenHash`——這是滾動輪替(rotating refresh token),而不是每次都開新 session,好處是使用者的「登入裝置清單」不會因為頻繁刷新而爆增。
4. OpenID 使用者(`token_provider=openid` 且 `OPENID_REUSE_TOKENS=true`)完全走另一條路:優先嘗試「重用」session 裡還沒過期的 id_token/access_token(`OPENID_REUSE_MAX_SESSION_AGE_MS`,預設 15 分鐘內刷新過就直接回傳,不打 IdP),否則呼叫 `openIdClient.refreshTokenGrant` 跟 IdP 換新 token,再用 email/openidId 重新比對本地使用者(處理 openidId 遷移/不一致)。

### 流程 D:Ban 系統的兩層快取

出處:`api/server/middleware/checkBan.js`、`api/cache/logViolation.js`、`api/cache/banViolation.js`。

```
任何違規事件 (登入失敗次數過多 / 訊息超頻 / 工具呼叫超頻 / ...)
        │
        ▼
logViolation(req,res,type,errorMessage,score)
    ├─ violationLogs[type].get(userId) → +score → 存回去(累計違規計數,per-type)
    ├─ logs[GENERAL].push(errorMessage)          (稽核軌跡)
    └─ banViolation(req,res,errorMessage)
            │  prevThreshold = floor(prev_count / BAN_INTERVAL)
            │  currThreshold = floor(new_count  / BAN_INTERVAL)
            │  只有「跨過新的整數倍」才真的觸發 ban（避免每次違規都重複 ban/清 session）
            ▼
        deleteAllUserSessions(userId) + 清 5 種 cookie
        banLogs.set(userId,  {...}, ttl=BAN_DURATION)
        banLogs.set(req.ip,  {...}, ttl=BAN_DURATION)   ← IP 和 user 都記

之後每個請求
        │
        ▼
checkBan(req,res,next)
    ├─ 先查 in-memory/Redis `banCache`（快、TTL=ban 剩餘時間，命中直接擋，省一次 DB 查詢）
    └─ 沒命中才查 banLogs（Mongo-backed），命中則回填 banCache 供下次快速比對
```

`checkBan` 掛在 `/login`、`/register`、`/requestPasswordReset`、`/resetPassword`、`/2fa/verify-temp`,以及 OAuth 的 `createOAuthHandler` 內部(`oauth.js:34`,在設 cookie 之前才檢查,避免被封的使用者透過 social login 繞過)。**沒有掛在一般聊天 API 上**——那些走的是各自的 message/tool rate limiter,ban 命中時才會呼叫 `denyRequest`(SSE 格式的錯誤,而不是普通 403 JSON),因為聊天 API 的回應是串流格式。

### 流程 E:內容 Moderation 與 PII 過濾(訊息送進 LLM 前的兩道獨立閘)

```
使用者送出訊息
      │
      ▼ (若 OPENAI_MODERATION=true)
moderateText ── 收集 {typed text, quotes, merged quote+text, HITL resume 的 answer/decisions[]}
      │           → 全部丟給 OpenAI /v1/moderations
      │           → 任何一個 input flagged → denyRequest（存一則「使用者訊息」占位 + SSE 錯誤事件）
      ▼
messageFilterPii(如果租戶設定了 pii 規則) ── 同樣收集一份候選字串
      │           → 正規表示式比對（sk- 前綴、Bearer token、api-key header、自訂規則）
      │           → 命中 → 400 擋下，訊息完全不進入 LLM/工具，也不落地存檔
      ▼
才進入 agent 執行迴圈
```

兩者刻意分開:moderation 是「內容安全」(仇恨/暴力/自傷等),外呼第三方 API,會增加延遲與成本,且**只審查文字**;PII 過濾是「資料外洩防護」(公司內部 API key 誤貼進聊天視窗),純本地正規表示式、零延遲、可精準攔截「使用者的密鑰」而不是「使用者輸入了什麼樣的話」。兩者都覆蓋同一組輸入來源(typed text、quotes、HITL resume 的 `answer`/`decisions[]`),這是為了堵住「透過工具核可流程的 free-text 欄位夾帶」這條繞過路徑——這是後來才補上的細節,值得在移植時一開始就設計進去,而不是事後才發現漏了一個輸入面。

---

## 關鍵資料結構

### User(認證相關欄位,`packages/data-schemas/src/schema/user.ts:26`)

| 欄位 | 型別 | 用途 |
|---|---|---|
| `email` | string, unique index | 登入識別碼,小寫正規化 |
| `password` | string, `select:false`, 8–128 長度 | bcrypt hash;`select:false` 代表**查詢預設不回傳**,任何要比對密碼的地方都要顯式 `'+password'` |
| `provider` | string,預設 `'local'` | `local`/`google`/`facebook`/`github`/`discord`/`apple`/`openid`/`saml`/`ldap`。一個 email 只能綁一種 provider——見下方「陷阱」 |
| `googleId`/`facebookId`/`githubId`/`discordId`/`appleId`/`openidId`/`openidIssuer`/`samlId`/`ldapId` | string | 各 provider 的外部使用者 ID,查使用者的第一優先鍵 |
| `emailVerified` | boolean | local 註冊預設 false(等信箱驗證);所有 social/OIDC/SAML/LDAP 登入預設視為已驗證(信任 IdP) |
| `role` | string,預設 `USER` | `USER`/`ADMIN`;**系統第一個註冊的使用者自動變 ADMIN**(`countUsers()===0`) |
| `twoFactorEnabled` | boolean | 是否已完成 2FA 綁定確認(`confirm2FA` 後才會是 true) |
| `totpSecret` | string, `select:false` | 加密後(`v3:` 前綴,AES-GCM)的 TOTP secret,Base32 明碼絕不落地 |
| `backupCodes` | `[{codeHash, used, usedAt}]`, `select:false` | 10 組一次性備援碼,只存 SHA-256 hash,用過標記 `used` |
| `pendingTotpSecret` / `pendingBackupCodes` | 同上, `select:false` | **兩階段確認**用的暫存欄位:`enable2FA` 先寫 pending,`confirm2FA` 驗證通過才轉正,中途放棄不影響既有 2FA 設定 |
| `refreshToken` | `[{refreshToken}]` | 舊版遺留的內嵌陣列(現行流程改用獨立 `Session` collection,這個欄位主要是相容/清理用) |
| `expiresAt` | Date,TTL index 604800s | 未驗證信箱帳號的自動過期清理(7 天) |

### Session(獨立 collection,`packages/data-schemas/src/schema/session.ts`)

| 欄位 | 型別 | 用途 |
|---|---|---|
| `refreshTokenHash` | string, required | refresh token JWT 的 hash(不存明文),`findSession`/`deleteSession` 都是先 hash 再查 |
| `expiration` | Date, TTL index `expires:0` | Mongo TTL 索引,到期自動刪除文件 |
| `user` | ObjectId ref User | 反查「這個使用者有哪些活躍 session」(`countActiveSessions`、`deleteAllUserSessions`) |
| `tenantId` | string, indexed | 多租戶隔離 |

### Token(email 驗證 / 密碼重設 / 邀請,共用一張表,`~/models` 的 `createToken`/`findToken`)

| 欄位 | 用途 |
|---|---|
| `userId` | 目標使用者(邀請的情境下是一個佔位 ObjectId,不對應真實使用者) |
| `email` | 目標信箱,與 `userId` 一起做二次比對 |
| `type` | `email_verification` \| `password_reset` \| null(邀請沒有 type,靠有沒有 `email`/`identifier` 區分舊資料) |
| `token` | bcrypt hash(email 驗證/密碼重設)或 SHA-256 hash(邀請,`hashToken`) |
| `expiresIn` | 秒數,15 分鐘(驗證信/重設信)或 7 天(邀請) |

### Violation / Ban 快取(Keyv,namespace 依 `ViolationTypes`)

| Store | Key | Value | TTL |
|---|---|---|---|
| `violations:<type>`(如 `LOGINS`、`MESSAGE_LIMIT`) | userId(或 Redis 下 `type:userId`) | 累計違規次數(number) | 無(持續累計,除非改用有 TTL 的變體) |
| `violations:GENERAL` | userId | `errorMessage[]`(稽核軌跡) | 無 |
| `BANS`(Mongo-backed,不管有沒有 Redis 都落 Mongo) | userId 及 req.ip(各一筆) | `{type, violation_count, duration, expiresAt}` | `BAN_DURATION`(預設 7,200,000ms = 2 小時) |
| `banCache`(Keyv,namespace=`ban`,ttl=0 表不設全域 TTL,靠 per-key TTL) | 同上,Redis 模式下加 `ban_cache:ip:`/`ban_cache:user:` 前綴 | 同 BANS 內容 | 剩餘 ban 時間(動態算) |

### Rate Limiter 一覽(`api/server/middleware/limiters/`)

| Limiter | 預設視窗/上限 | Key | 用途 |
|---|---|---|---|
| `loginLimiter` | 5 分鐘 / 7 次 | IP(去掉 port) | 防登入暴力破解 |
| `registerLimiter` | 60 分鐘 / 5 次 | IP | 防批量灌帳號 |
| `resetPasswordLimiter` / `Submission` | env 可調 | IP | 防密碼重設濫用(request 與實際提交分開限流) |
| `verifyEmailLimiter` / `Submission` | env 可調 | IP | 同上,信箱驗證 |
| `twoFactorTempLimiter` | 同 login 預設 | IP **和** user(temp token 內解出的 userId,或其 hash 當 key) | 雙層限流,防 2FA 代碼暴力破解 |
| `messageIpLimiter` / `messageUserLimiter` | 1 分鐘 / 40 次(各自獨立) | IP / userId | 聊天訊息送出頻率 |
| `toolCallLimiter` | 1 秒 / 1 次 | userId | 防 agent loop 失控狂打工具(見 04-execution-engine.md) |
| `uploadLimiters`、`importLimiters`、`forkLimiters`、`promptUsageLimiter`、`ttsLimiters`、`sttLimiters` | 各自 | 各自 | 對應功能的濫用防護,實作模式與上面一致 |

所有 limiter 共用同一個模式:`express-rate-limit` + `store: limiterCache(prefix)`(有 Redis 才回傳 `RedisStore`,否則回傳 `undefined` 讓 `express-rate-limit` 退化用**進程內記憶體**)、`handler` 一律呼叫 `logViolation` 再回 429。

---

## 關鍵實作細節與陷阱

1. **`checkBan` 沒有 Redis 時,IP+userId 的節流計數都是進程內記憶體。** 多副本(replica)部署時,每個副本各算各的,實際可通過的總請求量會是「單副本上限 × 副本數」。`USE_REDIS=true` 才會換成跨副本一致的 `RedisStore`(見 `packages/api/src/cache/cacheFactory.ts:141`)。**這是一個容易被忽略的擴展性/安全性坑**:團隊常常先上生產環境擴副本,才發現 rate limit 形同虛設。

2. **一個 email 只能綁一種 provider,撞了會直接拒絕登入而不是自動合併帳號。** 所有 social/OIDC/SAML/LDAP strategy 在 `findUser({email})` 找到既有使用者但 `existingUser.provider !== provider` 時,一律回 `ErrorTypes.AUTH_FAILED`(見 `socialLogin.js:61`、`samlStrategy.js:210`、`ldapStrategy.js:132`)。這是刻意的安全設計(防止「用假的 Google 帳號冒充別人已註冊的 email」),但對使用者體驗不友善——同一個人用 Google 註冊、後來想加 GitHub 登入,系統不會幫你合併,只會告訴你「這個信箱已經用 Google 註冊了」。移植時要在產品層面想清楚要不要做帳號合併流程。

3. **domain allowlist 檢查永遠做兩次**,而且兩次用不同的 config 來源:第一次用「純記憶體、零 DB 查詢」的 base config(在 `findUser` 之前,快速擋掉全域黑名單網域,不洩漏任何使用者是否存在的訊息);第二次在找到使用者、解析出租戶專屬 `appConfig` 之後,用租戶覆寫過的 `allowedDomains` 再查一次。`AuthService.js:429` 的註解把這個 two-phase 設計的動機寫得很清楚:**第一階段回錯誤訊息是可以接受的洩漏(只洩漏「這個網域被全域封鎖」,不洩漏帳號是否存在)**,**第二階段一律回通用成功訊息**(防止用「密碼重設回應的狀態碼/內容差異」來列舉哪些信箱已經註冊,即經典的 user enumeration 防護)。

4. **`registerUser` 對「email 已存在」的回應刻意 sleep 1 秒再回 200 + 通用訊息**(`AuthService.js:366`),跟真正註冊成功的回應路徑幾乎無法區分——同樣是防 enumeration,但用「加延遲讓時序攻擊也失效」補了一刀。

5. **2FA 的 TOTP 是手寫實作,沒有依賴 `otplib`/`speakeasy` 這類套件**(`twoFactorService.js`):Base32 encode/decode、HMAC-SHA1 動態截斷(RFC 4226)全部自己刻。優點是零依賴、審計面小;風險是**這段程式碼沒有經過第三方安全套件的長期實戰考驗**,任何 edge case(如系統時鐘飄移超過 ±30 秒視窗、Base32 padding 處理)都要自己踩坑。`verifyTOTP` 允許前後各一個時間步(共 90 秒視窗)容忍時鐘誤差,這是業界標準做法但也代表理論上有 90 秒的重放窗口(沒有做「同一個 code 用過就標記失效」的 nonce 追蹤,跟大多數 TOTP 實作一樣)。

6. **backup code 只存 SHA-256 hash(無 salt),TOTP secret 是可逆加密(`encryptV3`/AES-GCM)而非 hash。** 這是必要的不對稱:backup code 是一次性密碼,只需要「驗證比對」,hash 就夠(而且沒有 salt 是因為每個 code 本身就有 32 bits 隨機熵,彩虹表攻擊成本已經很高);TOTP secret 必須**可還原**才能持續產生驗證碼,所以是加密而非 hash——資料庫外洩時,backup code 安全(即使沒 salt),但 TOTP secret 的安全性完全依賴加密金鑰(`CREDS_KEY`/`CREDS_IV`)沒有跟資料庫一起外洩。**移植時務必把加密金鑰放在跟 DB 分離的 secret store。**

7. **`checkVariables()`(`packages/api/src/app/checks.ts:108`)會在啟動時比對 `JWT_SECRET`/`JWT_REFRESH_SECRET`/`CREDS_KEY`/`CREDS_IV` 是否還是 repo 內建的預設值**,是就 warn。這個檢查**只 log,不會拒絕啟動**——生產環境忘記換掉預設密鑰是完全可能發生的(而且後果是所有使用者的 JWT 可以被偽造、所有加密欄位可以被解密)。移植時建議把這類檢查升級成**啟動時直接 fail-fast**,而不只是 log warning。

8. **`setAuthTokens` 的 cookie 全部是 `httpOnly + sameSite=strict`,`secure` 則視 `shouldUseSecureCookie()` 動態判斷**(生產環境預設 true,但 `DOMAIN_SERVER` 是 localhost 樣式主機名稱時允許 false,方便本機用 `NODE_ENV=production` 跑 docker-compose 除錯,`packages/api/src/oauth/csrf.ts:19`)。access token **完全不進 cookie**,只在登入回應 body 裡給前端一次——這代表前端要自己決定存哪裡(記憶體 or localStorage),LibreChat 選擇讓前端持有它,配合短 TTL 降低 XSS 竊取後的影響視窗。

9. **OpenID 的 token 儲存位置分裂成三種**,是這個系統最複雜的一塊:主要放 `express-session`(伺服器端,Redis-backed);沒有 session 時 fallback 到多個獨立 cookie(`openid_access_token`/`openid_id_token`);`OPENID_REUSE_TOKENS` 開啟時還多一個簽過名的 `openid_user_id` cookie 給 `requireJwtAuth` 用來比對「這個 access token 到底是不是屬於 cookie 宣稱的那個使用者」。三層 fallback 是為了相容不同部署場景(有沒有 sticky session、Redis 有沒有開),但也代表**這是最容易在移植時過度複製的複雜度**——見下方設計決策分析。

10. **`moderateText`/`messageFilterPii` 兩個 middleware 都要記得覆蓋「HITL resume」的輸入面**(`POST /agents/chat/resume` 的 `answer`/`decisions[].responseText`/`decisions[].reason`/`decisions[].editedArguments`),不是只看 `req.body.text`。這是容易漏掉的地方:第一版通常只擋「使用者打字輸入」,後來才發現「工具核可流程裡使用者填的自由格文字」是另一條可以夾帶惡意內容/機密資訊繞過去的路。

11. **`banResponse` 依「有沒有 browser user-agent」和「是不是 agent chat 路由」分岔**(`checkBan.js:31`):沒有瀏覽器 UA(疑似腳本/爬蟲)一律回 JSON 403;是 `/api/agents/chat` 底下的請求則走 `denyRequest`(SSE 格式,因為前端期待串流回應格式,直接回 403 JSON 前端會解析失敗)。這種「依路由格式決定錯誤回應格式」的分岔邏輯,在你自己的 Hono 架構下(不管底層是 LangGraph/LangChain/deepagents 的串流事件,還是 Vercel AI SDK 的 `streamText`)要重新設計成更泛用的判斷(例如看 `Accept` header 或路由 metadata,而不是硬編字串比對路徑)。

---

## 設計決策分析

**為什麼 access token 用無狀態 JWT,refresh token 卻要落 DB?** 這是一個典型的「效能 vs. 可撤銷性」取捨:access token 高頻使用(每個 API 請求都要驗),做成無狀態 JWT 可以完全不查資料庫,驗簽即可,是效能考量的自然選擇;但無狀態的代價是「發出去就收不回來」——如果只靠 JWT 過期時間控制,被盜的 token 在 TTL 內完全無法撤銷。refresh token 低頻使用(用戶端每 15 分鐘左右才用一次去換新 access token),查一次 DB 的成本可以接受,換來的是「登出」「被 ban」「密碼重設」都能立即讓所有裝置的 session 失效。**這個 access/refresh 分工模式是業界標準,值得原樣移植**;真正該重新設計的是「OpenID 的三層 token 儲存」——那是為了遷就 cookie 大小限制和沒有 Redis 的部署情境長出來的歷史包袱,新專案一開始就假設有 Redis,可以直接把所有 federated token 放 Redis-backed session,不必再維護 cookie fallback。

**為什麼 ban 系統同時記 userId 和 IP,而不是只記其中一個?** 只記 userId 擋不住「同一個攻擊者換帳號繼續打同一支登入 API」;只記 IP 在雲端/NAT 環境會誤傷同 IP 下的其他合法使用者,也擋不住「攻擊者本來就有大量 IP(botnet/代理池)」。雙軌記錄是務實的折衷,但**兩者用同一個 `BAN_DURATION`、同一套觸發邏輯**,沒有做「IP 封鎖比 user 封鎖更容易誤傷,應該用更短 TTL 或更高門檻」這種差異化。若重做,會把 IP 維度的 ban 拆成獨立的、更保守的策略(例如只在短時間內來自同一 IP 的違規爆量時才觸發,且 TTL 更短),避免共享辦公網路/NAT 出口被連坐。

**為什麼 domain allowlist 要檢查兩次而不是一次?** 根本原因是 LibreChat 支援「租戶專屬設定覆寫全域設定」(多租戶 SaaS 模式),而租戶資訊只有在找到使用者(或至少知道使用者屬於哪個租戶)之後才能解析。單次檢查要嘛只能用全域設定(租戶覆寫形同虛設),要嘛必須先查一次 DB 才能開始檢查(等於放棄了「快速擋掉黑名單網域、不查 DB」這個防 DoS/防 enumeration 的優化)。兩階段檢查是在「單租戶就夠用」和「必須支援租戶覆寫」之間找到的平衡點——**如果你的新專案一開始就是多租戶架構,這個模式值得保留;如果是單租戶,一次檢查就夠,不必照抄兩階段設計**。

**為什麼 2FA TOTP 要手寫而不用套件?** 從程式碼風格看,這是刻意選擇(避免額外相依、便於审计/理解每一行邏輯)。這個決策的性價比在「團隊有能力正確實作並持續維護密碼學細節」的前提下才成立;多數團隊(包含你要重做的新專案)應該**直接用經過審計的成熟套件**(Node 生態如 `otpauth`、`speakeasy`,或如果用 Web Crypto API 也可以參考 LibreChat 這份實作當範本——它確實遵循 RFC 4226/6238,邏輯正確,只是「重造輪子」的維護成本要自行承擔)。

**為什麼 rate limiter 允許在沒有 Redis 時退化成進程內記憶體,而不是直接要求 Redis?** 這是為了降低本地開發/單機小型部署的門檻(docker-compose 一鍵起,不強制依賴 Redis)。代價是文件前面提到的「多副本時形同虛設」陷阱。**如果重做,建議把「有沒有 Redis」做成啟動時的顯式檢查**:單副本部署明確標示「rate limit 僅本機有效」,多副本部署直接要求 Redis 存在(fail-fast),而不是安靜地退化。

---

## 移植到新技術棧的建議

### 資料模型(PostgreSQL)

```sql
-- 使用者核心欄位延伸(假設你已有 users 表);2FA/認證相關獨立成小表更利於權限最小化查詢
CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid,
  email             citext NOT NULL,
  email_verified    boolean NOT NULL DEFAULT false,
  password_hash     text,                      -- NULL 代表純 OAuth/OIDC 帳號，local 登入時檢查
  provider          text NOT NULL DEFAULT 'local',
  provider_id       text,                      -- 對應 googleId/openidId/samlId/ldapId...，一表存多 provider 用複合唯一鍵
  role              text NOT NULL DEFAULT 'user',
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email),
  UNIQUE (provider, provider_id)                -- 撞號即代表帳號已綁其他 provider，回拒絕而非合併（見陷阱 2）
);

CREATE TABLE user_two_factor (
  user_id             uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled             boolean NOT NULL DEFAULT false,
  totp_secret_enc     bytea,                    -- pgcrypto/應用層 AES-GCM 加密，絕不明碼
  pending_secret_enc  bytea,                    -- 兩階段確認用暫存
  backup_codes        jsonb NOT NULL DEFAULT '[]', -- [{hash, used, used_at}]，SHA-256 hash 即可
  pending_backup_codes jsonb
);

CREATE TABLE sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id           uuid,
  refresh_token_hash  text NOT NULL,
  expires_at          timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON sessions (user_id);
-- 過期清理：pg_cron 定期 DELETE FROM sessions WHERE expires_at < now()，或用 Redis 存並靠 TTL 自動過期（見下方）

CREATE TABLE auth_tokens (          -- 對應 LibreChat 的 Token（email 驗證 / 密碼重設 / 邀請）
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  email       citext,
  type        text NOT NULL,        -- 'email_verification' | 'password_reset' | 'invite'
  token_hash  text NOT NULL,
  expires_at  timestamptz NOT NULL
);

CREATE TABLE user_bans (
  scope       text NOT NULL,        -- 'user' | 'ip'
  identifier  text NOT NULL,        -- userId 或 IP
  reason      jsonb NOT NULL,
  expires_at  timestamptz NOT NULL,
  PRIMARY KEY (scope, identifier)
);
```

要點:
- **不要把 rate-limit 計數器放 PostgreSQL。** LibreChat 把 violation 計數放 Keyv(Redis 或 Mongo);高頻寫入 + 短 TTL 的資料完全交給 Redis(見下方),PostgreSQL 只存「已經觸發 ban 的判決結果」這種低頻、需要持久稽核的資料。
- `provider_id` 用複合唯一鍵而不是每個 provider 一個欄位(LibreChat 是 `googleId`/`githubId`/... 各開一欄,關聯式資料庫裡用一張 `user_identities(user_id, provider, provider_id)` 子表更乾淨,也更容易做「允許一個使用者綁多個 provider」的產品決策)。

### Hono route / middleware 對應

| LibreChat | Hono 對應 |
|---|---|
| `requireJwtAuth`(passport-jwt) | 自寫 middleware:`jwtVerify(c.req.header('authorization'))` → 查 Redis/PG 拿使用者 → `c.set('user', user)`。不需要 Passport 這層抽象,直接用 `jose` 驗簽即可。 |
| `requireLocalAuth` | 一個 `POST /login` handler 內直接做 bcrypt 比對,不必假裝是「策略」 |
| `checkBan` | `app.use('/api/*', banCheckMiddleware)`,查 Redis 兩層(hot cache + 判決記錄),邏輯照抄即可,是本文件最值得原樣移植的部分 |
| `loginLimiter`/`registerLimiter`/... | Hono 生態的 `hono-rate-limiter` + Redis store,或自寫 fixed-window/sliding-window counter(`INCR` + `EXPIRE`) |
| `moderateText` | 一個 `beforeGenerate` hook,呼叫 moderation API(OpenAI 或其他),flag 則回 400 |
| `messageFilterPii` | 純函式,不依賴 request/response,直接在 Hono handler 裡呼叫,回傳 match 就 `c.json({...}, 400)` |
| `setTwoFactorTempUser` + `/2fa/verify-temp` | 兩個獨立 handler:`POST /login` 判斷 `twoFactorEnabled` 後回 temp JWT;`POST /2fa/verify` 驗證後才發正式 token |
| `checkDomainAllowed` | OAuth callback route 裡的一段邏輯,不需要獨立 middleware(除非你也要多租戶覆寫) |

### AI 框架的對應能力(框架尚未定案,見 19-framework-options.md)

認證/安全這層**與底層選哪個 AI agent 框架幾乎無關**——不管是 LangGraph/LangChain/deepagents 的 graph 執行,還是 Vercel AI SDK 的 `streamText`/`generateText`/tool calling,框架管的都是「LLM 怎麼推理、怎麼呼叫工具」,不管「誰能呼叫這些 API」。但有兩個交集點值得注意:

- **Moderation/PII 過濾必須在啟動 agent 執行迴圈之前執行**,擋下的請求根本不該進入 graph 或建立 stream。可以做成一個 Hono middleware,或 agent 呼叫前的 guard function,四個候選框架都適用同一個模式。
- 如果你要做「工具呼叫核可」(HITL,見 LibreChat 的 tool-approval resume),四個框架的整合難易度差異不小(完整能力對照見 19-framework-options.md 的 HITL interrupt/resume 一列,以下只點出跟本文件相關的結論):
  - **LangGraph**:原生 `interrupt()` + `Command({resume})` + checkpointer,可跨 process/replica resume,四者中最完整。
  - **LangChain**:`humanInTheLoopMiddleware` 開箱即用,底層同 LangGraph。
  - **deepagents**:`interruptOn` 參數開箱即用,底層同樣是 LangGraph interrupt。
  - **Vercel AI SDK**:v7 起有 tool approvals(policy 級)與 WorkflowAgent 的 durable resume;若不用這兩者,得靠「無-execute tool + PG 存 messages」自建,整合方式會比 LibreChat 自己手寫的 resume 端點更手工、較少框架代勞的部分。
  - 不管選哪個框架,都**別忘了陷阱 10**:核可流程裡任何 free-text 欄位(拒絕原因、修改後的參數)都要重新過一次 moderation/PII 過濾,沒有框架會替你做這件事。

### Redis 的用途

這是本文件覆蓋範圍裡 Redis 承擔最多責任的地方:

| 用途 | 對應 LibreChat 元件 | 建議做法 |
|---|---|---|
| Rate limit 計數器 | `limiterCache` + `express-rate-limit` 的 `RedisStore` | `INCR key; EXPIRE key window` 或用 `hono-rate-limiter` 的 Redis adapter,**啟動時強制檢查 Redis 可達,不要靜默退化成記憶體**(對應「設計決策分析」最後一點) |
| Violation 計數 / ban 判決 | `violations:*` Keyv namespace、`BANS` | Redis Hash 或簡單 key-value,`user_bans` 表只存「已生效的 ban」這種低頻資料,熱路徑查詢全部走 Redis |
| Session/refresh token 撤銷檢查 | Mongo `Session` collection | 可以完全搬進 Redis(`SET session:<id> ... EX <ttl>`),用 TTL 自動過期取代 Mongo 的 TTL index,查詢延遲更低;但要接受「Redis 資料遺失 = 所有人被登出」這個可用性取捨,通常搭配 AOF/RDB 持久化即可 |
| OIDC/SAML federated token(express-session） | `connect-redis` | 直接對應,`hono-sessions` 或自寫 cookie+Redis session store |
| 2FA temp token | 目前用 JWT(無狀態),不需要 Redis | 維持無狀態即可,5 分鐘 TTL 靠 JWT `exp` 自然過期,不必額外存 Redis |

### Next.js 前端考量

- **Access token 存哪裡是你要做的第一個決定。** LibreChat 把它放 JS 記憶體(Zustand/Context,重新整理頁面就靠 refresh token cookie 換新的),这可以直接搬。若走 Next.js App Router + Server Components,也可以考慮把 access token 存進伺服器端 `httpOnly` cookie、由 Route Handler 幫前端組裝 `Authorization` header 呼叫後端 API,进一步降低 XSS 竊取風險——這比 LibreChat 的 SPA 模式更安全,值得作為新專案的改進點。
- **2FA 設定頁**要處理 QR code(`otpauth://` URL 前端用 `qrcode.react` 之類套件渲染)、backup code 一次性顯示(顯示後永不再顯示明碼,只能重新產生)、以及重新綁定時要求先驗證舊 TOTP/backup code(對應 `enable2FA` 的「已啟用時要求驗證才能再次產生新密鑰」邏輯,防止已登入的 session 被盜用時攻擊者直接改掉 2FA)。
- **登入表單要處理三種回應形態**:純成功(拿到 token)、2FA pending(轉跳驗證碼輸入畫面,帶著 tempToken)、domain not allowed / provider mismatch 等業務錯誤(對應後端刻意模糊化的通用訊息,前端不該試圖從錯誤訊息反推更多資訊)。
- **Rate limit 429 的 UX**:LibreChat 後端回傳的訊息裡帶精確的剩餘等待分鐘數(`windowInMinutes`),前端可以直接顯示倒數,而不是只顯示「請稍後再試」。

### 一句話總結

這裡真正值得移植的是三個經過深思熟慮的安全模式——**access/refresh token 分離(無狀態高頻 vs. 有狀態低頻可撤銷)**、**violation 計數與 ban 的兩層快取(熱路徑不查判決來源)**、**domain allowlist 的兩階段檢查(防 enumeration 同時支援租戶覆寫)**;不值得照搬的是因為「同時要相容有無 Redis、cookie 大小限制、多種舊版遷移路徑」而長出來的歷史複雜度(OpenID 三層 token 儲存、rate limiter 的記憶體 fallback)。新專案從一開始就假設「一定有 Redis、一定是新資料模型」,可以把這些複雜度直接砍掉,只留下設計動機本身。
