# 15. 對話與訊息模型

## 定位

這份文件描述 LibreChat 如何把「一連串的聊天回合」持久化、定址、串成可分支的對話樹,以及圍繞這個核心資料模型的周邊子系統:編輯/重生成的分支語意、對話 fork/複製/匯入匯出、標題自動生成、多代理「並行比較」對話(addedConvo)、MeiliSearch 全文搜尋同步、分頁游標,以及多模態訊息內容(content parts)的結構。

在整體架構裡,conversation/message 是最底層、被讀寫頻率最高的資料層:

- **執行期**(agent runtime、tool system、MCP)每次回合都會讀取「目前分支的歷史訊息」組成 LLM prompt,並在回合結束後寫回新的 user/assistant 訊息列。
- **前端**用同一份扁平訊息陣列在瀏覽器端重建整棵對話樹,驅動訊息串渲染、sibling(分支)切換 UI。
- **搜尋、匯入匯出、分享(fork）**都是「讀取既有訊息集合 → 依某種規則篩選/重新編號 → 寫回一批新記錄」的變形。

本文只負責「conversation/message 這兩張表(collection)的 schema、樹狀重建演算法、以及圍繞它們的 CRUD/搜尋/匯入匯出流程」。agent 執行迴圈的細節見 04-execution-engine.md、multi-agent 圖與 handoff 見 05-multi-agent.md、LLM provider 參數轉換見 06-llm-providers.md——三者都是「訊息內容從哪裡來」,本文是「訊息放在哪裡、怎麼串起來」。

核心檔案:

- Schema:`packages/data-schemas/src/schema/convo.ts`、`packages/data-schemas/src/schema/message.ts`、`packages/data-schemas/src/schema/defaults.ts`(`conversationPreset`)
- DB 方法:`packages/data-schemas/src/methods/conversation.ts`、`packages/data-schemas/src/methods/message.ts`
- 樹狀重建:`packages/data-provider/src/messages.ts`(`buildTree`,前端/共用)、`api/app/clients/BaseClient.js:1059`(`getMessagesForConversation`,後端 prompt 組裝)
- 編輯/重生成語意:`api/app/clients/BaseClient.js`(`setMessageOptions`、`sendMessage`)、`client/src/hooks/Chat/useChatFunctions.ts`(`ask`)
- REST 路由:`api/server/routes/convos.js`、`api/server/routes/messages.js`、`api/server/routes/search.js`
- Fork/複製/匯入匯出:`api/server/utils/import/fork.js`、`api/server/utils/import/importBatchBuilder.js`、`api/server/utils/import/importers.js`、`client/src/hooks/Conversations/useExportConversation.ts`
- 標題生成:`api/server/services/Endpoints/agents/title.js`(`addTitle`)
- 並行比較對話:`api/server/services/Endpoints/agents/addedConvo.js`
- MeiliSearch 同步:`packages/data-schemas/src/models/plugins/mongoMeili.ts`、`api/db/indexSync.js`、`config/reset-meili-sync.js`
- 內容分塊(content parts):`packages/data-provider/src/types/agents.ts`(`Agents` namespace)、`packages/data-provider/src/types/runs.ts`(`ContentTypes` enum)

---

## 核心概念

- **兩個 collection,兩種 ID**:`conversations` 存對話的中繼資料與 LLM 預設參數(preset),`messages` 存實際的每一輪對話內容。兩者都用**應用層產生的 UUID 字串**定址(`conversationId`、`messageId`),而不是 Mongo 的 `_id`。這與 03-agent-data-model.md 描述的「公開 `id` vs 內部 `_id`」是同一套設計哲學:對外可見的識別碼永遠與資料庫主鍵策略解耦。

- **樹是「隱式」的,不是儲存出來的**:每則訊息只存一個 `parentMessageId`(單一指標),沒有 `path`/`depth`/`lft-rgt` 這類物化欄位。整棵對話樹(含所有分支)是每次讀取時,把該 `conversationId` 底下所有訊息一次撈出來,用一個 **O(n) 單趟掃描** 在記憶體裡重建出來的(`buildTree`)。第一則訊息的 `parentMessageId` 是一個哨兵值 `Constants.NO_PARENT = '00000000-0000-0000-0000-000000000000'`(`packages/data-provider/src/config.ts:2625`),不是 `null`(雖然某些舊資料/匯入路徑也會出現 `null`,程式碼對兩者都要防禦性處理)。

- **分支(branch)** = 多個訊息共享同一個 `parentMessageId`。產生分支的三種操作:
  - **Regenerate(重新生成)**:對同一個 user 訊息,產生新的 assistant 訊息(新 `messageId`,`parentMessageId` 不變)→ assistant 層出現多個 sibling。
  - **Edit(編輯 user 訊息)**:對原本的 user 訊息,產生一個新 `messageId` 但 `parentMessageId` 與原 user 訊息相同的新訊息 → user 層出現多個 sibling,各自再往下長出獨立的回覆子樹。
  - **Continue(續寫)**:不是分支,是同一個 `messageId` 被延伸(內容附加),語意上是「同一則訊息還沒寫完」。

- **兩套獨立的樹狀走訪演算法,各司其職**:
  - `buildTree`(`packages/data-provider/src/messages.ts:5`,前端與共用套件都會用)一次性建出**完整多分支樹**(所有 sibling、所有深度),附加 `children[]`、`depth`、`siblingIndex`,供 UI 渲染整條訊息串與「1 / N」的分支切換器。
  - `BaseClient.getMessagesForConversation`(`api/app/clients/BaseClient.js:1059`)從某個葉節點的 `parentMessageId` **往上走到根**,再反轉順序,只拿出**目前使用中的那一條直線路徑**,忽略所有其他分支。這是送進 LLM 的 prompt 歷史。
  - 這個切分是刻意的效能設計:UI 需要「整棵樹」以支援分支切換,LLM 每次呼叫只需要「一條路徑」——把兩者合一等於每次對話都要算出並丟棄整棵樹的其餘部分。

- **content parts(多模態內容)**:訊息的實質內容可以是舊式扁平的 `text: string`,也可以是 `content: MessageContentComplex[]` ——由 `ContentTypes` 列舉(`text`/`think`/`tool_call`/`image_url`/`video_url`/`input_audio`/`agent_update`/`error`/…)區分的分塊陣列,支援文字、推理過程(reasoning)、工具呼叫、圖片、影片、音訊混排在同一則訊息裡。多個 agent 平行輸出時(見 05-multi-agent.md),同一則訊息的 `content[]` 各分塊還可以帶 `agentId`/`groupId` 做「並排顯示」的歸屬標記。

- **addedConvo(並行比較對話)**:使用者可以在同一個 `conversationId` 底下,用另一組 endpoint/model/agent 設定「加開一個並行對話」,兩邊的 assistant 回覆會出現在同一批 messages 裡,用 `addedConvo: boolean` 欄位區分「這則訊息屬於附加對話」。這不是另一張表,是同一棵樹上用旗標分流的邏輯子執行緒。

- **Fork / 複製 / 匯入匯出是同一個原語的四種外觀**:全部收斂到 `ImportBatchBuilder`(`api/server/utils/import/importBatchBuilder.js`)——「產生一批新的 `conversationId`/`messageId`,依一份 id 對照表重寫 `parentMessageId`,確保同一條父子鏈上的 `createdAt` 嚴格遞增,最後一次批次寫入」。差別只在「來源訊息集合怎麼篩選/怎麼解析」。

- **搜尋是最終一致的旁路索引**:MeiliSearch 不在同一個交易裡,是一個由 Mongoose plugin 掛勾(hook)維護的旁路索引,靠文件上的 `_meiliIndex: boolean` 欄位加上背景排程掃描來保證「最終」同步,而不是即時、強一致的。

---

## 架構與流程

### 資料形狀:兩張表 + 隱式樹

```
conversations (メタ資料 + LLM preset)          messages (實際內容,巨量寫入)
┌────────────────────────────┐         ┌──────────────────────────────────┐
│ conversationId (UUID, PK)   │  1    N │ messageId (UUID, PK)              │
│ user                        │◄────────│ conversationId (FK, 字串比對)     │
│ title                       │         │ parentMessageId (指向另一個 msg)  │
│ endpoint/model/…(preset)    │         │ isCreatedByUser                   │
│ messages: ObjectId[]  ← 衍生│         │ text / content[]                  │
│ tags / pinned / isArchived  │         │ addedConvo                        │
│ chatProjectId                │         │ files / attachments               │
│ isTemporary / expiredAt     │         │ isTemporary / expiredAt           │
└────────────────────────────┘         └──────────────────────────────────┘

隱式樹(以 parentMessageId 重建,不落地儲存):

        [msg1: user "你好"]  parentMessageId = NO_PARENT (root)
              │
        [msg2: assistant]     parentMessageId = msg1
        ├── [msg3: assistant] ← regenerate 出的 sibling(同 parent = msg1)
              │
        [msg4: user "繼續解釋"]  parentMessageId = msg2
        ├── [msg5: user 編輯版] ← edit 出的 sibling(同 parent = msg2)
              │                        │
        [msg6: assistant]        [msg7: assistant]   ← 兩條獨立子樹
```

`conversation.messages` 這個 `ObjectId[]` 陣列**不是**樹狀結構的來源,它只是 `saveConvo` 每次寫入時重新查一次 `getMessages({conversationId, user}, '_id')` 灌回去的**衍生快取**(`packages/data-schemas/src/methods/conversation.ts:216`),用途接近「這個對話目前有幾則訊息」的計數輔助,不能拿來做定序或當作外鍵信任。

### 一次「送出訊息」的資料流

```
client ask()
   │  intermediateId = uuid()  (使用者訊息的暫時 ID)
   │  parentMessageId = 目前 UI 顯示中葉節點的 messageId
   ▼
POST /agents/chat  (或對應 endpoint)
   ▼
BaseClient.setMessageOptions(opts)          [api/app/clients/BaseClient.js:314]
   ├─ conversationId ?? crypto.randomUUID()
   ├─ userMessageId  ?? crypto.randomUUID()
   ├─ responseMessageId ?? crypto.randomUUID()
   ├─ head = isEdited ? responseMessageId : parentMessageId
   └─ this.currentMessages = await loadHistory(conversationId, head)
                              → 內部呼叫 getMessagesForConversation
                                (只拿「head 這條葉節點」往根的單一路徑)
   ▼
buildMessages(currentMessages, parentMessageId, …)   組成送給 LLM 的 payload
   ▼
sendCompletion(payload)  →  LLM 串流回應
   ▼
saveMessageToDatabase(userMessage)   saveMessageToDatabase(responseMessage)
   ▼
saveConvo(...)   → findOneAndUpdate 更新 conversations 文件
                 → 順便重查 messages 的 _id 陣列灌回 conversation.messages
   ▼
(若是這個對話的第一輪) addTitle(...)  → 背景產生標題,不擋回應
```

### Edit / Regenerate 的分支語意(`BaseClient.setMessageOptions` / `sendMessage`)

```
              isEdited=false, isRegenerate=false        isRegenerate=true
              (一般新訊息)                                (重新生成)
parentMessageId = 前一則訊息 id                          parentMessageId = messageId(user 訊息本身)
userMessageId   = 新 uuid                                userMessageId   = 沿用原 user 訊息 id
responseMessageId = 新 uuid                              responseMessageId = 新 uuid
                                                          → 新的 assistant sibling,parent 不變

              isEdited=true, isContinued=false            isEdited=true, isContinued=true
              (編輯訊息內容)                                (續寫)
head = responseMessageId(重用/覆寫最後一則的 id)          head = responseMessageId
this.currentMessages[last].messageId = head              沿用最後一則訊息,原地附加內容
→ 依 editedContent.index 就地改寫 content[] 裡的某個分塊    → 不是新分支,是同一則訊息的延伸
```

關鍵程式碼(`api/app/clients/BaseClient.js:327-345`):

```js
const parentMessageId = opts.parentMessageId ?? Constants.NO_PARENT;
const userMessageId = overrideUserMessageId ?? opts.overrideParentMessageId ?? crypto.randomUUID();
let responseMessageId = opts.responseMessageId ?? crypto.randomUUID();
let head = isEdited ? responseMessageId : parentMessageId;
this.currentMessages = (await this.loadHistory(conversationId, head)) ?? [];
if (isEdited && !isContinued) {
  responseMessageId = crypto.randomUUID();
  head = responseMessageId;
  this.currentMessages[this.currentMessages.length - 1].messageId = head;
}
```

前端(`client/src/hooks/Chat/useChatFunctions.ts:401-521`)在送出前就先計算好 `targetParentMessageId`/`overrideParentMessageId`,並用 `Constants.COMMON_DIVIDER`('__')把「使用者訊息 id + 索引」編碼進單一字串欄位,讓伺服器能分辨「這是 N 個平行送出裡的第一個(要真的存 user 訊息)」還是「第二個以後(user 訊息已經存過,只需再產生 assistant 分支)」——這是為了支援 addedConvo 並行比較模式:一次操作要同時對兩個 endpoint 送出「同一則」使用者訊息,但只能存一次。

前端渲染時,`buildTree` 把每個節點的 `siblingIndex` 算出來,`SiblingSwitch.tsx` 用 `siblingIdx + 1 / siblingCount` 顯示分支導覽 UI,使用者可以左右切換不同的 regenerate/edit 版本,但**同一時間只有一條路徑會被送進 LLM context**(由 `getMessagesForConversation` 決定)。

### Fork(分岔一個新對話)

`POST /api/convos/fork` → `forkConversation`(`api/server/utils/import/fork.js:87`):

```
originalConvo + originalMessages (整個對話全部訊息)
   │
   ├─ splitAtTarget=true?
   │     → splitAtTargetLevel: 把 targetMessageId 所在層級以下的訊息切出來,
   │       該層所有訊息的 parentMessageId 重設為 NO_PARENT(變成新對話的根)
   │
   ├─ option = DIRECT_PATH        → 只取 targetMessageId 往根的單一路徑
   ├─ option = INCLUDE_BRANCHES   → 路徑 + 路徑上每個節點的其他 sibling(不含 target 的子孫)
   └─ option = TARGET_LEVEL(預設) → 路徑 + sibling + target 以下所有子孫(逐層 BFS)
   │
   ▼
cloneMessagesWithTimestamps(messagesToClone, importBatchBuilder)
   ├─ 每則訊息重新分配 messageId (uuid)
   ├─ 依 id 對照表重寫 parentMessageId
   └─ 確保 createdAt 嚴格晚於其父訊息的 createdAt(必要時 +1ms)
   ▼
importBatchBuilder.saveBatch()  → bulkSaveConvos + bulkSaveMessages
```

`ForkOptions` 三選項(`packages/data-provider/src/config.ts:2745`)對應三種「要保留多少上下文」的取捨:只要對答本身(DIRECT_PATH)、連同當時考慮過的其他版本(INCLUDE_BRANCHES)、或連同後續所有嘗試(TARGET_LEVEL,適合「從這裡另開一個完整副本繼續玩」)。`duplicateConversation` 則是 `forkConversation` 的特例:永遠用 `TARGET_LEVEL` 取到「最後一則訊息」為止,等於整個對話原樣複製一份。`forkSharedConversation` 是分享連結場景的變形——來源是已經去識別化、只保留白名單欄位的 `getSharedMessages` 結果,並額外剝除 `file_id`(見「陷阱」小節),避免分享出去的分岔繼承原始擁有者的檔案存取權。

### 匯入(多種外部格式 → 統一內部結構)

`POST /api/convos/import` → `importConversations` → `getImporter(jsonData)`(`api/server/utils/import/importers.js:16`)依 JSON 形狀分派:

| 偵測條件 | 格式 | 解析器 |
|---|---|---|
| `Array` 且 `jsonData[0].chat_messages` | Claude 匯出 | `importClaudeConvo` |
| `Array` 且 `jsonData[0].mapping` | ChatGPT 匯出(DAG mapping) | `importChatGptConvo` |
| `jsonData.version && jsonData.history` | ChatbotUI | `importChatBotUiConvo` |
| `jsonData.conversationId && (messagesTree \| messages)` | LibreChat 自家匯出 | `importLibreChatConvo` |

ChatGPT 匯出格式本身是一個 `mapping: {id → {message, parent, children[]}}` 的圖,`processConversation` 要做三件麻煩事:(1) 跳過 `system`/`reasoning_recap`/`thoughts` 這幾種非對話節點,同時 `findValidParent` 沿著父鏈往上找到「最近的有效父節點」;(2) `adjustTimestampsForOrdering` 修正時間戳記倒掛(工具呼叫結果有時比父訊息早幾毫秒送達);(3) `breakParentCycles` 偵測並打斷循環引用——這些防禦性程式碼直接證明了「訊息圖」在真實外部資料裡並不保證是一棵樹,匯入層必須把它們馴服成 LibreChat 內部「每則訊息唯一一個父節點」的不變量。

匯出(`client/src/hooks/Conversations/useExportConversation.ts`)完全跑在前端:用 `buildTree` 建出樹,再依 `recursive` 選項決定輸出成扁平陣列(`messages`)或巢狀陣列(`messagesTree`),JSON 格式與 `importLibreChatConvo` 讀的格式互為對偶——這是「本系統匯出 → 本系統匯入」這條路徑天生無損的原因。CSV/Markdown/純文字/截圖匯出則是把 `content[]` 依 `ContentTypes` 逐一格式化成人類可讀文字,不保留可回灌的結構。

### 標題自動生成(`addTitle`)

```
第一輪對話送出
   │
   ├─ immediate=true(串流模式常見):與主回應「平行」呼叫 client.titleConvo()
   │     只用使用者的第一句話,不等 assistant 回覆完成
   │     → 完成後先寫入 titleCache(TTL 120s),再等待 convoReady 才 saveConvo(noUpsert:true)
   │       (避免 immediate 模式下對話文件可能還沒建立就 upsert 出一筆空殼)
   │
   └─ immediate=false(legacy):等整個回應完成後才用 response 內容生成標題

同時:GET /api/convos/gen_title/:conversationId
   → 前端用指數退避(500ms→8s,最長 ~15.5s)輪詢 titleCache
   → 取到後回傳並刪除快取 key(一次性交付)
```

`TITLE_CONVO` 環境變數、`client.options.titleConvo === false`、以及 `req.body.isTemporary` 三個閘門任一為真都會整段跳過。`signal`(使用者按停止)會中止標題生成呼叫;`discardSignal`(這個串流被更新的一輪取代,或本輪失敗)則是「標題已經生成好了,但不能落地」——避免競態下舊標題蓋掉新對話。

### MeiliSearch 同步

```
寫入路徑(每次 save/update)               背景協調路徑(indexSync,定期執行)
┌────────────────────────┐              ┌──────────────────────────────────┐
│ post('save') hook       │              │ getSyncProgress()                │
│  → addObjectToMeili     │              │  = count(_meiliIndex:true)       │
│     (最多重試 3 次)      │              │    / count(全部可索引文件)       │
│  → 成功則 _meiliIndex=true│              │                                  │
│                          │              │ 未同步數 > syncThreshold(預設1000)│
│ post('findOneAndUpdate')│              │  或全新索引(0 已同步)            │
│  → 標題變了才觸發 update │              │  → Message/Conversation.syncWithMeili()│
└────────────────────────┘              │     批次抓 _meiliIndex≠true 的文件 │
                                          │     addDocumentsInBatches → 標記 true│
                                          └──────────────────────────────────┘
                                                    │
                                          FlowStateManager 分散式鎖(key: 'meili-index-sync')
                                          確保多實例部署下同一時間只有一個實例在跑同步
```

`_meiliIndex` 是文件上的一個 `Boolean`(`select: false`,預設不回傳),純粹是「這份文件是否已經進 MeiliSearch」的旗標,**不是**訊息佇列。寫入路徑失敗(重試 3 次仍失敗)就直接放棄、`next()` 繼續——旗標永遠不會被設成 `true`,而背景的 `indexSync` 掃描正是為了兜住這種漏網文件。手動重置腳本 `config/reset-meili-sync.js` 提供逃生門:把所有文件的 `_meiliIndex` 批次改回 `false`,強制下次啟動時全量重新索引(常用於 MeiliSearch 資料卷被清空或毀損後)。

`isIndexableDocument`(`mongoMeili.ts:133`)還疊了一層 retention 判斷:只有「明確標記為非暫存(`isTemporary===false`)且未過期」或「舊資料且沒有 `expiredAt`」的文件才會進索引——暫存對話(temporary chat)刻意不進全文搜尋。

---

## 關鍵資料結構

### Conversation(`packages/data-schemas/src/schema/convo.ts`)

| 欄位 | 型別 | 用途 / 備註 |
|---|---|---|
| `conversationId` | String, required, indexed, meiliIndex | 應用層 UUID 主鍵,與 Mongo `_id` 無關。 |
| `title` | String, default `'New Chat'`, meiliIndex | 標題,`addTitle` 背景生成後回填。 |
| `user` | String, indexed, meiliIndex | 擁有者(user id 字串)。**所有存取控制都靠這個欄位比對**,不靠 `_id` 不可猜測性。 |
| `messages` | ObjectId[] ref Message | **衍生快取**,`saveConvo` 每次重查回填,不是樹狀結構來源。 |
| `isTemporary` | Boolean, default false | 暫存對話(不進搜尋索引,有 TTL)。 |
| `agent_id` | String | 綁定的 agent(agents endpoint)。 |
| `tags` | String[], meiliIndex | 使用者自訂書籤標籤;刪除對話時要連動遞減 tag 計數。 |
| `chatProjectId` | String, indexed, default null | 所屬「專案」分組(類似資料夾)。 |
| `files` | String[] | 對話層級關聯的檔案 id(非訊息層級的 `files`)。 |
| `expiredAt` | Date | TTL 索引(`expireAfterSeconds:0`)驅動的自動刪除時間點。 |
| `tenantId` | String, indexed | 多租戶隔離(見 03-agent-data-model.md 的租戶模式)。 |
| `pinned` | Boolean | 釘選置頂。 |
| `isArchived` | Boolean(來自 `conversationPreset`) | 封存(列表預設過濾掉)。 |
| `endpoint`/`endpointType`/`model`/`agent_id`/`assistant_id`/`spec`/`instructions`/`temperature`/`top_p`/`maxOutputTokens`/… | 各型別(來自 `conversationPreset`,`packages/data-schemas/src/schema/defaults.ts`) | **LLM 預設參數包**,對話建立當下鎖定的一組 model 參數快照;完整清單與語意見 06-llm-providers.md 的 `model_parameters`。 |

索引:`{conversationId,user,tenantId}` 複合唯一;`{user, chatProjectId, updatedAt:-1, _id:-1}` 與 `{user, chatProjectId, createdAt:-1, _id:-1}` 供列表排序;`{expiredAt:1}` TTL;`{_meiliIndex:1, isTemporary:1, expiredAt:1}` 供搜尋同步掃描。

### Message(`packages/data-schemas/src/schema/message.ts`)

| 欄位 | 型別 | 用途 / 備註 |
|---|---|---|
| `messageId` | String, required, indexed, meiliIndex | 應用層 UUID 主鍵。 |
| `conversationId` | String, required, indexed, meiliIndex | 對應到 `conversations.conversationId`(應用層外鍵,非 Mongo ref)。 |
| `parentMessageId` | String | 樹的唯一指標;根訊息是 `Constants.NO_PARENT` 哨兵值(部分舊資料為 `null`)。 |
| `user` | String, required, indexed, meiliIndex | 擁有者;所有 CRUD 都必須以此過濾(IDOR 防護的最後一道防線)。 |
| `isCreatedByUser` | Boolean, required | 區分 user turn / assistant turn。 |
| `sender` | String, meiliIndex | 顯示名稱(如 `'User'`、模型名)。 |
| `text` | String, meiliIndex | 舊式扁平文字內容;新格式改用 `content[]`,但 `text` 仍會被保留/聚合以相容舊 UI 與搜尋。 |
| `content` | Mixed[], meiliIndex | `Agents.MessageContentComplex[]`,見下方「Content Parts」。 |
| `files` / `attachments` | Mixed[] | 檔案關聯 / 工具產出附件的中繼資料。 |
| `finish_reason` / `unfinished` / `error` | String / Boolean / Boolean | LLM 完成狀態旗標。 |
| `tokenCount` / `summaryTokenCount` | Number | 計費/上下文裁剪用的 token 估算。 |
| `feedback` | `{rating, tag, text}` | 使用者評分(讚/倒讚)。 |
| `thread_id` | String | Assistants API 的 OpenAI thread 對應(遺留 endpoint)。 |
| `contextMeta` | `{calibrationRatio, encoding}` | token 估算校正用的中繼資料。 |
| `manualSkills` / `alwaysAppliedSkills` / `quotes` | String[] | UI-only 中繼資料,記錄該輪手動選用的 skill、自動套用的 skill、引用摘錄——只為了歷史畫面渲染,不參與 runtime 解析(runtime 讀的是 `req.body` 對應欄位)。 |
| `addedConvo` | Boolean, default undefined | 標記此訊息屬於「並行比較」的附加對話。 |
| `isTemporary` / `expiredAt` | Boolean / Date | 與 Conversation 相同的暫存/TTL 語意。 |
| `tenantId` | String, indexed | 多租戶隔離。 |

索引:`{messageId,user,tenantId}` 複合唯一;`{createdAt:1}`(供 `getMessages` 預設排序);`{_meiliIndex:1, isTemporary:1, expiredAt:1}`。

值得注意:`isEdited` 這個欄位會被 `BaseClient.sendMessage`(`api/app/clients/BaseClient.js:709`)寫進**記憶體物件** `responseMessage`,但**schema 裡沒有這個欄位**——Mongoose 預設 `strict:true` 會在 `save()`/`findOneAndUpdate()` 時靜靜丟掉它。它只用來驅動同一個請求內的串流/續寫邏輯,從未真正落地。

### `buildTree` 的輸出形狀(`packages/data-provider/src/messages.ts`)

```ts
type ParentMessage = TMessage & {
  children: TMessage[];   // 直接子節點(尚未展開的巢狀樹)
  depth: number;          // 從根節點算起的深度
  siblingIndex: number;   // 在同一個 parentMessageId 底下的順位(供 1/N 切換器)
};
```

演算法是**單趟線性掃描**(依輸入陣列順序,通常已依 `createdAt` 遞增排序):每則訊息找 `messageMap[parentId]`,找得到就掛進其 `children[]`,找不到就當作根節點推進 `rootMessages[]`。**沒有第二趟修補**——如果父節點在陣列裡排在子節點後面(時間戳記錯亂),子節點會被誤判成一個新的根,導致同一個對話畫面裂成好幾條互不相連的「執行緒」(見「陷阱」小節,`convoStructure.spec.ts` 有專門測試覆蓋這個情境)。

### Content Parts(`Agents.MessageContentComplex`,`packages/data-provider/src/types/agents.ts`)

`ContentTypes` 列舉(`packages/data-provider/src/types/runs.ts:3`):

| 值 | 語意 |
|---|---|
| `text` | 純文字分塊 `{ type, text, tool_call_ids? }`。 |
| `think` | 推理/思考過程(reasoning) `{ type, think }`。 |
| `tool_call` | 工具呼叫 `{ type, tool_call: { name, args, id, output?, approval? } }`,`approval` 存在時代表暫停等人工核可(見 07-tool-system.md)。 |
| `image_url` / `video_url` / `input_audio` | 多模態輸入/輸出附件。 |
| `agent_update` | 多代理協作時的「切換代理」標記 `{ index, runId, agentId }`(見 05-multi-agent.md)。 |
| `error` | 該分塊執行失敗的錯誤內容。 |
| `summary` | 上下文裁剪時產生的摘要分塊。 |

`content[]` 是一則訊息裡「按時間/邏輯順序排列的多個分塊」,而非「多種可選格式擇一」——一則 assistant 訊息常見的形狀是 `[think, tool_call, tool_call, text]`。搜尋索引與純文字匯出都用 `parseTextParts`(`packages/data-provider/src/parsers.ts:380`)把 `content[]` 攤平成字串,**只串接 `text` 與 `think` 兩種分塊**,`tool_call`/`image_url` 等其他型別會被跳過(不進全文搜尋)。

### 分頁游標

| 端點 | 游標形狀 | 排序鍵 | 備註 |
|---|---|---|---|
| `GET /api/convos` | Base64(`{primary, secondary}` JSON) | `sortBy`(title/createdAt/updatedAt)+ `updatedAt` 當 tiebreaker | 真正的 keyset/seek 分頁,`$or` 複合條件,對併發寫入安全。`getConvosByCursor`(`packages/data-schemas/src/methods/conversation.ts:525`)。 |
| `GET /api/messages?conversationId=` | 單一欄位原始值(字串化的 `createdAt` 或指定 `sortField`) | `sortField`(預設 `createdAt`) | **沒有 tiebreaker**——`createdAt` 撞值時可能漏頁或重複(見陷阱)。`getMessagesByCursor`(`packages/data-schemas/src/methods/message.ts:389`)。 |
| `GET /api/messages?search=` | 無游標(`nextCursor: null`) | MeiliSearch 相關性排序 | 先查 MeiliSearch 拿 messageId 集合,再用 `getConvosQueried` 的日期游標過濾可見對話,回填 DB 欄位。 |

### Fork / 匯入匯出相關型別(`packages/data-provider/src/types.ts`、`config.ts`)

```ts
enum ForkOptions {
  DIRECT_PATH = 'directPath',        // 只留單一路徑
  INCLUDE_BRANCHES = 'includeBranches', // 路徑 + 沿途 sibling
  TARGET_LEVEL = 'targetLevel',      // 路徑 + sibling + 該節點以下所有子孫(預設)
}

type TForkConvoRequest = {
  messageId: string; conversationId: string;
  option?: string; splitAtTarget?: boolean; latestMessageId?: string;
};
type TForkConvoResponse = { conversation: TConversation; messages: TMessage[] };
type TDuplicateConvoRequest = { conversationId?: string };
type TForkSharedConvoRequest = { shareId: string; targetMessageIndex?: number };
```

---

## 關鍵實作細節與陷阱

1. **樹重建對輸入順序有隱性依賴**。`buildTree` 是單趟掃描,假設輸入陣列已經「父節點先於子節點」出現(靠 `getMessages` 依 `createdAt` 遞增排序達成)。一旦時間戳記倒掛——批次寫入的 clock skew、bulk insert 时間戳記完全相同、匯入來源本身順序就亂——子節點會被誤判成新的根節點,畫面上同一個對話裂成好幾條互不相連的執行緒。`packages/data-schemas/src/methods/convoStructure.spec.ts` 有專門測試覆蓋「inconsistent timestamps → tree.length > 1(corruption)」與「preserve order → tree.length === 1」兩種情境。正因如此,`fork.js` 的 `cloneMessagesWithTimestamps`、`importers.js` 的 `adjustTimestampsForOrdering`/`breakParentCycles`,全部都在做同一件事:**用力保證每條父子鏈上的 `createdAt` 嚴格遞增**,這其實是在補償樹重建演算法本身沒有二次修補能力的設計。

2. **`conversation.messages` 是快取,不是外鍵**。`saveConvo` 每次寫入都會重新 `getMessages({conversationId, user}, '_id')` 查一次灌回這個陣列(`packages/data-schemas/src/methods/conversation.ts:216`),純粹是為了計數/相容舊用途。真正的樹狀結構永遠是重新查詢 `messages` collection、跑 `buildTree`/`getMessagesForConversation` 算出來的——不要假設這個陣列反映即時的訊息集合或順序。

3. **`isEdited` 不落地**。`BaseClient.sendMessage` 把 `isEdited` 寫進要回傳/串流的 `responseMessage` 物件,但 schema(Mongoose 與 `tMessageSchema`)都沒有這個欄位,`strict:true` 下寫入時會被靜靜丟掉。這是 Mongoose 的通用陷阱:在程式碼裡對物件多塞一個欄位不會報錯,只會在儲存時消失——移植到強 schema 的 Postgres 時,這種欄位必須明確決定「要嘛加進 schema 要嘛從物件裡拿掉」,不能沿用「反正丟了也沒事」的僥倖心態。

4. **刪除單則訊息不會連坐刪除子孫**。`DELETE /api/messages/:conversationId/:messageId` 直接 `deleteMessages({messageId, conversationId, user})`,沒有先找子孫再一起刪。留下來的子孫訊息會變成孤兒——`buildTree` 找不到它們的父節點,會把它們**靜默地**提升成新的根節點,而不是報錯或消失。另外,`deleteMessagesSince`(依 `createdAt` 門檻批次刪除)雖然在 `packages/data-schemas/src/methods/message.ts:311` 有定義且有單元測試,但目前**沒有任何 HTTP 路由呼叫它**——是保留/未接線的方法,移植時別假設「方法存在 = 功能上線」,務必查呼叫點。

5. **全文搜尋只覆蓋 `text` 與 `think` 分塊**。`parseTextParts` 與 `mongoMeili.preprocessObjectForIndex` 在索引前會把 `content[]` 攤平成 `text` 字串再刪掉原始陣列;`tool_call`/`image_url`/`agent_update` 等分塊完全不會出現在搜尋結果裡。新增 `ContentTypes` 成員時容易忘記這件事,導致「工具呼叫的內容搜尋不到」被誤判成 bug。

6. **`_meiliIndex` 是盡力而為(best-effort),不是交易性 outbox**。`addObjectToMeili` 失敗重試 3 次後直接放棄、旗標永遠停在 `false`;唯一兜底的是背景 `indexSync` 的全量掃描(受 `MEILI_SYNC_THRESHOLD` 節流,預設未同步數 >1000 才觸發整批 resync)。這代表搜尋結果的一致性延遲是「掃描週期」量級,不是「寫入後立即可搜」——把它當成最終一致索引來設計 UX(例如剛送出的訊息暫時搜不到是正常的)。

7. **MeiliSearch 索引屬性靠散落的 schema 標記手動同步**。哪些欄位進索引由 schema 定義裡的 `meiliIndex: true` 決定(`convo.ts`、`message.ts` 各自標記),沒有任何編譯期或 lint 檢查確保「新加欄位記得標記」——這與 03-agent-data-model.md 提到的 `mcpServerNames` 反正規化欄位是同一類「必須人工維持一致性」的技術債。

8. **分享/fork 會主動剝除檔案識別碼**。`forkSharedConversation` 的 `stripSharedFileIds`(`fork.js:369`)在複製分享出去的訊息時,刻意移除 `files`/`attachments` 裡的 `file_id`——因為這些檔案實際上還是屬於原分享者,若原樣保留,之後 agent 的「重新附加檔案」流程會用 `file_id` 查回原擁有者的檔案(`getUserCodeFiles` 沒有做擁有權過濾),等於讓分享連結的訪客拿到原擁有者的檔案存取權。這是一個容易漏掉的安全細節:**複製資料時,識別碼比內容本身更危險**。

9. **編輯/重生成的 ID 傳遞是手刻的字串編碼**。前端把「使用者訊息 id + 索引」用 `Constants.COMMON_DIVIDER`(`'__'`)串成單一字串塞進 `overrideParentMessageId`,伺服器再 `split` 回來判斷「這是平行送出(addedConvo)裡的第幾個請求」以決定要不要重複儲存同一則使用者訊息。這類自製 mini-encoding 沒有版本化、沒有跳脫規則,重寫時建議改成結構化欄位(例如 `{ userMessageId, submissionIndex }`)。

10. **`/messages` 游標分頁沒有 tiebreaker**。`getMessagesByCursor` 只用單一 `sortField`(預設 `createdAt`)做 `$gt`/`$lt` 比較,兩則訊息若 `createdAt` 完全相同(bulk import/fork 場景很容易撞到毫秒級碰撞),換頁時可能漏掉或重複——與 `/convos` 的複合游標(`{primary, secondary}` 都比對)形成明顯反差,是同一個系統裡兩套分頁實作成熟度不一致的例子。

11. **對話存取控制只靠 `user` 欄位字串比對,搭配快取記憶「已授權」結果**。`validateConvoAccess`(`api/server/middleware/validate/convoAccess.js`)在通過檢查後,把 `${userId}:${conversationId}` 標記為 `authorized` 快取 10 分鐘;`validateMessageReq` 則是每次都查 `getConvo(user, conversationId)` 再比對 `conversation.user !== req.user.id`。兩者都刻意避免依賴 Mongo `_id` 的不可猜測性當防護——因為 `conversationId` 本身就是應用層 UUID,可以合理假設會出現在 URL/日誌裡,存取控制必須是顯式的擁有權檢查,不是靠 ID 難以枚舉。

12. **`saveConvo` 對無效的 `chatProjectId` 是「靜默丟棄」而非拒絕請求**——校驗失敗時直接 `delete update.chatProjectId` 並 `$unset` 掉,不回錯誤。這種「fail-open 但丟資料」的處理方式在寫入路徑上要特別小心:呼叫端可能誤以為請求成功且欄位有生效。

---

## 設計決策分析

- **隱式樹(`parentMessageId` 單指標)而非物化路徑**:LibreChat 選了 schema 上最便宜的方案——沒有 `path`、`depth`、`lft-rgt` 這類需要維護不變量的欄位,分支操作退化成「插入一列同樣 `parentMessageId` 的新紀錄」,沒有重新平衡(rebalance)成本。代價是每次渲染都要整批查出來、在應用層跑 O(n) 重建,且如上述強烈依賴 `createdAt` 排序的正確性。這在「一個對話幾百則訊息」的規模下完全合理;若要支援「一棵樹幾萬個節點的共享知識圖」則需要不同設計(物化路徑或圖資料庫)。

- **兩套獨立的走訪演算法而非一套共用邏輯**:`buildTree`(前端/共用,算完整樹)與 `getMessagesForConversation`(後端,只算一條路徑)是刻意分開的,因為兩者的效能特性天差地遠——LLM 呼叫只在乎「一條路徑」,把完整樹算出來再丟棄 99% 的分支是純粹的浪費。取捨是兩份實作要各自維護對 `NO_PARENT` 語意的理解,增加了「兩處邏輯要保持一致」的心智負擔。

- **應用層 UUID 而非資料庫主鍵**:`conversationId`/`messageId` 與 03-agent-data-model.md 的 `agent.id` 是同一套哲學——公開識別碼與底層儲存策略解耦。這裡的回報特別明顯:fork/複製/匯入匯出全部退化成「產生新 UUID + 用 Map 重寫 `parentMessageId`」,沒有任何跨表 `_id` 重新對應的複雜度,也讓「同一批訊息可以合法地屬於不同使用者、不同租戶的不同對話」變得直觀(分享 fork 正是利用這點)。

- **MeiliSearch 當旁路索引,靠 hook + 定期掃描維持最終一致**:比起用 MongoDB Atlas Search 或內建 `$text` 索引,換來了獨立擴展、更好的相關性排序與 typo-tolerance,但代價是要自己搭一整套「近似 outbox」的協調機制(`_meiliIndex` 旗標 + hook + 分散式鎖背景掃描 + 手動重置腳本)。這不是真正的交易性雙寫保證,是「盡力而為 + 兜底全量掃描」的折衷方案。

- **addedConvo 用旗標分流而非獨立對話**:讓「並行比較兩個模型的回答」這個功能可以直接疊在既有的樹結構與訊息表上(一個 `Boolean` 欄位 + `getMessagesForConversation` 的 `mapCondition` 參數),不需要另建一張「並行對話」表或另一套 UI 渲染邏輯。代價是「這則訊息屬於哪一條邏輯執行緒」現在要靠 `parentMessageId` 鏈與 `addedConvo` 旗標兩個正交訊號共同決定,而不是單一欄位。

- **若重做會怎麼選**:保留扁平 `parentMessageId` 設計(它映射到 SQL adjacency list + 遞迴 CTE 幾乎零阻力),但會做三個改變——(1) 把「算整棵樹」與「算單一路徑」統一成同一個遞迴 SQL 查詢的兩種呼叫方式,而不是兩份手刻 JS 演算法各自維護 `NO_PARENT` 語意;(2) 讓排序正確性不再依賴 `createdAt`——SQL 遞迴 CTE 不需要輸入預先排序,天然免疫「時間戳記倒掛導致樹裂開」這整類問題;(3) 把搜尋同步從「旗標 + 定期全量掃描」換成「觸發器/邏輯複製驅動的變更資料擷取(CDC)」或乾脆用 Postgres 原生全文搜尋(`tsvector` + GIN 索引),消除獨立協調子系統的必要。

---

## 移植到新技術棧的建議

目標棧:PostgreSQL + Hono + Next.js + pnpm + Redis + docker-compose(已定案)+ AI 框架(**尚未定案**,候選為 LangGraph / LangChain / deepagents / Vercel AI SDK,四者的完整能力對照見 19-framework-options.md)。以下涉及框架的段落一律以條件式陳述四者的差異,而非預設其中一個。

### PostgreSQL schema 草案

```sql
CREATE TABLE conversations (
  pk              BIGSERIAL PRIMARY KEY,
  conversation_id UUID NOT NULL,
  tenant_id       TEXT NOT NULL,
  user_id         BIGINT NOT NULL REFERENCES users(pk),
  title           TEXT NOT NULL DEFAULT 'New Chat',
  endpoint        TEXT,
  model           TEXT,
  model_params    JSONB NOT NULL DEFAULT '{}',   -- conversationPreset 的其餘欄位(見 06-llm-providers.md)
  agent_id        TEXT,
  chat_project_id BIGINT REFERENCES chat_projects(pk),
  tags            TEXT[] NOT NULL DEFAULT '{}',
  is_archived     BOOLEAN NOT NULL DEFAULT FALSE,
  pinned          BOOLEAN,
  is_temporary    BOOLEAN NOT NULL DEFAULT FALSE,
  expired_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, tenant_id)
);
CREATE INDEX conversations_user_updated_idx ON conversations (user_id, updated_at DESC, pk);
CREATE INDEX conversations_title_tsv_idx ON conversations USING GIN (to_tsvector('simple', coalesce(title,'')));

CREATE TABLE messages (
  pk                BIGSERIAL PRIMARY KEY,
  message_id        UUID NOT NULL,
  conversation_id   UUID NOT NULL,
  parent_message_id UUID,                 -- NULL = 根節點,PostgreSQL 不需要哨兵字串
  tenant_id         TEXT NOT NULL,
  user_id           BIGINT NOT NULL REFERENCES users(pk),
  sender            TEXT,
  is_created_by_user BOOLEAN NOT NULL DEFAULT FALSE,
  text              TEXT,
  content           JSONB,                -- MessageContentComplex[]
  model             TEXT,
  finish_reason     TEXT,
  unfinished        BOOLEAN NOT NULL DEFAULT FALSE,
  error             BOOLEAN NOT NULL DEFAULT FALSE,
  token_count       INT,
  feedback          JSONB,
  files             JSONB,
  attachments       JSONB,
  added_convo       BOOLEAN,
  is_temporary      BOOLEAN NOT NULL DEFAULT FALSE,
  expired_at        TIMESTAMPTZ,
  content_tsv       TSVECTOR GENERATED ALWAYS AS (
                       to_tsvector('simple', coalesce(text, ''))
                     ) STORED,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (message_id, tenant_id),
  FOREIGN KEY (conversation_id, tenant_id)
    REFERENCES conversations (conversation_id, tenant_id)
);
CREATE INDEX messages_convo_created_idx ON messages (conversation_id, created_at);
CREATE INDEX messages_parent_idx        ON messages (parent_message_id);
CREATE INDEX messages_tsv_idx           ON messages USING GIN (content_tsv);
```

要點:
- `parent_message_id` 直接允許 `NULL`,不需要 LibreChat 的哨兵 UUID——少一個「兩種寫法都要防」的心智負擔。
- 不需要 `conversation.messages` 這種衍生快取陣列;要統計則數就直接 `COUNT(*)` 或用觸發器維護一個 `message_count` 欄位。
- 拿掉 `conversation.messages` 這個「假外鍵」之後,子孫訊息孤兒的問題(陷阱 4)可以用 `ON DELETE CASCADE`(若語意上真的要連坐刪除)或應用層明確的遞迴刪除來解決,而不是讓 `buildTree` 意外吞下孤兒節點。

### 樹狀查詢用遞迴 CTE 取代手刻 JS 演算法

完整樹(對應 `buildTree`):

```sql
WITH RECURSIVE thread AS (
  SELECT *, 0 AS depth, ARRAY[message_id] AS path
  FROM messages WHERE conversation_id = $1 AND parent_message_id IS NULL
  UNION ALL
  SELECT m.*, t.depth + 1, t.path || m.message_id
  FROM messages m JOIN thread t ON m.parent_message_id = t.message_id
  WHERE m.conversation_id = $1
)
SELECT * FROM thread ORDER BY path;
```

單一路徑(對應 `getMessagesForConversation`,從葉節點往根走):

```sql
WITH RECURSIVE path AS (
  SELECT * FROM messages WHERE message_id = $leaf_id
  UNION ALL
  SELECT m.* FROM messages m JOIN path p ON m.message_id = p.parent_message_id
)
SELECT * FROM path ORDER BY created_at ASC;
```

兩者都不需要輸入預先排序,徹底免疫 LibreChat 那個「時間戳記倒掛導致 `buildTree` 誤判根節點」的陷阱(陷阱 1)。前端仍然需要一份等價於 `buildTree` 的 JS 函式來處理「已經拿到扁平陣列後,在 client cache 裡即時算出 `children`/`siblingIndex`」(例如樂觀更新剛送出、還沒重新整頁的訊息)——`packages/data-provider/src/messages.ts` 的 `buildTree` 本身是純函式、不依賴 Mongoose,幾乎可以原封不動搬到新前端。

### Hono route/middleware 對應

```ts
const convos = new Hono();
convos.use('*', requireJwt, tenantContext);
convos.get('/', keysetPaginate, listConversations);      // (updated_at, pk) 複合游標
convos.get('/:id', ownerGuard, getConversation);
convos.post('/fork', forkRateLimit, forkConversation);
convos.post('/duplicate', forkRateLimit, duplicateConversation);
convos.post('/import', importRateLimit, multipartUpload, importConversation);

const messages = new Hono();
messages.get('/:conversationId', ownerGuard, listMessagesByThread); // 遞迴 CTE
messages.post('/:conversationId', ownerGuard, saveTurn);
messages.put('/:conversationId/:messageId', ownerGuard, editMessage);
```

- `validateConvoAccess`/`validateMessageReq` 的「查一次、快取 10 分鐘、比對 `user` 欄位」邏輯可以下推成 Postgres **Row-Level Security**(`CREATE POLICY ... USING (user_id = current_setting('app.user_id')::bigint)`),比應用層手動比對更難繞過;Redis 記憶「已授權」的角色可以保留,作為高 QPS 下跳過 RLS 查詢往返的快取層,而不是取代 RLS。
- 匯入路由的檔案大小限制、rate limit(`importIpLimiter`/`importUserLimiter`)、multipart 處理,原樣搬到 Hono 的 middleware 鏈即可,語意不變。

### AI 框架的訊息格式對應

框架尚未定案(候選:LangGraph / LangChain / deepagents / Vercel AI SDK,完整能力對照見 19-framework-options.md)。無論選哪一個,**分支語意(regenerate/edit/continue)都是應用層在 `parent_message_id` 上的操作,框架本身不理解「分支」這個概念**——查出來的單一路徑轉成陣列丟進框架的 `messages` 參數,框架只負責單次呼叫,持久化與分支邏輯是本文件描述的 schema/樹狀查詢層的職責,與框架選型正交。

各框架的訊息格式對應:

| | LangGraph | LangChain(`createAgent`) | deepagents | Vercel AI SDK |
|---|---|---|---|---|
| 訊息型別 | `BaseMessage`(`HumanMessage`/`AIMessage`/`ToolMessage`/…),LibreChat `@librechat/agents` 現用同款 | 同 LangGraph(底層即 LangGraph) | 同 LangGraph(`createDeepAgent` 回傳編譯好的圖) | `UIMessage`(前端串流協定)與 `ModelMessage`(送模型)兩層 |
| content parts 對應 | `content` 可為 `string` 或 `MessageContentComplex[]`,與 LibreChat 現有 `ContentTypes` 幾乎同構 | 同左 | 同左 | `UIMessage.parts`(`text`/`file`/`reasoning`/`tool-*`/`data-*`)與 `ModelMessage` content parts;概念上對應 `ContentTypes.TEXT`/`IMAGE_URL`/`TOOL_CALL`/`THINK`,但欄位命名與巢狀方式不同,需要一層顯式映射 |
| 持久化銜接 | 官方 checkpointer(`@langchain/langgraph-checkpoint-postgres`/`-redis`)可選擇性接管訊息狀態,也可維持「應用層自己查 `messages` 表組歷史」 | 同左 | 同左 | 無 checkpointer;`messages` 陣列即狀態,直接把 part 形狀存進 `content` JSONB 是最直接的作法 |

若最終選 **LangGraph 系**(LangGraph / LangChain / deepagents):`messages` 參數就是「單一路徑遞迴 CTE 查詢結果映射成 `BaseMessage[]`」,與 LibreChat 現有 `@librechat/agents` 的訊息型別高度重疊,遷移時可大量參考 04-execution-engine.md、06-llm-providers.md 現有轉換邏輯,content parts 也建議直接沿用 `MessageContentComplex[]` 形狀存進 `content` JSONB,不必重新發明格式。

若最終選 **Vercel AI SDK**:`UIMessage`/`ModelMessage` 與 LibreChat 的 `ContentTypes` 分塊概念相近但不同構,需要一層顯式映射函式(例如 `ContentTypes.TEXT ↔ text part`、`ContentTypes.THINK ↔ reasoning part`、`ContentTypes.TOOL_CALL ↔ tool part`),不能假設欄位一一對應;且 AI SDK 不提供任何「對話/訊息持久化」的內建能力(無狀態的單次呼叫函式庫),本文件描述的整套 schema/樹狀重建/分頁/搜尋都需要自己實作。**Regenerate** = 用「被重生成訊息的 parent 路徑」重新呼叫一次 `streamText`/`Agent`,把結果存成一列「`parent_message_id` 與原 assistant 訊息相同」的新紀錄;**Edit** = 先插入一列「`parent_message_id` 與原 user 訊息相同」的新 user 訊息,再照常呼叫。

### Redis 的用途

- **標題生成的暫存快取**(`GEN_TITLE`,key `${userId}-${conversationId}`,TTL 120s)→ 原樣搬到 Redis `SET key value EX 120`,前端輪詢改成 `GET`。
- **對話存取授權記憶**(`validateConvoAccess` 的 10 分鐘快取)→ Redis,同樣的 key 形狀,搭配 RLS 當雙保險。
- **搜尋同步的分散式鎖**(`FlowStateManager`,防止多實例同時跑全量 resync)→ Redis `SET NX EX` 鎖,或如果改用 Postgres 觸發器 + 應用層 worker 消費,可用 `SELECT ... FOR UPDATE SKIP LOCKED` 取代分散式鎖的角色。
- 若仍保留獨立搜尋引擎(Meilisearch/Typesense/Elasticsearch)而非 Postgres 原生全文搜尋:建議用 Postgres 觸發器 + `pg_notify`/邏輯複製把變更寫進一個 Redis Stream/List 當 outbox 佇列,worker 消費後寫入搜尋引擎並 ack——這比 LibreChat 的「布林旗標 + 定期全量掃描」更接近真正的最終一致保證,而不是「盡力而為」。

### Next.js 前端考量

- 訊息串頁面適合 Server Component 直接查一次遞迴 CTE 拿到整棵樹的初始資料;之後的樂觀更新(送出新訊息、切換 sibling)交給 client-side React Query/SWR 快取 + `buildTree` 等價選擇器(可直接複用 LibreChat `packages/data-provider` 的 `buildTree` 實作,它是純函式、無框架依賴)。
- `/convos` 列表頁沿用 keyset 分頁(`(updated_at, pk)` 元組比較)驅動無限捲動,語意與 LibreChat 的 base64 複合游標相同,只是原生用 SQL 表達,不需要自己編碼/解碼 JSON 游標。
- 匯入/匯出/fork 可實作成 Next.js Route Handler(`app/api/convos/import/route.ts` 等),沿用與 `convos.js` 相同的「大小限制 + rate limit + multipart」防護形狀。
- **沒有直接對應者**:MeiliSearch 的 typo-tolerant 排序演算法本身沒有 Postgres 原生等價物(`tsvector`/`pg_trgm` 是不同的相關性模型)——若對搜尋體驗要求高,仍建議保留一個獨立搜尋引擎,只是同步機制換成上面提到的 CDC/outbox,而非複製 `_meiliIndex` 旗標模式。
