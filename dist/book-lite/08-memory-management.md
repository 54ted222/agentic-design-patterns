# 第 8 章:記憶管理(Memory Management)

記憶讓代理(agent)能保留並運用過往資訊,做出明智決策、維持情境並持續改善。代理記憶分兩類:

- **短期記憶(情境記憶):** 類似工作記憶,主要存在於 LLM 的情境視窗(context window),涵蓋最近的訊息、回覆、工具結果與反思。情境容量有限,管理重點是把最相關資訊保留其中(摘要舊片段、強調關鍵)。「長情境」模型只是擴大容量,情境仍是短暫的——工作階段(session)結束即遺失,且每次重新處理成本高昂,故需另一種記憶達成持久性。

- **長期記憶(持久記憶):** 跨互動、任務保留資訊的儲存庫,通常置於外部資料庫、知識圖譜或向量資料庫(vector database)。向量資料庫把資訊轉成數值向量,依語意相似度(而非關鍵字)檢索,即語意搜尋(semantic search)。代理查詢外部儲存、取出相關資料,再整合進短期情境即時使用。

## 實務應用與使用案例

記憶讓代理超越基本問答、隨時間展現智慧行為。典型應用:

- **聊天機器人與對話式 AI:** 短期記憶維持對話連貫,長期記憶回想偏好與過往討論以個人化。
- **任務導向代理:** 短期記憶追蹤步驟與進度,長期記憶存取不在當下情境中的使用者資料。
- **個人化體驗:** 以長期記憶儲存並檢索偏好與行為,調整回應與建議。
- **學習與改善:** 把成功策略、錯誤與新資訊存入長期記憶以促成調適;強化學習代理即以此儲存所學策略。
- **資訊檢索(RAG):** 以知識庫作為長期記憶,常以檢索增強生成(RAG)實作,檢索相關文件輔助回應。
- **自主系統:** 機器人或自駕車以短期記憶掌握即時周遭,以長期記憶儲存地圖、路線與學習到的行為。

## 動手實作:Google Agent Developer Kit(ADK)中的記憶管理

ADK 以三個核心概念結構化地管理情境與記憶,每次互動可視為獨特的對話執行緒:

- **Session(工作階段):** 一個獨立聊天執行緒,記錄該次互動的訊息與動作(Events),並儲存暫時性資料(State)。
- **State(`session.state`):** Session 內僅與當前聊天執行緒相關的資料。
- **Memory(記憶):** 可搜尋的資訊儲存庫,來源為過往聊天或外部資料,用於「超越當下對話」的檢索。

對應服務中,`SessionService` 管理聊天執行緒的生命週期,`MemoryService` 監管長期知識的儲存與檢索。兩者皆提供記憶體內(in-memory,適合測試但重啟不保留)與資料庫、雲端(持久且可擴展)等選項。

### Session:追蹤每一段聊天

Session 物件(`google.adk.sessions.Session`)封裝某段對話的所有資料:識別碼(`id`、`app_name`、`user_id`)、依時間排序的 Event 紀錄、暫時性 state,以及 `last_update_time` 時間戳記。

開發者通常透過 `SessionService` 間接操作 Session,由它管理對話生命週期。ADK 提供數種實作,例如適合測試但不持久的 `InMemorySessionService`。

```python
# 範例:使用 InMemorySessionService(適合本機開發與測試,資料不在重啟後保留)
from google.adk.sessions import InMemorySessionService
session_service = InMemorySessionService()
```

若要可靠儲存到自管資料庫,可使用 `DatabaseSessionService`。

```python
# 範例:使用 DatabaseSessionService(適合正式環境或需持久儲存的開發環境)
# 需設定資料庫 URL(例如 SQLite、PostgreSQL)
# 需要:pip install google-adk[sqlalchemy] 以及資料庫驅動程式(例如 PostgreSQL 的 psycopg2)
from google.adk.sessions import DatabaseSessionService
# 使用本機 SQLite 檔案的範例:
db_url = "sqlite:///./my_agent_data.db"
session_service = DatabaseSessionService(db_url=db_url)
```

`VertexAiSessionService` 則運用 Vertex AI 基礎設施,在 Google Cloud 上進行可擴展的正式部署。

```python
# 範例:使用 VertexAiSessionService(適合 GCP 上可擴展的正式環境部署)
# 需要:pip install google-adk[vertexai] 以及 GCP 的設定與身分驗證
from google.adk.sessions import VertexAiSessionService
PROJECT_ID = "your-gcp-project-id"  # 替換成你的 GCP 專案 ID
LOCATION = "us-central1"  # 替換成你想要的 GCP 位置
# 搭配此服務的 app_name 應對應 Reasoning Engine 的 ID 或名稱
REASONING_ENGINE_APP_NAME = "projects/your-gcp-project-id/locations/us-central1/reasoningEngines/your-engine-id"  # 替換成你的 Reasoning Engine 資源名稱
session_service = VertexAiSessionService(project=PROJECT_ID, location=LOCATION)
# 使用時,請把 REASONING_ENGINE_APP_NAME 傳給各方法:
# session_service.create_session(app_name=REASONING_ENGINE_APP_NAME, ...)
# session_service.get_session(app_name=REASONING_ENGINE_APP_NAME, ...)
# session_service.append_event(session, event, app_name=REASONING_ENGINE_APP_NAME)
# session_service.delete_session(app_name=REASONING_ENGINE_APP_NAME, ...)
```

`SessionService` 的選擇決定了歷史與暫時資料的儲存方式與持久性。每次訊息交換是一個循環:Runner 取得或建立 Session,代理依情境處理訊息並可能更新 state,Runner 把過程封裝成 Event,`append_event` 記錄並更新 state;互動結束時理想上以 `delete_session` 終止。

### State:Session 的暫存便條本

每個 Session 都含一個 state,類似該段對話的暫時性工作記憶。`session.events` 記錄整段歷史,`session.state` 則以字典(dictionary)的鍵值對儲存連貫對話所需的關鍵細節(偏好、任務進度、漸進蒐集的資料、條件旗標)。

State 的值為可序列化的 Python 型別(字串、數字、布林值、串列及其組成的字典),其變更的持久程度取決於所設定的 `SessionService`。鍵前綴可界定作用範圍與持久性:

- 無前綴:工作階段專屬。
- `user:`:與某使用者 ID 關聯,橫跨該使用者所有工作階段。
- `app:`:在所有使用者之間共享。
- `temp:`:僅在當前回合(turn)有效,不持久儲存。

代理透過單一 `session.state` 字典存取所有資料,由 `SessionService` 處理檢索、合併與持久化。State 應在 `append_event()` 加入 Event 時一併更新,以確保正確追蹤。

**1. 簡易做法:`output_key`(用於代理的文字回覆):** 若只想把代理最終文字回應存進 state,設定 `LlmAgent` 的 `output_key` 即可,Runner 會在附加事件時自動寫入。

```python
# 從 Google ADK 匯入必要的類別
from google.adk.agents import LlmAgent
from google.adk.sessions import InMemorySessionService, Session
from google.adk.runners import Runner
from google.genai.types import Content, Part

# 定義一個帶有 output_key 的 LlmAgent
greeting_agent = LlmAgent(
    name="Greeter",
    model="gemini-2.0-flash",
    instruction="產生一段簡短、友善的問候語。",
    output_key="last_greeting"
)

# --- 設定 Runner 與 Session ---
app_name, user_id, session_id = "state_app", "user1", "session1"
session_service = InMemorySessionService()
runner = Runner(
    agent=greeting_agent,
    app_name=app_name,
    session_service=session_service
)
session = session_service.create_session(
    app_name=app_name,
    user_id=user_id,
    session_id=session_id
)
print(f"Initial state: {session.state}")

# --- 執行代理 ---
user_message = Content(parts=[Part(text="Hello")])
print("\n--- Running the agent ---")
for event in runner.run(
    user_id=user_id,
    session_id=session_id,
    new_message=user_message
):
    if event.is_final_response():
        print("Agent responded.")

# --- 檢查更新後的 State ---
# 在 runner 處理完所有事件「之後」才檢查 state
updated_session = session_service.get_session(app_name, user_id, session_id)
print(f"\nState after agent run: {updated_session.state}")
```

幕後,Runner 看到 `output_key` 後會在 `append_event` 時自動帶入 `state_delta`。

**2. 標準做法:`EventActions.state_delta`(用於較複雜的更新):** 需同時更新多個鍵、儲存非文字資料、鎖定特定作用範圍(`user:`、`app:`),或進行與文字回覆無關的更新時,手動建構含所有變更的 `state_delta` 字典,納入所附加 Event 的 `EventActions`。

```python
import time
from google.adk.tools.tool_context import ToolContext
from google.adk.sessions import InMemorySessionService

# --- 建議採用的「以工具為基礎」的做法 ---
def log_user_login(tool_context: ToolContext) -> dict:
    """
    在使用者登入事件發生時更新工作階段狀態,封裝所有相關的狀態變更。

    Args:
        tool_context: 由 ADK 自動提供,讓我們能存取工作階段狀態。

    Returns:
        一個確認該動作成功的字典。
    """
    # 透過 context 直接存取 state
    state = tool_context.state

    # 取得目前值或預設值,接著更新 state(集中相關邏輯,寫法更乾淨)
    login_count = state.get("user:login_count", 0) + 1
    state["user:login_count"] = login_count
    state["task_status"] = "active"
    state["user:last_login_ts"] = time.time()
    state["temp:validation_needed"] = True

    print("State updated from within the `log_user_login` tool.")

    return {
        "status": "success",
        "message": f"User login tracked. Total logins: {login_count}."
    }

# --- 用法示範 ---
# 實際應用中由 LLM 代理決定呼叫此工具;此處為示範而模擬直接呼叫

# 1. 設定
session_service = InMemorySessionService()
app_name, user_id, session_id = "state_app_tool", "user3", "session3"
session = session_service.create_session(
    app_name=app_name,
    user_id=user_id,
    session_id=session_id,
    state={"user:login_count": 0, "task_status": "idle"}
)
print(f"Initial state: {session.state}")

# 2. 模擬一次工具呼叫(實際應用由 ADK Runner 執行)
#    此處為獨立範例而手動建立 ToolContext
from google.adk.tools.tool_context import InvocationContext
mock_context = ToolContext(
    invocation_context=InvocationContext(
        app_name=app_name, user_id=user_id, session_id=session_id,
        session=session, session_service=session_service
    )
)

# 3. 執行工具
log_user_login(mock_context)

# 4. 檢查更新後的 state
updated_session = session_service.get_session(app_name, user_id, session_id)
print(f"State after tool execution: {updated_session.state}")
```

此例以工具封裝狀態變更:`log_user_login` 接收 ADK 提供的 `ToolContext`,在工具內遞增 `user:login_count`、更新 `task_status`、記錄登入時間並加入暫時性旗標。相較在工具外直接操作 state,封裝在工具內讓程式碼更乾淨、更穩健。

請注意:檢索 Session 後直接修改 `session.state` 字典是強烈不建議的,因為它繞過標準事件機制——變更不會記入歷史、可能不被持久化、可能導致並行問題,也不更新中介資料。應改用 `output_key` 或 `EventActions.state_delta`,`session.state` 則主要用於讀取。

設計 state 的原則:保持簡單、使用基本型別、為鍵取清楚名稱並正確使用前綴、避免深層巢狀,並務必透過 `append_event` 流程更新。

### Memory:以 MemoryService 管理長期知識

Session 與 State 維護單一對話的歷史與暫時資料,屬短期記憶;`MemoryService` 管理的長期知識則是持久、可搜尋的儲存庫,可含多次過往互動或外部來源。

```python
# 範例:使用 InMemoryMemoryService(適合本機開發與測試)
# 應用程式停止時記憶內容即遺失,不在重啟後保留
from google.adk.memory import InMemoryMemoryService
memory_service = InMemoryMemoryService()
```

`MemoryService`(由 `BaseMemoryService` 介面定義)主要功能為:以 `add_session_to_memory` 從工作階段擷取並儲存內容,以 `search_memory` 查詢取得相關資料。`InMemoryMemoryService` 適合測試但不持久;正式環境通常採用 `VertexAiRagMemoryService`,運用 Google Cloud 的 RAG 服務達成可擴展、持久且具語意搜尋的檢索(另見第 14 章)。

```python
# 範例:使用 VertexAiRagMemoryService(適合 GCP 上可擴展的正式環境部署)
# 運用 Vertex AI RAG 達成持久、可供搜尋的記憶
# 需要:pip install google-adk[vertexai]、GCP 的設定與身分驗證,以及一個 Vertex AI RAG Corpus
from google.adk.memory import VertexAiRagMemoryService
# 你的 Vertex AI RAG Corpus 的資源名稱
RAG_CORPUS_RESOURCE_NAME = "projects/your-gcp-project-id/locations/us-central1/ragCorpora/your-corpus-id"  # 替換成你的 Corpus 資源名稱
# 檢索行為的選擇性設定
SIMILARITY_TOP_K = 5  # 要檢索的前幾筆結果數量
VECTOR_DISTANCE_THRESHOLD = 0.7  # 向量相似度的門檻
memory_service = VertexAiRagMemoryService(
    rag_corpus=RAG_CORPUS_RESOURCE_NAME,
    similarity_top_k=SIMILARITY_TOP_K,
    vector_distance_threshold=VECTOR_DISTANCE_THRESHOLD
)
# 使用時,add_session_to_memory 與 search_memory 會與指定的 RAG Corpus 互動
```

## 動手實作:LangChain 與 LangGraph 中的記憶管理

在 LangChain 與 LangGraph 中,記憶的做法是:參考所儲存的歷史豐富當前提示,再記錄最新交流供日後使用。

**短期記憶:** 以執行緒為範圍(thread-scoped),追蹤單一工作階段內的對話以提供即時情境;但完整歷史可能超出情境視窗而影響效能。LangGraph 把它作為代理 state 的一部分,透過檢查點機制(checkpointer)持久化,讓執行緒可隨時回復。

**長期記憶:** 跨工作階段儲存使用者或應用層級資料,在不同執行緒間共享,存放於自訂命名空間(namespace)。LangGraph 提供儲存庫(store)來儲存並回想,使代理能無限期保留知識。

`ChatMessageHistory`:手動記憶管理。適合在正式鏈(chain)之外直接控制對話歷史。

```python
from langchain.memory import ChatMessageHistory
# 初始化歷史物件
history = ChatMessageHistory()
# 加入使用者與 AI 的訊息
history.add_user_message("I'm heading to New York next week.")
history.add_ai_message("Great! It's a fantastic city.")
# 存取訊息串列
print(history.messages)
```

`ConversationBufferMemory`:用於鏈的自動化記憶,由兩個參數自訂:

- `memory_key`:提示中存放聊天歷史的變數名稱,預設為 `"history"`。
- `return_messages`:決定歷史格式。`False`(預設)回傳格式化字串,適合標準 LLM;`True` 回傳訊息物件串列,是聊天模型的建議格式。

```python
from langchain.memory import ConversationBufferMemory
# 初始化記憶
memory = ConversationBufferMemory()
# 儲存一輪對話
memory.save_context({"input": "What's the weather like?"}, {"output": "It's sunny today."})
# 以字串形式載入記憶
print(memory.load_memory_variables({}))
```

把記憶整合進 `LLMChain`,模型即可存取對話歷史,提供與情境相關的回應。

```python
from langchain_openai import OpenAI
from langchain.chains import LLMChain
from langchain.prompts import PromptTemplate
from langchain.memory import ConversationBufferMemory

# 1. 定義 LLM 與提示
llm = OpenAI(temperature=0)
template = """你是一位樂於助人的旅遊專員。
先前的對話:
{history}
新的問題:{question}
回應:"""
prompt = PromptTemplate.from_template(template)

# 2. 設定記憶(memory_key "history" 與提示中的變數相符)
memory = ConversationBufferMemory(memory_key="history")

# 3. 建構鏈
conversation = LLMChain(llm=llm, prompt=prompt, memory=memory)

# 4. 執行對話
response = conversation.predict(question="I want to book a flight.")
print(response)
response = conversation.predict(question="My name is Sam, by the way.")
print(response)
response = conversation.predict(question="What was my name again?")
print(response)
```

對聊天模型而言,建議設定 `return_messages=True` 使用結構化的訊息物件串列。

```python
from langchain_openai import ChatOpenAI
from langchain.chains import LLMChain
from langchain.memory import ConversationBufferMemory
from langchain_core.prompts import (
    ChatPromptTemplate,
    MessagesPlaceholder,
    SystemMessagePromptTemplate,
    HumanMessagePromptTemplate,
)

# 1. 定義聊天模型與提示
llm = ChatOpenAI()
prompt = ChatPromptTemplate(
    messages=[
        SystemMessagePromptTemplate.from_template("你是一位友善的助理。"),
        MessagesPlaceholder(variable_name="chat_history"),
        HumanMessagePromptTemplate.from_template("{question}")
    ]
)

# 2. 設定記憶(return_messages=True 對聊天模型不可或缺)
memory = ConversationBufferMemory(memory_key="chat_history", return_messages=True)

# 3. 建構鏈
conversation = LLMChain(llm=llm, prompt=prompt, memory=memory)

# 4. 執行對話
response = conversation.predict(question="Hi, I'm Jane.")
print(response)
response = conversation.predict(question="Do you remember my name?")
print(response)
```

**長期記憶的類型:** 可類比人類記憶分為三種:

- **語意記憶(Semantic Memory):記住事實。** 保留事實與概念(偏好、領域知識),為回應提供事實依據。可管理成持續更新的使用者「設定檔」(JSON)或個別事實文件的「集合」。
- **情節記憶(Episodic Memory):記住經驗。** 回想過去的事件或動作,常用來記住「如何完成某任務」;實務上常以少樣本範例提示(few-shot example prompting)實作,讓代理從過往成功序列學習。
- **程序記憶(Procedural Memory):記住規則。** 關於「如何執行任務」的核心指令與行為,通常含在系統提示中。常見技巧是「反思(Reflection)」:把當前指令與最近互動交給代理,要求它精煉自己的指令。

以下虛擬碼示範代理如何以反思更新儲存在 LangGraph `BaseStore` 中的程序記憶。

```python
# 更新代理指令的節點(node)
def update_instructions(state: State, store: BaseStore):
    namespace = ("instructions",)
    # 從 store 取得當前指令
    current_instructions = store.search(namespace)[0]
    # 建立提示,要求 LLM 對對話進行反思並生成改進過的指令
    prompt = prompt_template.format(
        instructions=current_instructions.value["instructions"],
        conversation=state["messages"]
    )
    # 從 LLM 取得新指令
    output = llm.invoke(prompt)
    new_instructions = output['new_instructions']
    # 把更新後的指令存回 store
    store.put(("agent_instructions",), "agent_a", {"instructions": new_instructions})

# 使用指令生成回應的節點
def call_model(state: State, store: BaseStore):
    namespace = ("agent_instructions", )
    # 從 store 檢索最新指令
    instructions = store.get(namespace, key="agent_a")[0]
    # 使用檢索出的指令格式化提示
    prompt = prompt_template.format(instructions=instructions.value["instructions"])
    # ... 應用程式邏輯繼續進行
```

LangGraph 把長期記憶以 JSON 文件存於 store,每則記憶組織在自訂命名空間(如資料夾)與獨特的鍵(如檔名)下。以下示範以 `InMemoryStore` 進行 put、get 與 search。

```python
from langgraph.store.memory import InMemoryStore

# 真實嵌入函式(embedding function)的佔位替身
def embed(texts: list[str]) -> list[list[float]]:
    # 實際應用請使用適當的嵌入模型
    return [[1.0, 2.0] for _ in texts]

# 初始化記憶體內 store(正式環境請使用以資料庫為後盾的 store)
store = InMemoryStore(index={"embed": embed, "dims": 2})

# 為特定使用者與應用程式情境定義命名空間
user_id = "my-user"
application_context = "chitchat"
namespace = (user_id, application_context)

# 1. 把一則記憶放入 store
store.put(
    namespace,
    "a-memory",  # 這則記憶的鍵
    {
        "rules": [
            "User likes short, direct language",
            "User only speaks English & python",
        ],
        "my-key": "my-value",
    },
)

# 2. 透過命名空間與鍵取得記憶
item = store.get(namespace, "a-memory")
print("Retrieved Item:", item)

# 3. 在命名空間中搜尋記憶,依內容過濾並依向量相似度排序
items = store.search(
    namespace,
    filter={"my-key": "my-value"},
    query="language preferences"
)
print("Search Results:", items)
```

## Vertex Memory Bank

Memory Bank 是 Vertex AI Agent Engine 中的受管理服務(managed service),為代理提供持久的長期記憶。它運用 Gemini 模型以非同步方式分析對話歷史,擷取關鍵事實與使用者偏好。

這些資訊會被持久儲存、依使用者 ID 等範圍組織,並智慧地更新以整併新資料、化解矛盾。新工作階段開始時,代理透過完整回想或嵌入向量相似度搜尋來檢索相關記憶,從而跨工作階段維持連續性並個人化回應。

代理 runner 與先初始化的 `VertexAiMemoryBankService` 互動,後者自動儲存對話產生的記憶,每則記憶標記獨特的 `USER_ID` 與 `APP_NAME` 以確保準確檢索。

```python
from google.adk.memory import VertexAiMemoryBankService
agent_engine_id = agent_engine.api_resource.name.split("/")[-1]
memory_service = VertexAiMemoryBankService(
    project="PROJECT_ID",
    location="LOCATION",
    agent_engine_id=agent_engine_id
)
session = await session_service.get_session(
    app_name=app_name,
    user_id="USER_ID",
    session_id=session.id
)
await memory_service.add_session_to_memory(session)
```

Memory Bank 與 Google ADK 無縫整合並開箱即用;對 LangGraph、CrewAI 等其他框架,也透過直接 API 呼叫提供支援。

## 重點速覽

**是什麼(What):** 代理需記住過往互動才能執行複雜任務並提供連貫體驗。沒有記憶的代理是無狀態(stateless)的,無法維持情境、學習或個人化,被侷限於一次性(one-shot)互動。核心問題是:如何同時管理「單一對話的即時暫時資訊」與「跨時間累積的龐大持久知識」。

**為什麼(Why):** 標準解法是雙元件記憶系統。短期情境記憶把最近互動保存在 LLM 情境視窗中維持對話流程;長期記憶以外部資料庫(通常是向量儲存庫)做高效語意檢索。Google ADK 等框架提供對應元件:Session、State,以及專責對接長期知識庫的 MemoryService。

**經驗法則(Rule of thumb):** 當代理需要做的不只是回答單一問題時就用此模式——須維持對話情境、追蹤多步驟任務、回想偏好與歷史以個人化,或須依過往成敗與新資訊學習調適時。

### 重點整理

- 對話式 AI 同時仰賴短期(單一聊天的即時情境)與長期(跨工作階段的持久知識)記憶。短期記憶暫時且常受限於情境視窗;長期記憶以向量資料庫等外部儲存跨聊天保存並透過搜尋存取。
- ADK 以 Session(聊天執行緒)、State(暫時聊天資料)與 MemoryService(可搜尋的長期知識)管理記憶,`SessionService` 處理工作階段的整個生命週期。
- `session.state` 是暫時資料字典,前綴(`user:`、`app:`、`temp:`)界定歸屬與留存;更新應用 `EventActions.state_delta` 或 `output_key`,而非直接修改字典。
- LangChain 的 `ConversationBufferMemory` 自動把對話歷史注入提示;LangGraph 以 store 儲存並檢索語意事實、情節經驗與可更新的程序規則,實現進階長期記憶。
- Memory Bank 是受管理服務,自動擷取、儲存並回想使用者專屬資訊,跨 ADK、LangGraph 與 CrewAI 提供個人化、連續的對話。

## 視覺摘要

![圖 1:記憶管理設計模式。使用者送出提示給代理,代理在與記憶(Memory)雙向互動後產生輸出回傳給使用者。](assets/08-memory-management/fig-1-memory-management-pattern.png)

*圖 1:記憶管理設計模式——使用者(User)送出提示(Prompt)給代理(Agent),代理與記憶(Memory)進行雙向互動,接著產生輸出(Output)回傳給使用者。*

## 結論

記憶管理區分「短暫情境」與「長期留存知識」,並決定它們如何建立與應用;Google ADK 以 Session、State 與 MemoryService 處理這項工作。下一個模式「學習與調適(Learning and Adaptation)」談代理如何依新經驗改變其思考、行動方式與所知內容。

## 參考資料

1. ADK Memory:<https://google.github.io/adk-docs/sessions/memory/>
2. LangGraph Memory:<https://langchain-ai.github.io/langgraph/concepts/memory/>
3. Vertex AI Agent Engine Memory Bank:<https://cloud.google.com/blog/products/ai-machine-learning/vertex-ai-memory-bank-in-public-preview>
