# 第 5 章:工具使用(Tool Use,函式呼叫 Function Calling)

## 工具使用模式總覽

先前討論的代理模式(串接、路由、平行化、反思)主要是在編排語言模型之間的互動與資訊流動。但要讓代理真正與真實世界或外部系統互動,就必須具備使用工具(Tool)的能力。

工具使用模式通常透過函式呼叫(Function Calling)機制實作,讓代理得以與外部 API、資料庫、服務互動,甚至執行程式碼。它讓位居核心的 LLM 能根據請求或任務狀態,自行決定何時、以及如何使用某個外部函式。流程通常包含:

1. **工具定義:** 把外部函式定義出來並向 LLM 描述其用途、名稱、參數型別與說明。
2. **LLM 決策:** LLM 依據請求與可用工具,判斷是否需要呼叫一個或多個工具。
3. **函式呼叫生成:** 若決定使用工具,LLM 生成結構化輸出(通常是 JSON),指明工具名稱與從請求中擷取出的引數。
4. **工具執行:** 編排層攔截此輸出,辨識並以提供的引數實際執行該函式。
5. **觀察/結果:** 工具執行的輸出被回傳給代理。
6. **LLM 處理(選用但常見):** LLM 以工具輸出為情境,擬定最終回應或決定下一步(再呼叫工具、反思或給出答案)。

這個模式之所以基礎,在於它打破了 LLM 訓練資料的侷限,讓它能取得最新資訊、執行內部無法完成的計算、與使用者特定資料互動,或觸發真實世界行動——正是銜接 LLM 推理能力與外部功能的技術橋樑。

比「函式呼叫」更寬廣的概念是「工具呼叫(tool calling)」:一個「工具」可以是傳統函式,也可以是複雜的 API 端點、資料庫請求,甚至是下達給另一個專門代理的指令。以此角度思考,更能完整捕捉代理作為編排者(orchestrator)的潛力——橫跨各種數位資源與智慧實體進行協作。

LangChain、LangGraph 與 Google Agent Developer Kit(ADK)等框架,為定義工具並整合進代理工作流程提供了穩健支援,通常運用 Gemini 或 OpenAI 等現代 LLM 原生的函式呼叫能力。工具使用是建構強大、可互動、具備外部感知能力之代理的基石模式。

## 實務應用與使用案例

只要代理需要超越生成文字、進而執行行動或檢索動態資訊,工具使用模式都派得上用場:

1. **從外部來源檢索資訊:** 取用訓練資料以外的即時資訊。例如天氣代理使用天氣 API——使用者問「倫敦的天氣如何?」,LLM 以「London」呼叫工具並把回傳資料整理成友善回應。
2. **與資料庫和 API 互動:** 對結構化資料查詢或更新。例如電子商務代理呼叫庫存 API 回答「商品 X 還有庫存嗎?」。
3. **執行計算與資料分析:** 使用計算機、資料分析函式庫或統計工具。例如金融代理先呼叫股票 API 取得股價,再呼叫計算機算出潛在獲利。
4. **發送通訊:** 發送電子郵件、訊息或對外部服務發 API 呼叫。例如個人助理代理以擷取出的收件人、主旨、內文呼叫電子郵件工具。
5. **執行程式碼:** 在安全環境中執行程式碼片段。例如程式設計助理代理用 code interpreter 執行並分析 Python 程式碼。
6. **控制其他系統或裝置:** 與智慧家庭、IoT 平台等互動。例如智慧家庭代理依指令呼叫工具關掉客廳的燈。

工具使用正是把語言模型從文字生成器,轉變為能在數位或實體世界中感知、推理並行動之代理的關鍵(見圖 1)。

![圖 1:代理使用工具的一些範例。](assets/05-tool-use/fig-1-agent-using-tools.png)

*圖 1:代理使用工具的一些範例。*

## 動手實作範例(LangChain)

在 LangChain 中實作工具使用分兩階段:先定義工具(通常封裝既有的 Python 函式),再把工具綁定(bind)到語言模型,使其在判斷需要外部函式時能生成結構化的工具使用請求。以下範例先定義一個模擬資訊檢索的函式,再建構並設定代理以運用此工具。執行前需安裝 LangChain 核心函式庫與模型供應商套件,並完成 API 金鑰等身分驗證。

```python
import os, getpass
import asyncio
import nest_asyncio
from typing import List
from dotenv import load_dotenv
import logging
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.tools import tool as langchain_tool
from langchain.agents import create_tool_calling_agent, AgentExecutor

# 安全地提示使用者輸入,並把 API 金鑰設為環境變數
os.environ["GOOGLE_API_KEY"] = getpass.getpass("Enter your Google API key: ")
os.environ["OPENAI_API_KEY"] = getpass.getpass("Enter your OpenAI API key: ")

try:
    # 需要一個具備函式/工具呼叫能力的模型。
    llm = ChatGoogleGenerativeAI(model="gemini-2.0-flash", temperature=0)
    print(f"✅ Language model initialized: {llm.model}")
except Exception as e:
    print(f"🛑 Error initializing language model: {e}")
    llm = None

# --- 定義一個工具 ---
@langchain_tool
def search_information(query: str) -> str:
    """
    提供關於指定主題的事實性資訊。使用此工具來尋找類似
    「法國的首都」或「倫敦的天氣?」這類問句的答案。
    """
    print(f"\n--- 🛠️ Tool Called: search_information with query: '{query}' ---")
    # 用一個含有預定義結果的字典來模擬一個搜尋工具。
    simulated_results = {
        "weather in london": "The weather in London is currently cloudy with a temperature of 15°C.",
        "capital of france": "The capital of France is Paris.",
        "population of earth": "The estimated population of Earth is around 8 billion people.",
        "tallest mountain": "Mount Everest is the tallest mountain above sea level.",
        "default": f"Simulated search result for '{query}': No specific information found, but the topic seems interesting."
    }
    result = simulated_results.get(query.lower(), simulated_results["default"])
    print(f"--- TOOL RESULT: {result} ---")
    return result

tools = [search_information]

# --- 建立一個工具呼叫代理 ---
if llm:
    # 此提示範本需要一個 `agent_scratchpad` 佔位符,用來放置代理的內部步驟。
    agent_prompt = ChatPromptTemplate.from_messages([
        ("system", "你是一個樂於助人的助理。"),
        ("human", "{input}"),
        ("placeholder", "{agent_scratchpad}"),
    ])
    # 建立代理,把 LLM、工具與提示綁定在一起。
    agent = create_tool_calling_agent(llm, tools, agent_prompt)
    # AgentExecutor 是用來呼叫代理並執行其所選工具的執行階段(runtime)。
    # 此處不需要 'tools' 引數,因為它們已綁定到代理上了。
    agent_executor = AgentExecutor(agent=agent, verbose=True, tools=tools)

async def run_agent_with_tool(query: str):
    """以查詢呼叫 agent executor 並印出最終回應。"""
    print(f"\n--- 🏃 Running Agent with Query: '{query}' ---")
    try:
        response = await agent_executor.ainvoke({"input": query})
        print("\n--- ✅ Final Agent Response ---")
        print(response["output"])
    except Exception as e:
        print(f"\n🛑 An error occurred during agent execution: {e}")

async def main():
    """平行執行所有代理查詢。"""
    tasks = [
        run_agent_with_tool("法國的首都是哪裡?"),
        run_agent_with_tool("倫敦的天氣如何?"),
        run_agent_with_tool("跟我說一些關於狗的事。")  # 應該會觸發預設的工具回應
    ]
    await asyncio.gather(*tasks)

nest_asyncio.apply()
asyncio.run(main())
```

這段程式碼以 LangChain 與 Google Gemini 設定了一個工具呼叫代理。它定義 `search_information` 工具模擬針對特定查詢提供答案(對「weather in london」等有預定義回應,其餘給預設回應),初始化具工具呼叫能力的 `ChatGoogleGenerativeAI`,並以 `ChatPromptTemplate` 引導互動。`create_tool_calling_agent` 把模型、工具與提示組成代理,`AgentExecutor` 管理執行與工具呼叫。`run_agent_with_tool` 以查詢呼叫代理並印出結果,`main` 準備多個查詢平行執行,同時測試工具的特定回應與預設回應。

## 動手實作範例(CrewAI)

此範例示範如何在 CrewAI 中實作函式呼叫:一個代理被配備了查詢資訊的工具,用來抓取模擬股價。

```python
# pip install crewai langchain-openai
import os
from crewai import Agent, Task, Crew
from crewai.tools import tool
import logging

# --- 最佳實務:設定日誌記錄 ---
# 基本的日誌設定有助於對 crew 的執行進行除錯與追蹤。
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# --- 設定你的 API 金鑰 ---
# 正式環境建議使用更安全的金鑰管理方式(執行階段載入環境變數或密鑰管理工具)。
# 為所選 LLM 供應商設定環境變數(例如 OPENAI_API_KEY)
# os.environ["OPENAI_API_KEY"] = "YOUR_API_KEY"
# os.environ["OPENAI_MODEL_NAME"] = "gpt-4o"

# --- 1. 重構後的工具:回傳乾淨的資料 ---
# 此工具回傳原始資料(float)或拋出標準 Python 錯誤,
# 更具可重用性,並迫使代理妥善處理各種結果。
@tool("Stock Price Lookup Tool")
def get_stock_price(ticker: str) -> float:
    """
    擷取指定股票代碼的最新模擬股價。以浮點數回傳該股價。
    若找不到該代碼,則拋出 ValueError。
    """
    logging.info(f"Tool Call: get_stock_price for ticker '{ticker}'")
    simulated_prices = {
        "AAPL": 178.15,
        "GOOGL": 1750.30,
        "MSFT": 425.50,
    }
    price = simulated_prices.get(ticker.upper())
    if price is not None:
        return price
    else:
        # 拋出明確的錯誤,比回傳字串更好;代理已被配備來處理例外並決定下一步。
        raise ValueError(f"Simulated price for ticker '{ticker.upper()}' not found.")

# --- 2. 定義代理 ---
# 代理定義不變,但現在會運用改良後的工具。
financial_analyst_agent = Agent(
    role='資深金融分析師',
    goal='使用提供的工具分析股票資料,並回報關鍵價格。',
    backstory="你是一位經驗豐富的金融分析師,擅長運用各種資料來源來尋找股票資訊。你會提供清楚、直接的答案。",
    verbose=True,
    tools=[get_stock_price],
    # 允許委派(delegation)可能有用,但對這個簡單的任務並非必要。
    allow_delegation=False,
)

# --- 3. 精煉後的任務:更清楚的指示與錯誤處理 ---
# 任務描述更具體,並引導代理如何回應資料檢索成功與可能發生錯誤兩種情況。
analyze_aapl_task = Task(
    description=(
        "蘋果公司(股票代碼:AAPL)目前的模擬股價是多少?"
        "請使用「Stock Price Lookup Tool」工具來查詢。"
        "如果找不到該股票代碼,你必須回報你無法取得該股價。"
    ),
    expected_output=(
        "用一句清楚的話陳述 AAPL 的模擬股價。"
        "例如:「AAPL 的模擬股價為 178.15 美元。」"
        "如果無法找到該股價,請清楚說明這一點。"
    ),
    agent=financial_analyst_agent,
)

# --- 4. 組建 Crew ---
# crew 負責編排代理與任務如何協同運作。
financial_crew = Crew(
    agents=[financial_analyst_agent],
    tasks=[analyze_aapl_task],
    verbose=True  # 在正式環境中設為 False 以減少詳細日誌
)

# --- 5. 在主執行區塊中執行 Crew ---
def main():
    """執行 crew 的主函式。"""
    # 開始前檢查 API 金鑰,以避免執行階段錯誤。
    if not os.environ.get("OPENAI_API_KEY"):
        print("ERROR: The OPENAI_API_KEY environment variable is not set.")
        print("Please set it before running the script.")
        return
    print("\n## Starting the Financial Crew...")
    print("---------------------------------")
    # kickoff 方法會啟動執行。
    result = financial_crew.kickoff()
    print("\n---------------------------------")
    print("## Crew execution finished.")
    print("\nFinal Result:\n", result)

if __name__ == "__main__":
    main()
```

這段程式碼以 CrewAI 模擬一項金融分析任務。它定義自訂工具 `get_stock_price`(有效代碼回傳 float、無效代碼拋出 `ValueError`),建立扮演資深金融分析師的 `financial_analyst_agent` 並賦予該工具,再定義 `analyze_aapl_task` 指示代理查詢 AAPL 股價並處理成功與失敗情況。隨後由代理與任務組建 Crew,在 `if __name__ == "__main__":` 區塊以 `kickoff()` 執行,啟動前先檢查 `OPENAI_API_KEY`。核心邏輯展示了如何定義工具、代理與任務,以打造協作式工作流程。

## 動手實作範例(Google ADK)

Google ADK 內建原生整合的工具函式庫,可直接納入代理能力。

**Google 搜尋:** Google Search 工具作為 Google 搜尋引擎的直接介面,讓代理能執行網路搜尋並檢索外部資訊。

```python
from google.adk.agents import Agent
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.adk.tools import google_search
from google.genai import types
import nest_asyncio
import asyncio

# 定義 Session 設定與 Agent 執行所需的變數
APP_NAME="Google Search_agent"
USER_ID="user1234"
SESSION_ID="1234"

# 定義一個可存取搜尋工具的 Agent
root_agent = ADKAgent(
    name="basic_search_agent",
    model="gemini-2.0-flash-exp",
    description="使用 Google 搜尋來回答問題的代理。",
    instruction="我可以透過搜尋網際網路來回答你的問題。儘管問我任何事吧!",
    tools=[google_search]  # Google Search 是一個用來執行 Google 搜尋的預建工具。
)

# Agent 互動
async def call_agent(query):
    """以查詢呼叫代理的輔助函式。"""
    # Session 與 Runner
    session_service = InMemorySessionService()
    session = await session_service.create_session(app_name=APP_NAME, user_id=USER_ID, session_id=SESSION_ID)
    runner = Runner(agent=root_agent, app_name=APP_NAME, session_service=session_service)
    content = types.Content(role='user', parts=[types.Part(text=query)])
    events = runner.run(user_id=USER_ID, session_id=SESSION_ID, new_message=content)
    for event in events:
        if event.is_final_response():
            final_response = event.content.parts[0].text
            print("Agent Response: ", final_response)

nest_asyncio.apply()
asyncio.run(call_agent("最新的 AI 新聞有哪些?"))
```

這段程式碼示範以 Python 版 Google ADK 建立並使用基本代理,透過 Google Search 工具回答問題。它定義常數與「basic_search_agent」代理(附描述與指示),以 `InMemorySessionService`(見第 8 章)管理工作階段,並實例化 Runner 連結代理與工作階段服務。輔助函式 `call_agent` 把查詢格式化為角色「user」的 `types.Content`,呼叫 `runner.run`,走訪回傳的事件清單找出最終回應並印出。最後以「what's the latest ai news?」實際展示代理運作。

**程式碼執行:** ADK 內建 `built_in_code_execution` 工具,為代理提供沙箱化的 Python 直譯器,讓模型撰寫並執行程式碼以進行運算、操作資料結構與執行腳本。這對需要確定性邏輯與精確計算、超出機率性語言生成能力的問題至關重要。

````python
import os, getpass
import asyncio
import nest_asyncio
from typing import List
from dotenv import load_dotenv
import logging
from google.adk.agents import Agent as ADKAgent, LlmAgent
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.adk.tools import google_search
from google.adk.code_executors import BuiltInCodeExecutor
from google.genai import types

# 定義 Session 設定與 Agent 執行所需的變數
APP_NAME="calculator"
USER_ID="user1234"
SESSION_ID="session_code_exec_async"

# 代理定義
code_agent = LlmAgent(
    name="calculator_agent",
    model="gemini-2.0-flash",
    code_executor=BuiltInCodeExecutor(),
    instruction="""你是一個計算機代理。
當收到一個數學運算式時,撰寫並執行 Python 程式碼來計算結果。
只以純文字回傳最終的數值結果,不要使用 markdown 或程式碼區塊。
""",
    description="執行 Python 程式碼以進行計算。",
)

# 代理互動(非同步)
async def call_agent_async(query):
    # Session 與 Runner
    session_service = InMemorySessionService()
    session = await session_service.create_session(app_name=APP_NAME, user_id=USER_ID, session_id=SESSION_ID)
    runner = Runner(agent=code_agent, app_name=APP_NAME, session_service=session_service)
    content = types.Content(role='user', parts=[types.Part(text=query)])
    print(f"\n--- Running Query: {query} ---")
    final_response_text = "No final text response captured."
    try:
        # 使用 run_async
        async for event in runner.run_async(user_id=USER_ID, session_id=SESSION_ID, new_message=content):
            print(f"Event ID: {event.id}, Author: {event.author}")
            # --- 先檢查特定的 parts ---
            # has_specific_part = False
            if event.content and event.content.parts and event.is_final_response():
                for part in event.content.parts:  # 走訪所有 parts
                    if part.executable_code:
                        # 透過 .code 取得實際的程式碼字串
                        print(f" Debug: Agent generated code:\n```python\n{part.executable_code.code}\n```")
                        has_specific_part = True
                    elif part.code_execution_result:
                        # 正確地取得執行結果(outcome)與輸出(output)
                        print(f" Debug: Code Execution Result: {part.code_execution_result.outcome} Output:\n{part.code_execution_result.output}")
                        has_specific_part = True
                    # 同時印出任何事件中找到的文字 part,以便除錯
                    elif part.text and not part.text.isspace():
                        print(f" Text: '{part.text.strip()}'")
                        # 此處不要設定 has_specific_part=True,因為我們想要下方的最終回應邏輯
                # --- 處理完特定 parts 之後,再檢查最終回應 ---
                text_parts = [part.text for part in event.content.parts if part.text]
                final_result = "".join(text_parts)
                print(f"==> Final Agent Response: {final_result}")
    except Exception as e:
        print(f"ERROR during agent run: {e}")
    print("-" * 30)

# 用來執行範例的主非同步函式
async def main():
    await call_agent_async("計算 (5 + 7) * 3 的值。")
    await call_agent_async("10 的階乘是多少?")

# 執行主非同步函式
try:
    nest_asyncio.apply()
    asyncio.run(main())
except RuntimeError as e:
    # 處理在已執行中的事件迴圈(如 Jupyter/Colab)裡呼叫 asyncio.run 時的特定錯誤
    if "cannot be called from a running event loop" in str(e):
        print("\nRunning in an existing event loop (like Colab/Jupyter).")
        print("Please run `await main()` in a notebook cell instead.")
        # 在 notebook 這類互動式環境中,你可能需要執行:
        # await main()
    else:
        raise e  # 重新拋出其他執行階段錯誤
````

這個腳本以 Google ADK 建立一個透過撰寫並執行 Python 程式碼解決數學問題的代理。它定義 `LlmAgent` 扮演計算機,並配備 `built_in_code_execution` 工具。主要邏輯在 `call_agent_async`:把查詢送給代理 runner,以非同步迴圈走訪事件,印出生成的程式碼與執行結果以除錯,並區分中間步驟與含數值答案的最終事件。最後 `main` 以兩個運算式展示計算能力。

**企業搜尋:** 這段程式碼以 `google.adk` 定義一個使用 `VSearchAgent` 的應用程式,透過搜尋指定的 Vertex AI Search 資料儲存庫回答問題。它初始化「q2_strategy_vsearch_agent」(附描述、模型「gemini-2.0-flash-exp」與資料儲存庫 ID,`DATASTORE_ID` 由環境變數提供),以 `InMemorySessionService` 管理歷史並設定 Runner。非同步函式 `call_vsearch_agent_async` 建構訊息、呼叫 `run_async` 並把回應串流回主控台,同時印出最終回應與來源歸屬(source attribution),並對資料儲存庫 ID 錯誤或權限缺漏提供有用訊息。主執行區塊檢查 `DATASTORE_ID` 後以 `asyncio.run` 執行,並處理已有執行中事件迴圈的環境。

```python
import asyncio
from google.genai import types
from google.adk import agents
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
import os

# --- 設定 ---
# 請確認你已設定 GOOGLE_API_KEY 與 DATASTORE_ID 環境變數,例如:
# os.environ["GOOGLE_API_KEY"] = "YOUR_API_KEY"
# os.environ["DATASTORE_ID"] = "YOUR_DATASTORE_ID"
DATASTORE_ID = os.environ.get("DATASTORE_ID")

# --- 應用程式常數 ---
APP_NAME = "vsearch_app"
USER_ID = "user_123"  # 範例使用者 ID
SESSION_ID = "session_456"  # 範例工作階段 ID

# --- 代理定義(已更新為指南中較新的模型) ---
vsearch_agent = agents.VSearchAgent(
    name="q2_strategy_vsearch_agent",
    description="使用 Vertex AI Search 回答關於第二季策略文件的問題。",
    model="gemini-2.0-flash-exp",  # 根據指南範例更新的模型
    datastore_id=DATASTORE_ID,
    model_parameters={"temperature": 0.0}
)

# --- Runner 與 Session 初始化 ---
runner = Runner(
    agent=vsearch_agent,
    app_name=APP_NAME,
    session_service=InMemorySessionService(),
)

# --- 代理呼叫邏輯 ---
async def call_vsearch_agent_async(query: str):
    """初始化工作階段並串流代理的回應。"""
    print(f"User: {query}")
    print("Agent: ", end="", flush=True)
    try:
        # 正確地建構訊息內容
        content = types.Content(role='user', parts=[types.Part(text=query)])
        # 隨著事件從非同步 runner 抵達而逐一處理
        async for event in runner.run_async(
            user_id=USER_ID,
            session_id=SESSION_ID,
            new_message=content
        ):
            # 用於回應文字的逐 token 串流
            if hasattr(event, 'content_part_delta') and event.content_part_delta:
                print(event.content_part_delta.text, end="", flush=True)
            # 處理最終回應及其相關的中繼資料
            if event.is_final_response():
                print()  # 串流回應之後換行
                if event.grounding_metadata:
                    print(f" (Source Attributions: {len(event.grounding_metadata.grounding_attributions)} sources found)")
                else:
                    print(" (No grounding metadata found)")
                print("-" * 30)
    except Exception as e:
        print(f"\nAn error occurred: {e}")
        print("Please ensure your datastore ID is correct and that the service account has the necessary permissions.")
        print("-" * 30)

# --- 執行範例 ---
async def run_vsearch_example():
    # 請替換成與「你的」資料儲存庫內容相關的問題
    await call_vsearch_agent_async("摘要說明第二季策略文件的主要重點。")
    await call_vsearch_agent_async("文件中針對實驗室 X 提到了哪些安全程序?")

# --- 執行 ---
if __name__ == "__main__":
    if not DATASTORE_ID:
        print("Error: DATASTORE_ID environment variable is not set.")
    else:
        try:
            asyncio.run(run_vsearch_example())
        except RuntimeError as e:
            # 處理在已有執行中事件迴圈的環境(如 Jupyter notebook)裡呼叫 asyncio.run 的情況。
            if "cannot be called from a running event loop" in str(e):
                print("Skipping execution in a running event loop. Please run this script directly.")
            else:
                raise e
```

整體而言,這段程式碼為對話式 AI 應用提供了基本框架,運用 Vertex AI Search 根據資料儲存庫中的資訊回答問題,示範了如何定義代理、設定 runner,並以非同步方式串流互動,重點在於從特定資料儲存庫檢索並綜整資訊。

**Vertex 擴充功能(Vertex Extensions):** 這是一個結構化的 API 包裝器,讓模型連接外部 API 以進行即時資料處理與行動執行,並提供企業級的安全性、資料隱私與效能保證。它可用於生成並執行程式碼、查詢網站、分析私有資料儲存庫等。Google 為 Code Interpreter、Vertex AI Search 等常見案例提供預建擴充功能,也支援自訂。與函式呼叫的關鍵差異在於執行方式:Vertex AI 會「自動」執行擴充功能,而函式呼叫需由使用者或客戶端「手動」執行。

## 重點速覽

**是什麼(What):** LLM 是強大的文字生成器,但本質上與外部世界脫節——知識靜態、僅限訓練資料,且缺乏執行行動或檢索即時資訊的能力。少了通往外部 API、資料庫或服務的橋樑,它在解決真實世界問題上的效用嚴重受限。

**為什麼(Why):** 工具使用模式(通常以函式呼叫實作)提供標準化解法:以 LLM 能理解的方式描述可用的外部「工具」,代理便能依請求判斷是否需要工具,並生成結構化物件(如 JSON)指明要呼叫哪個函式與引數;編排層執行該呼叫、檢索結果再回饋給 LLM,使其能把外部資訊或行動結果整合進最終回應,有效賦予它行動的能力。

**經驗法則(Rule of thumb):** 每當代理需要跳脫 LLM 內部知識、與外部世界互動時就使用本模式。對需要即時資料(天氣、股價)、私有/專屬資訊(公司資料庫)、精確計算、執行程式碼,或觸發行動(發送電子郵件、控制智慧裝置)的任務不可或缺。

**重點整理:**

- 工具使用(函式呼叫)讓代理與外部系統互動並取用動態資訊。
- 它涉及定義工具,並附上 LLM 能理解的清楚描述與參數。
- 由 LLM 決定何時使用工具並生成結構化的函式呼叫;由代理框架實際執行並把結果回傳給 LLM。
- 對於建構能執行真實世界行動、提供最新資訊的代理而言不可或缺。
- LangChain 以 `@tool` 裝飾器簡化工具定義,並提供 `create_tool_calling_agent` 與 `AgentExecutor`。
- Google ADK 擁有許多預建工具,例如 Google Search、Code Execution 與 Vertex AI Search。

**視覺摘要:**

![圖 2:工具使用設計模式。](assets/05-tool-use/fig-2-tool-use-pattern.png)

*圖 2:工具使用設計模式。*

## 結論

工具使用模式是一項關鍵架構原則,把 LLM 的功能擴展到與生俱來的文字生成之外。藉由賦予模型對接外部軟體與資料來源的能力,代理得以執行行動、進行運算並從其他系統檢索資訊——模型在判斷有必要時生成結構化請求來呼叫工具。LangChain、Google ADK 與 CrewAI 等框架提供了整合外部工具的結構化抽象與元件,負責「向模型揭露工具規格」與「解析模型發出之工具使用請求」,從而簡化了能與外部數位環境互動並採取行動之精密代理系統的開發。

## 參考資料

1. LangChain Documentation(Tools):
   <https://python.langchain.com/docs/integrations/tools/>
2. Google Agent Developer Kit(ADK)Documentation(Tools):
   <https://google.github.io/adk-docs/tools/>
3. OpenAI Function Calling Documentation:
   <https://platform.openai.com/docs/guides/function-calling>
4. CrewAI Documentation(Tools): <https://docs.crewai.com/concepts/tools>
