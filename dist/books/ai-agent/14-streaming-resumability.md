# 14. 串流與可恢復性

## 定位

這個子系統回答一個核心問題:**「LLM 生成是一個長時間的伺服器端程序,HTTP 連線卻隨時會斷,兩者如何解耦?」**

LibreChat 舊版做法(legacy path)是把生成綁在一條 HTTP 回應上直接串流 SSE——連線斷了生成就死了。現行架構(`ResumableAgentController`,`api/server/controllers/agents/request.js:189`)把兩者徹底拆開:

- **POST `/api/agents/chat/:endpoint`** 只負責「啟動生成任務」,立刻回 `{ streamId, conversationId, status: 'started' }` JSON 就結束(`request.js:252`),生成在背景的 detached async task 中繼續跑。
- **GET `/api/agents/chat/stream/:streamId`** 是另一條獨立的 SSE 連線,客戶端隨時可以訂閱、斷開、重連(帶 `?resume=true`),伺服器會補發(replay)漏掉的內容。

在整體架構中,它位於「執行引擎(見 04-execution-engine.md)」與前端之間,承擔四件事:

1. **SSE 串流**:把 LangGraph run 的事件(token delta、run step、attachment、usage)推給客戶端。
2. **可恢復性(resumability)**:斷線重連、頁面重整、甚至換到另一台 replica,都能拿回進行中的串流狀態。
3. **中止(abort)並保存部分回應**:使用者按 Stop 後,已生成的內容與 token 花費不會遺失。
4. **HITL(human-in-the-loop)**:工具核准 / 詢問使用者時,run 暫停、狀態落盤(durable checkpoint),使用者做出決定後在**任意 worker** 上重建 graph 繼續執行。

## 核心概念

| 名詞 | 意義 |
|---|---|
| **GenerationJob** | 一次生成任務的抽象。`streamId === conversationId`(刻意設計,一個對話同時只有一個 job),含狀態機 `running / complete / error / aborted / requires_action`(`packages/api/src/stream/interfaces/IJobStore.ts:11`)。 |
| **GenerationJobManager** | 全域單例(`packages/api/src/stream/GenerationJobManager.ts:1910`),組合兩個可抽換的服務:`IJobStore`(job 中繼資料+內容狀態)與 `IEventTransport`(pub/sub 事件),各有 InMemory 與 Redis 兩種實作。 |
| **Runtime state** | 不可序列化的 per-process 狀態(`AbortController`、earlyEventBuffer、finalEvent 快取),永遠在記憶體(`GenerationJobManager.ts:149`)。跨 replica 場景由 `getOrCreateRuntimeState` 惰性重建(`GenerationJobManager.ts:534`)。 |
| **Content aggregation** | `createContentAggregator()`(來自 `@librechat/agents`,在 `api/server/services/Endpoints/agents/initialize.js:138` 建立)把事件流(`on_message_delta`、`on_run_step` …)折疊成結構化的 `contentParts` 陣列——這就是「斷線後能拿回完整內容」的基礎。 |
| **ResumeState** | 重連時伺服器送出的 `sync` 事件負載:`runSteps + aggregatedContent + userMessage + titleEvent + collectedUsage + contextUsage + pendingAction`(`IJobStore.ts:250`、`GenerationJobManager.ts:1523`)。 |
| **PendingAction** | run 因 HITL interrupt 暫停時持久化的「待審記錄」:actionId、payload(tool_approval / ask_user_question)、expiresAt、requestFingerprint、resumeContext(`packages/api/src/agents/hitl/policy.ts:302`)。 |
| **ApprovalLifecycle** | `requires_action` 狀態的合法轉移守門員,底層是 job store 的原子 CAS `transitionStatus`:`pause`(running→requires_action)、`resolve`(→running,單一贏家)、`expire`(→aborted)(`packages/api/src/stream/ApprovalLifecycle.ts`)。 |
| **Durable checkpoint** | LangGraph 的 graph 狀態快照,HITL 開啟時用 `MongoDBSaver` 落盤(`packages/api/src/agents/checkpointer.ts`),`thread_id = conversationId`。resume 時在全新的 run 上 rehydrate。 |
| **Job replacement** | 因為 job key 是 conversationId,同一對話的新請求會**覆蓋**舊 job(createdAt 改變)。所有終結性副作用(emitDone、completeJob、checkpoint prune、pause)前都要比對 `createdAt` 確認自己還是「活的那個 job」。這是全系統反覆出現的 guard。 |

心智模型:**job 是狀態機 + 事件匯流排;SSE 連線只是隨插隨拔的觀察者;HITL 暫停就是「把 graph 冷凍進資料庫、把程序完全釋放,之後在任何機器解凍」**。

## 架構與流程

### 元件關係

```
POST /chat/:endpoint ──► ResumableAgentController(request.js)
  │  立即回 {streamId}                │
  │                                  ▼ 背景 task
  │                        AgentClient.sendMessage
  │                          └─ chatCompletion → createRun → run.processStream
  │                               │ 事件經 getDefaultHandlers(callbacks.js)
  │                               ├─ aggregateContent(折疊成 contentParts)
  │                               └─ emitEvent → GenerationJobManager.emitChunk
  │                                                │
  │                        ┌───────────────────────┴──────────────────────┐
  │                        ▼                                              ▼
  │                   IJobStore                                   IEventTransport
  │            (InMemory: WeakRef graph /                  (InMemory: EventEmitter /
  │             Redis: XADD chunk log + HSET job)           Redis: PUB/SUB + seq 重排)
  │                        ▲                                              │
  ▼                        │                                              ▼
GET /chat/stream/:streamId?resume=true ──► subscribeWithResume ──► SSE 客戶端
GET /chat/active、/chat/status/:id ────► job 查詢
POST /chat/abort ─────────────────────► abortJob + 保存部分回應
POST /chat/resume ────────────────────► ResumeController → resumeCompletion(第二次 createRun)
                                              ▲
                              MongoDB durable checkpoint(checkpointer.ts)
```

### 流程一:正常串流

1. `ResumableAgentController` 先做並發限流(`checkAndIncrementPendingRequest`)、生成 `conversationId = streamId`(新對話用 `crypto.randomUUID()`,`request.js:230`)。
2. `GenerationJobManager.createJob()`(`GenerationJobManager.ts:322`)建立 job store 記錄 + runtime state,`readyPromise` **立即 resolve**——生成不等客戶端連上,早期事件由 `earlyEventBuffer` 緩衝。
3. `res.json({ streamId, ... })` 立刻送出(`request.js:252`)——關鍵:MCP OAuth 等工具載入期間的事件必須有地方送,所以客戶端要盡快連 SSE。
4. 寫入 preliminary metadata(userMessage、responseMessageId、agent_id、isTemporary、files;`request.js:260`)——這是**awaited** 的寫入,確保 HITL 快速核准時 job 上已有這些資料。
5. `initializeClient()` 建 `AgentClient`,`client.jobCreatedAt = jobCreatedAt` 綁定世代識別(`request.js:370`)。
6. `client.sendMessage` → `chatCompletion` → `createRun`(`client.js:1558`)→ `run.processStream`。每個 graph 事件經 `getDefaultHandlers`(`callbacks.js:293`):**先** `aggregateContent({event, data})` 折疊進 contentParts,**再** `emitEvent(res, streamId, ...)` → `GenerationJobManager.emitChunk`。
7. `emitChunk`(`GenerationJobManager.ts:1105`)做五件追蹤(userMessage / title / replay / contextUsage / tokenUsage 皆持久化到 job store,供 resume 用),Redis 模式再 `appendChunk`(XADD 進 chunk log)+ run step 快照,最後 publish 給訂閱者。
8. 完成時:先 `saveMessage`(**先存 DB 再發 final event**,避免客戶端 refetch 比 DB 寫入快的 race,`request.js:697`),job-replacement 檢查後 `emitDone` + `completeJob`。

### 流程二:斷線重連 replay(GET /chat/stream/:streamId)

```
Client                         Route(index.js:66)                GenerationJobManager
  │ GET ?resume=true               │                                   │
  │───────────────────────────────►│ getJob → 404/403 檢查              │
  │                                │ flushHeaders(SSE headers)          │
  │                                │ subscribeWithResume ──────────────►│ ① 快照 earlyEventBuffer 長度
  │                                │                                   │ ② getResumeState(聚合內容+runSteps)
  │                                │                                   │ ③ 抽出快照後新進的 gap events
  │                                │                                   │ ④ subscribe(skipBufferReplay)
  │                                │                                   │ ⑤ 訂閱後重讀 job:若已 requires_action
  │                                │                                   │    且快照沒帶 pendingAction → 補進 pendingEvents
  │ ◄─ event: message {sync:true, resumeState, pendingEvents}          │
  │ ◄─ 之後的 live chunks…          │ markSyncSent                       │
```

- 前端(`client/src/hooks/SSE/useResumableSSE.ts:574`)重連時加 `?resume=true`;收到 `sync` 事件後用 `resumeState.aggregatedContent` 整體重建訊息,再接續 live 串流。
- `subscribeWithResume`(`GenerationJobManager.ts:1031`)是**原子化**的「快照+訂閱」:分開呼叫 `getResumeState()` 與 `subscribe()` 會有時間窗漏事件,所以在同一步驟內完成,窗內事件以 `pendingEvents` 回傳。
- 所有訂閱者離開時,`onAllSubscribersLeft` 回呼把 `syncSent` 重設為 false(下次重連會再送 sync),並觸發「保存部分回應」handler(`request.js:291`)——**即使沒有任何客戶端在看,生成照跑,而且中途成果會定期落盤**。
- 首次進入對話 / 重整頁面的入口是 **GET `/chat/active`**(回傳使用者所有 running job 的 conversationId,`index.js:173`)與 **GET `/chat/status/:conversationId`**(`index.js:187`,回傳 `active/status/aggregatedContent/resumeState/pendingAction`)。`requires_action` 且 pendingAction 未過期視同 active,客戶端據此重新訂閱並渲染核准 UI。

### 流程三:abort 並保存部分回應

POST `/chat/abort`(`index.js:236`)→ `GenerationJobManager.abortJob()`(`GenerationJobManager.ts:742`):

1. Redis 模式先 `emitAbort`(pub/sub 廣播)讓**正在生成的那台 replica** 的 AbortController 被觸發;本機有 runtime 也直接 abort。
2. 讀出目前 `contentParts` → `filterPersistableAbortContent` 過濾出可保存內容;偵測 early abort(還沒任何內容、created 事件未發:前端不應導航進對話)。
3. 組出 `aborted: true` 的 final event,`emitDone` 給還掛著的 SSE 客戶端,刪 job。
4. 回到 route 層:HITL 開啟時順手 `deleteAgentCheckpoint`(暫停中被 abort 的 run 不能留下殭屍 checkpoint,`index.js:297`);然後**在回應前同步保存部分回應訊息**(`unfinished: true` + usage/cost metadata,`index.js:304`)——註解點明原因:使用者可能 abort 後立刻追問,parentMessageId 必須已存在於 DB。
5. token 計費:`abortMiddleware.js:63` 的 `spendCollectedUsage` 用 job 追蹤的 collectedUsage 扣款,扣完**清空共享陣列**防止 client 的 finally 二次扣款(`client.js:1721` 反向配合:aborted 時跳過 recordCollectedUsage)。

### 流程四:HITL 暫停(run.getInterrupt → pause)

1. `createRun` 時只有 `hitlCapable: true` 的呼叫者(AgentClient)會接上 HITL wiring(`run.ts:1196`):`humanInTheLoop: {enabled:true}` + `PreToolUse` policy hook(`hitl/runtime.ts:28`)+ durable checkpointer 綁進 `graphConfig.compileOptions`(`run.ts:1198`)。OpenAI-compat / Responses 路徑刻意不開——它們沒有 resume 端點,暫停了就是死路。
2. 工具觸發 policy 的 `ask` → LangGraph interrupt → `run.processStream` 返回。`handleRunInterrupt`(`client.js:1209`)檢查 `run.getInterrupt()`,有 payload 就:
   - `buildPendingAction`(`policy.ts:302`):附上 `expiresAt = now + approval TTL`(預設 24h,與 checkpoint TTL 同一個值,`checkpointer.ts:26`)、`requestFingerprint`(graph-determining 欄位的雜湊,防 resume 換圖)、`resumeContext`(原請求的關鍵欄位原文,供 server 端重放)。
   - job-replacement 檢查後,`approvals.pause()` 原子 CAS `running → requires_action`(`ApprovalLifecycle.ts:36`);失敗(job 已 abort/被換)就丟棄 interrupt。
   - 捕捉本回合 `tool_search` 發現的 deferred tools 存進 `discoveredTools`(resume 重建的 graph 是 `messages: []`,掃不到歷史,不存就會 "unknown tool")。
   - **立刻釋放並發 slot**(`client.js:1304`)——否則快速核准會被自己的 429 擋住。
   - `emitChunk({ event: ON_PENDING_ACTION, data: pendingAction })` 推核准卡片給客戶端。
3. controller 的 pause 分支(`request.js:567`):settle DB promise、把已存的 response **改回 `unfinished: true`**(核准若過期,歷史裡不能留一則假完成的訊息;且有 liveness 檢查防止蓋掉快速 resume 已寫入的完成內容)、清理資源後 return——**不發 final、不 completeJob**,job 留在 `requires_action`,原始程序徹底退出。

### 流程五:resume(POST /chat/resume)

`chat.js:99` 宣告在 `/:endpoint` 之前;`restoreResumeContext` middleware(`chat.js:44`)先跑:從 job 的 `pendingAction.resumeContext` 把 ephemeral agent 設定 + model_parameters **蓋回 req.body**(客戶端重整後根本無法可靠重送這些;同時讓 fingerprint 驗得過、且惡意 body 換不了工具集)。之後走與正常聊天**完全相同**的 middleware 鏈(PII 過濾、agent 權限、`buildEndpointOption`)。

`ResumeAgentController`(`resume.js:384`)依序:

1. **授權與一致性防線**:userId/tenantId → agent_id 精確相符 → endpoint 精確相符 → `status === 'requires_action'` 且未過期(過期則當場 `expireApproval` 驅動終結,`resume.js:426`)→ `actionId` 必須等於當前 pendingAction(防舊決定套到新問題)→ `requestFingerprint` 重新計算比對(防 ephemeral 設定調包,`resume.js:457`)。
2. **決定驗證**(`hitl/resume.ts`):每個暫停的 tool call 都要有決定(`findUndecidedToolCalls`)、決定必須在 policy 的 `allowed_decisions` 內(`findDisallowedDecisions`,fail-closed)、`edit`/`respond` 必須帶完整 payload(`findIncompleteDecisions`);未知決定一律映射成 reject(`toSdkDecision`)。
3. **重新取得並發 slot** → **原子認領**:`approvals.resolve(streamId, actionId)`(`ApprovalLifecycle.ts:80`)CAS `requires_action → running`,**只有一個贏家**;雙擊 / 兩個分頁的輸家拿到 409,絕不重複驅動 run(工具會重跑、費用會重扣)。
4. ACK `res.json({ status: 'resuming' })` ——後續全部走客戶端**既有的 SSE**(同一 streamId)。
5. **重建執行環境**:seed `req.body.parentMessageId`、從 job(而非 resume body——安全考量,`resume.js:529`)還原上傳檔案、還原對話 createdAt 錨點 → `initializeClient` 重建 AgentClient → 綁回 `conversationId / jobCreatedAt / responseMessageId`。
6. **`client.resumeCompletion`**(`client.js:1809`):把暫停前內容 seed 進 `contentParts`、re-prime skill/code sessions,然後**第二次 `createRun`**(`client.js:1892`)——`messages: []`(狀態由 checkpoint rehydrate)、`hitlCapable: true`(可能再度暫停)、replay `discoveredToolNames`——最後 `run.resume(resumeValue, config)`(`client.js:1951`)以使用者的決定重入被中斷的節點。刻意**不** `setGraph` 快取這張重建圖(`client.js:1932`):它的內容不完整,快取會讓 Redis 內容查詢丟失暫停前段落。
7. **收尾三分支**:
   - 又暫停(`client.pendingApproval`)→ `persistRePauseProgress` 先把這一段的內容/artifact 落盤(`resume.js:94`,下一次 resume 的全新 client 不會帶著它們),return,job 留在 `requires_action`,checkpoint 保留。
   - 中途被 abort → abort 路徑已終結,直接 return。
   - 完成 → `finalizeResumedTurn`(`resume.js:183`):合併跨段落 attachments、累計 usage(job 的 tokenUsage 是跨暫停累計的,client 只看得到 post-resume 段)、補生標題、**兩次** job-replacement 檢查(saveMessage / 標題生成的 await 之間 job 可能被換)後 `emitDone` + `completeJob` + `deleteAgentCheckpoint`。

## 關鍵資料結構

### SerializableJobData(`IJobStore.ts:16`,可放 Redis 的 job 記錄)

| 欄位 | 型別 | 用途 |
|---|---|---|
| `streamId` / `conversationId` | string | 同一個值;job 的 key |
| `userId` / `tenantId` | string | 授權比對(untenanted 舊 job 靠 userId 放行) |
| `status` | JobStatus | `running / complete / error / aborted / requires_action` |
| `createdAt` | number | **世代識別**——job-replacement guard 的比對基準 |
| `lastActiveAt` | number | stale-running failsafe 的活性基準;resume 時刷新,否則久暫停的 run 一恢復就被 reaper 收掉 |
| `userMessage` | object | messageId/parentMessageId/text/quotes/files/skills——abort 與 HITL resume 重建 requestMessage 的唯一可信來源 |
| `responseMessageId` | string | 部分回應 / resume 都寫到同一則訊息 |
| `pendingAction` | Agents.PendingAction | 待審記錄(見下表) |
| `pendingActionId` | string | pendingAction.actionId 的**扁平鏡像**——Redis Lua CAS 無法比對巢狀 JSON 欄位 |
| `agent_id` / `endpoint` / `isTemporary` | — | resume 一致性防線與臨時聊天不落盤 |
| `discoveredTools` | string[] | 暫停前 tool_search 發現的 deferred tools,resume 重播進 createRun |
| `titleEvent` / `replayEvents` / `contextUsage` / `tokenUsage` / `finalEvent` | string(JSON) | UI-only 事件與 usage 的序列化快照,重連 sync 用;`tokenUsage` 讓 usage 在跨 replica resume 後仍可重建 |
| `syncSent` / `createdEventEmitted` | boolean | 重連協定旗標 |

### PendingAction(`policy.ts:302`)

| 欄位 | 型別 | 用途 |
|---|---|---|
| `actionId` | uuid | 決定必須指名的目標;CAS guard |
| `payload` | ToolApprovalInterruptPayload \| AskUserQuestionPayload | `action_requests[]`(每個 tool call)+ `review_configs[]`(每個 tool 允許的決定) |
| `expiresAt` | number | 核准窗(= checkpoint TTL,預設 24h);過期 → `expire()` → aborted |
| `interruptId` / `threadId` / `runId` | string | LangGraph checkpoint 座標 |
| `requestFingerprint` | hash | graph-determining 請求欄位的指紋;resume 重算比對 |
| `resumeContext` | object | 同一批欄位的原文(`RESUME_CONTEXT_KEYS`,`policy.ts:217`)+ `model_parameters`,server 端重放到 resume 請求 |

### 其他

- **RuntimeJobState**(`GenerationJobManager.ts:149`):`abortController`、`earlyEventBuffer`、`finalEvent`/`errorEvent` 快取(遲到訂閱者用)、`syncSent`、`allSubscribersLeftHandlers`(刻意不走 subscribe 註冊,否則會被算成訂閱者)。
- **ResumeState**(`IJobStore.ts:250`):sync 事件的 payload;`aggregatedContent` 在 InMemory 模式來自 graph 的 live 引用(WeakRef),Redis 模式由 chunk log 重建。
- **AbortResult**(`IJobStore.ts:232`):`jobData + content + text + collectedUsage + finalEvent`——讓 abort route 不需要任何 callback 就能完成保存與計費。
- **JobStatusTransition**(`IJobStore.ts:144`):`{from, to, patch, clear, expectActionId}` 的原子 CAS 參數;InMemory 與單節點 Redis(Lua)全原子,Redis Cluster 因 hash slot 分散僅 best-effort。

## 關鍵實作細節與陷阱

1. **`streamId === conversationId` 是雙面刃。** 好處:status/abort/resume 都能用 conversationId 直查,不用維護對照表。代價:同一對話的新請求會覆蓋 job,於是**每一個**終結性動作(emitDone、completeJob、pause、checkpoint prune、標題寫入)前都得比對 `createdAt`(`request.js:711`、`resume.js:207`、`resume.js:325`、`client.js:1257`、`client.js:1754`)。這種 guard 在 codebase 出現至少六次——移植時若沿用此鍵設計,務必把 guard 做成共用 helper。
2. **快照與訂閱之間的縫隙。** `getResumeState()` 之後、`subscribe()` 之前落地的事件會兩頭落空。LibreChat 用 `subscribeWithResume` 原子化,還額外處理「這個窗內 run 剛好暫停」:訂閱後重讀 job,若已 `requires_action` 而快照沒帶 pendingAction,補一個 pending event(`GenerationJobManager.ts:1075`)。重複投遞被設計成冪等(客戶端 handler 只是 set 當前 action)。
3. **Redis 事件順序。** pub/sub 不保序,`RedisEventTransport` 用 Redis `INCR` 產生跨 replica 的全域 seq,訂閱端維護 reorder buffer;重連時 `syncReorderBuffer` 要區分「earlyEventBuffer 已重播的 seq(重複,剪掉)」與「GET 窗內的 live chunk(保留)」(`GenerationJobManager.ts:948`)。deltas 的 emit 在 Redis 模式是 **awaited**(`emitChunk` / `callbacks.js:219`)以保 publish 順序——這表示串流吞吐與 Redis RTT 掛鉤。
4. **雙重扣款防線。** abort 時 middleware 扣款後把共享的 `collectedUsage` 陣列**就地清空**(`abortMiddleware.js:91`),client 的 finally 因 `signal.aborted` 也跳過扣款——兩道防線靠「共享可變陣列」溝通,是移植時最值得改掉的隱式契約。
5. **HITL 的檔案安全邊界。** resume 的 `files` **絕不**採信請求 body(`resume.js:529`):files 不在 fingerprint 也不在 resumeContext,信任 body 等於允許把「已核准的 read-file 工具」指向另一組檔案。一律從 job metadata(onStart 時 awaited 寫入)回復,查不到就清空。
6. **checkpoint 的生命週期是三方共管。** `thread_id = conversationId` 跨回合穩定,所以:(a) 每回合完成/失敗且未暫停時必須 prune(`client.js:1752`),否則下一回合 LangGraph 會 rehydrate 舊狀態而不是重新開始;(b) 新回合開跑前再 prune 一次孤兒 checkpoint(`client.js:1618`);(c) Mongo TTL index(24h)是最後保底。abort 路徑(`index.js:297`)與 resume 失敗路徑(`resume.js:679`)也各自 prune。**忘記任何一處都會造成「新對話回合接續到上回合的殭屍 interrupt」**。
7. **核准過期的多重驅動。** 過期由三個地方競爭處理:每 60s 的 sweeper(`expireStaleApprovals`,`GenerationJobManager.ts:1697`)、resume 提交時的即時 expire(`resume.js:426`)、store 自身 cleanup。多 replica 下 store cleanup 可能贏了 CAS 但無法發 SSE(store 沒有 transport),所以 sweeper 還有「輸家 relay」:看到 `aborted + APPROVAL_EXPIRED_ERROR` 且本機沒發過 error,就補發終結事件(`GenerationJobManager.ts:1710`)。
8. **暫停時把已存回應改回 unfinished 有 race。** BaseClient 在暫停前已把 response 存成完成態;pause 分支要改回 `unfinished:true`,但快速 `/resume` 可能已經 finalize 寫入完成內容——所以改寫前要確認 job 仍停在**本世代**的 `requires_action`(`request.js:592`),讀取失敗則 fail-open(寧可留 unfinished 誤標,不可蓋掉完成內容)。
9. **早期 abort 與 `created` 事件。** abort 發生在任何內容生成前(工具載入中)時,DB 裡什麼都沒有,final event 標記 `earlyAbort: true` 且 `conversation: null`,前端據此回到新對話而不是導航進一個空對話(`GenerationJobManager.ts:786`)。
10. **錯誤 job 不立即刪除。** 錯誤可能發生在客戶端連上 SSE 之前;`completeJob(error)` 保留 job 約 60s 讓遲到的訂閱者收到 error(`GenerationJobManager.ts:698`),`subscribe` 對已終結 job 用 `setImmediate` 補發 final/error(`GenerationJobManager.ts:905`)。
11. **usage 的 resume 一致性。** context gauge 快照(pre-invoke 估計)與 token usage(post-invoke 真值)共用一條 per-stream FIFO 寫入佇列(`GenerationJobManager.ts:1234`),並在 usage 落地時把快照校正成實際 prompt tokens——否則交錯寫入會讓恢復後的 gauge 顯示舊值或膨脹估計。

## 設計決策分析

**為什麼自建 job manager 而不是「SSE 斷了就重送請求」?**
因為生成有副作用(工具執行、計費、DB 寫入),重送等於重跑。把生成變成 server-side job、把連線變成觀察者,是唯一能同時支援「斷線續看」「多分頁同看」「abort 保留部分內容」「HITL 跨日核准」的模型。

**雙介面注入(IJobStore + IEventTransport)**:同一套 GenerationJobManager 邏輯在單機(EventEmitter + Map + WeakRef graph)與水平擴展(Redis pub/sub + XADD chunk log)間切換,由 `USE_REDIS_STREAMS` 決定(`createStreamServices.ts`)。優點是漸進式擴展;缺點是**兩種模式語義並不完全相同**(InMemory 的 resume 內容來自 live graph 引用、Redis 來自 chunk 重建;pendingEvents 只在 InMemory 模式存在),測試矩陣直接翻倍,程式碼裡充滿 `if (this._isRedis)`。若重做,建議**只做一種模式**(直接以 Redis/DB 為準,單機跑一個 Redis container 即可),消滅雙語義。

**HITL 用「殺掉程序 + durable checkpoint + 重建」而非「掛起 Promise 等決定」**:掛起 Promise 意味著核准必須回到同一台機器、且程序重啟就全丟;checkpoint 方案讓核准窗可以長達 24 小時、跨 replica、跨部署。代價是 resume 要完整重建 client/graph/tool sessions/skill primes/MCP auth——`resume.js` + `resumeCompletion` 上百行的還原邏輯全是這個代價。這是正確的取捨,但**重建所需的一切必須在暫停時就持久化**(files、discoveredTools、resumeContext、model_parameters),LibreChat 是踩了坑後逐項補上的,移植時應一開始就設計「pause snapshot」的完整 schema。

**樂觀併發全靠 CAS 而非鎖**:`transitionStatus` 的 `{from, expectActionId}` guard 解掉雙擊 resume、過期 vs 決定、abort vs interrupt 等所有競態,單點原語 + 明確狀態機是這套系統最值得學的部分。相對地,job-replacement 用 `createdAt` 比對散落各處,比較像補丁;重做時可把「世代 token」做成 job 的一級概念並集中在寫入層驗證。

**弱點**:(1) `streamId === conversationId` 使「同對話並發兩則訊息」在協定層就不可能;(2) 部分回應保存有三條路徑(abort route、allSubscribersLeft、re-pause persist)寫同一則訊息,靠 messageId 冪等,語義分散;(3) 大量 fire-and-forget 寫入(updateJob catch-log)在 Redis 故障時會靜默丟 resume 資料。

## 移植到新技術棧的建議

> AI 框架尚未定案(LangGraph / LangChain / deepagents / Vercel AI SDK 四選一,完整比較見 19-framework-options.md)。本子系統最受框架影響的兩點是 **HITL** 與 **checkpoint**:選 **LangGraph 系**(LangGraph/LangChain/deepagents,LibreChat 底層即 LangGraph)時,interrupt/Command/PostgresSaver 皆原生,LibreChat 現制可高度直接參考;選 **ai-sdk** 時串流與 abort 同構,但 HITL/checkpoint 較多需自建(有 resumable-stream 等方案)。以下把與框架相關處都寫成條件式。PostgreSQL/Hono/Redis 等其餘技術棧已定案,不受框架選擇影響。

### 總體對應

| LibreChat | 你的技術棧 |
|---|---|
| GenerationJobManager(InMemory/Redis 雙模式) | **只做 Redis 單模式**:job hash + Redis Streams(XADD/XRANGE)+ pub/sub;PostgreSQL 存終態訊息 |
| MongoDBSaver checkpoint | 依框架:**LangGraph 系**(LangGraph/LangChain/deepagents)直接掛官方 `@langchain/langgraph-checkpoint-postgres`(`PostgresSaver`,自管其表)或 `-redis`(`RedisSaver`);**ai-sdk** 無 checkpointer,自行把 messages 陣列序列化進 PostgreSQL(見下) |
| Express detached async task | Hono route 內 `queueMicrotask`/不 await 的 async fn;**注意 serverless 不可行**,需要長駐 Node 程序(docker-compose 正好合適)或獨立 worker |
| `createContentAggregator` + callbacks.js | 依框架取事件流:**LangGraph 系**用圖的 `stream`(六種 streamMode 可疊加)/`streamEvents`(LibreChat 的 aggregator 即封裝此),deepagents 為編譯好的圖直接串流;**ai-sdk** 用 `streamText` 的 `fullStream` 細粒度 parts。共通做法:把事件 chunks append 進 Redis Stream,恢復時重放 |

### PostgreSQL schema 草案

生成中的熱狀態放 Redis(TTL 自動回收),**只有需要跨核准窗存活的東西進 Postgres**:

```sql
-- HITL 待審動作(取代 pendingAction 存在 job hash 裡的做法:Postgres 讓它可查詢、可審計)
CREATE TABLE pending_actions (
  action_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL,
  user_id        uuid NOT NULL,
  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','resolved','expired')),
  payload        jsonb NOT NULL,          -- tool_approval / ask_user 的 action_requests
  resume_context jsonb NOT NULL,          -- 重建 run 所需的一切(model params、files、tools)
  fingerprint    text NOT NULL,           -- graph-determining 欄位雜湊
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL
);
CREATE UNIQUE INDEX one_live_action_per_convo
  ON pending_actions (conversation_id) WHERE status = 'pending';

-- durable checkpoint(pg_cron 或 lazy delete 取代 Mongo TTL)
-- 註:LangGraph 系改用官方 PostgresSaver 自管的表,可略過此手搭表;僅 ai-sdk 需自存
CREATE TABLE agent_checkpoints (
  thread_id   uuid NOT NULL,              -- = conversation_id
  checkpoint  bytea NOT NULL,             -- LangGraph:PostgresSaver 自管;ai-sdk:jsonb 存 messages 快照
  metadata    jsonb NOT NULL DEFAULT '{}',
  upserted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id)
);

-- 訊息表加欄位支援部分回應
ALTER TABLE messages ADD COLUMN unfinished boolean NOT NULL DEFAULT false;
```

**原子認領直接用 UPDATE 取代 Lua CAS**——這是 Postgres 相對 Redis 的最大紅利:

```sql
UPDATE pending_actions
SET status = 'resolved'
WHERE action_id = $1 AND status = 'pending' AND expires_at > now()
RETURNING *;   -- 0 rows = 輸家,回 409
```

### Redis 用途(對應 RedisJobStore / RedisEventTransport)

- `job:{convoId}` HASH:status、createdAt(世代 token)、responseMessageId、usage 累計;TTL 隨活動刷新(= stale-job reaper)。
- `stream:{convoId}:chunks` Redis Stream:每個 stream part / 事件 `XADD` 進去(不論框架的事件流);重連 replay 用 `XRANGE`(可帶客戶端上次收到的 id 做增量 replay——比 LibreChat 的「整包 aggregatedContent sync」更精細)。
- `stream:{convoId}:events` pub/sub channel:live 推送;`abort:{convoId}` channel:跨 replica 中止。
- `user:{userId}:active` SET:對應 `/chat/active`。
- 若只跑單一 backend container,可以省掉 pub/sub 直接程序內 EventEmitter + Redis Stream 持久化,但建議一開始就全走 Redis,避免 LibreChat 的雙模式泥沼。

### Hono route 對應

```
POST /api/chat                → 建 job、立即回 {streamId};生成丟進背景(或 BullMQ worker)
GET  /api/chat/stream/:id     → streamSSE(hono/streaming):先 XRANGE replay(帶 Last-Event-ID),
                                 再 SUBSCRIBE live;c.req.raw.signal 監聽客戶端斷線
GET  /api/chat/active         → SMEMBERS user active set
GET  /api/chat/status/:id     → job hash + XRANGE 聚合
POST /api/chat/abort          → PUBLISH abort channel + 保存部分回應(unfinished=true)+ 扣款
POST /api/chat/resume         → pending_actions 的 UPDATE...RETURNING 認領 → 重建 run
```

middleware 對應:`restoreResumeContext` → Hono middleware 在 `/resume` 上從 `pending_actions.resume_context` 蓋回 request body;auth guard 用 Hono 的 `createMiddleware` 鏈。

### 框架對應能力(依 AI 框架選擇)

框架未定案(完整比較見 19-framework-options.md)。以下逐能力分述:前四項(串流、可恢復串流、HITL、checkpoint)受框架影響,最後的 abort 與框架無關。

- **串流與聚合**:
  - **LangGraph 系**:用圖的 `stream`(六種 streamMode 可疊加)/ `streamEvents` 取事件——LibreChat 的 `createContentAggregator` 即封裝此;deepagents 為編譯好的圖,直接串流。
  - **ai-sdk**:`streamText()` 的 `fullStream` 產生細粒度 parts(前端協定四者最完整)。
  - 共通:不直接回傳框架的 Response,而是自己消費事件流,每個 part 寫 Redis Stream + publish——這一層就是你的 `emitChunk`;`onFinish`/完成回呼對應「先 saveMessage 再發 final」。
- **可恢復串流(斷線重連)**:
  - **LangGraph 系**:框架**無**內建可恢復串流,需自建 job store + replay——LibreChat 14 現制可直接照抄。
  - **ai-sdk**:有官方 `resumable-stream` 套件(Redis + `useChat({resume})`),概念與本文相同,但恢復粒度較粗,status/active 查詢仍要自建。
  - 兩者都建議自建 Redis Stream replay,能同時涵蓋 status/active 查詢。
- **HITL(本系統最受框架影響處)**:
  - **LangGraph**:原生 `interrupt()` + `Command({resume})` + checkpointer,跨 process/replica resume——與 LibreChat 現制(interrupt → pause → 重建 graph → `run.resume`)**完全同構**,`resume.js`/`resumeCompletion` 的重建邏輯可直接對映。
  - **LangChain**:`humanInTheLoopMiddleware` 開箱;**deepagents**:`interruptOn` 參數開箱(兩者底層都是 LangGraph interrupt)。
  - **ai-sdk**:無 LangGraph 式 interrupt,但有等價原語——v7 tool approvals(policy 級)+ WorkflowAgent durable resume,或**最透明**的自建法:tool 定義**不含 `execute`** 時,`streamText` 產生 `tool-call` part 後即結束該步;把此時的 messages 陣列存進 checkpoint 表、建 `pending_actions`、發 SSE 核准卡片。resume 時讀回 messages、append `tool-result`(approve=真的執行、reject=塞入拒絕結果、edit=改 args 後執行——對應 `toSdkDecision` 的四種決定)、再跑一次 `streamText`。此路徑**不需第二次「建圖」**(狀態就是 messages 陣列),比 checkpoint rehydrate 簡單;選 ai-sdk 時務必利用這點。
- **checkpoint 持久化**:
  - **LangGraph 系**:直接掛官方 `PostgresSaver` / `RedisSaver`(LangChain/deepagents 回傳物即圖,直接掛 checkpointer),不必自建上方的 `agent_checkpoints` 手搭表。
  - **ai-sdk**:無 checkpointer,messages 陣列即狀態,自存 PostgreSQL(即上方 schema);WorkflowAgent 另有 durable storage 抽象。
- **abort(與框架無關)**:各框架都支援 `AbortSignal`(`streamText({ abortSignal })` / 圖的 signal 直通);跨 replica 用 Redis abort channel 觸發本地 AbortController,與 LibreChat 同構。

### Next.js 前端考量

- 對應 `useResumableSSE`:進入對話先打 `/chat/active`(或 `/chat/status/:id`),有 active job 就以 `?resume=true`(或 `Last-Event-ID`)重掛 SSE;選 **ai-sdk** 時 `useChat({ resume: true })` 可直接用,選 **LangGraph 系** 則前端這層需自建(自訂 SSE hook,LibreChat 的 `useResumableSSE` 可照抄)。
- pendingAction 渲染要處理 LibreChat 踩過的 race:核准卡片事件可能比 tool-call part 先渲染到達,需 bounded retry(`useResumableSSE.ts:534` 的 120-frame retry 是前車之鑑);多個 tool call 的批次核准要等**全部**卡片就位。
- final event 到達時先讓 server 完成 DB 寫入再 invalidate query(LibreChat 的「save before emit」順序),否則 refetch 會拿到舊資料。

### 沒有直接對應、可以捨棄的部分

- **InMemory 模式全部**(WeakRef graph、earlyEventBuffer、pendingEvents):單一 Redis 模式下,「早期事件」就是 Redis Stream 裡的前幾條,訂閱前 XRANGE 即可,整個 buffer/sync/skipBufferReplay 協定消失。
- **`streamId === conversationId`**:建議 job 用獨立 uuid、另建 `conversationId → activeJobId` 索引,job-replacement guard 從六處比對變成一個索引交換,還順便解鎖同對話並發。
- **requestFingerprint / resumeContext 重放**(依框架而定):選 **ai-sdk** 時 resume 不重建 graph(messages 就是狀態),只要 `pending_actions.resume_context` 存齊 model 設定與 tool 白名單、resume 時完全不信任 client body,即可達到同等安全性,無需指紋機制。選 **LangGraph 系** 時 resume 仍以 checkpoint 重建 graph(與 LibreChat 同構),`requestFingerprint`/`resumeContext` 防「ephemeral 設定調包後換圖」的價值依舊存在,建議保留。
