# 第 2 章:路由(Routing)

## 路由模式總覽

提示鏈(Prompt Chaining)的循序處理適合確定性、線性的工作流程,但難以應付需要適應性的情境。真實世界的代理系統(agentic system)往往要依環境狀態、使用者輸入或前一步結果,在多種行動間做出裁決。這種動態決策能力,就靠**路由(Routing)**達成。

路由為代理引入條件邏輯(conditional logic),讓系統從固定路徑轉為「動態評估條件、再從多個後續行動中擇一」,展現更靈活、更具情境感知的行為。以客服查詢代理為例,它可先分類查詢以判定意圖,再據此導引:

1. 分析使用者的查詢。
2. 根據其意圖路由:
   - 「查詢訂單狀態」→ 導向與訂單資料庫互動的子代理或工具鏈。
   - 「產品資訊」→ 導向搜尋產品型錄的子代理或鏈。
   - 「技術支援」→ 導向疑難排解指南,或升級給真人。
   - 意圖不明確 → 導向負責釐清的子代理或提示鏈。

路由的核心是一個「執行評估並導引流程」的機制,常見實作方式有四種:

- **以 LLM 為基礎的路由:** 提示 LLM 分析輸入,輸出一個識別字以指出目的地。例如要求 LLM「分析查詢並只輸出類別:『Order Status』、『Product Info』、『Technical Support』或『Other』」,系統再據此導引流程。
- **以嵌入為基礎的路由:** 把查詢轉為向量嵌入(vector embedding,見第 14 章 RAG),與代表各路由的嵌入比相似度,導向最相似者。適用於依「意義」而非關鍵字決策的語意路由(semantic routing)。
- **以規則為基礎的路由:** 用預先定義的規則(if-else、switch case),依關鍵字、模式或結構化資料判斷。比 LLM 路由更快、更具確定性,但對細膩或新穎輸入較不靈活。
- **以機器學習模型為基礎的路由:** 採用經監督式微調(supervised fine-tuning)的判別式模型(如分類器),路由邏輯編碼在權重中。與 LLM 路由的關鍵差異:決策不靠推論時執行提示的生成式模型;LLM 至多用於前處理(如生成合成訓練資料),不參與即時決策。

路由可置於代理運作週期的多個節點:一開始分類主要任務、處理鏈中間判定後續行動,或在子程序中選出最合適的工具。LangChain、LangGraph 與 Google 的 Agent Development Kit(ADK)都提供建構元件來管理這類條件邏輯;其中 LangGraph 以狀態為基礎的圖架構,特別適合「決策取決於系統累積狀態」的複雜情境。

## 實務應用與使用案例

路由是設計適應性代理的關鍵控制機制,透過一層條件邏輯,讓系統因應多變輸入與內部狀態動態改變執行路徑,效用橫跨多個領域:

- **人機互動**(虛擬助理、AI 家教):解讀使用者意圖,判定後續行動——呼叫特定檢索工具、升級給真人,或挑選下一個學習模組,使系統超越線性對話。
- **資料與文件處理管線:** 對郵件、支援工單或 API 載荷(payload),依內容、中繼資料(metadata)或格式分類,再分派到對應工作流程,例如潛在客戶匯入、特定格式轉換或緊急問題升級。
- **多工具/多代理的複雜系統:** 路由扮演高階分派器(high-level dispatcher)。研究系統用它把任務指派給搜尋、摘要、分析等代理;AI 編碼助理用它辨識程式語言與意圖(除錯、解釋或翻譯),再交給正確的工具。

歸根究柢,路由把代理從「預定序列的靜態執行者」,轉變為「能在變動條件下選擇最有效方法的動態系統」。

## 動手實作範例(LangChain)

以下用 LangChain 與 Google Generative AI 建立一個簡易類代理系統:一個「協調者(coordinator)」依請求意圖(訂位、資訊查詢或不明確),把請求路由到不同的模擬「子代理」處理常式,展現多代理架構常見的委派模式。

首先安裝必要的函式庫,並為所選模型(OpenAI、Google Gemini 或 Anthropic)設定好環境中的 API 金鑰:

```bash
pip install langchain langgraph google-cloud-aiplatform langchain-google-genai google-adk deprecated pydantic
```

```python
# Copyright (c) 2025 Marco Fago
# https://www.linkedin.com/in/marco-fago/
#
# 本程式碼以 MIT 授權釋出,完整授權條款見 repository 中的 LICENSE 檔案。
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser
from langchain_core.runnables import RunnablePassthrough, RunnableBranch

# --- 設定 ---
# 確認已設定 API 金鑰環境變數(例如 GOOGLE_API_KEY)
try:
    llm = ChatGoogleGenerativeAI(model="gemini-2.5-flash", temperature=0)
    print(f"語言模型已初始化:{llm.model}")
except Exception as e:
    print(f"初始化語言模型時發生錯誤:{e}")
    llm = None

# --- 定義模擬的子代理處理常式(相當於 ADK 的 sub_agents) ---
def booking_handler(request: str) -> str:
    """模擬 Booking 代理處理請求。"""
    print("\n--- 委派給 BOOKING 處理常式 ---")
    return f"Booking 處理常式已處理請求:'{request}'。結果:模擬的訂位動作。"

def info_handler(request: str) -> str:
    """模擬 Info 代理處理請求。"""
    print("\n--- 委派給 INFO 處理常式 ---")
    return f"Info 處理常式已處理請求:'{request}'。結果:模擬的資訊擷取。"

def unclear_handler(request: str) -> str:
    """處理無法委派的請求。"""
    print("\n--- 處理不明確的請求 ---")
    return f"協調者無法委派請求:'{request}'。請進一步釐清。"

# --- 定義協調者路由鏈(相當於 ADK 協調者的指令) ---
# 此鏈決定要委派給哪個處理常式。
coordinator_router_prompt = ChatPromptTemplate.from_messages([
    ("system", """分析使用者的請求,判斷應由哪一個專門處理常式來處理。
- 若請求與訂機票或飯店有關,輸出 'booker'。
- 對於其他所有一般資訊問題,輸出 'info'。
- 若請求不明確或不屬於上述任一類別,輸出 'unclear'。
只輸出一個字:'booker'、'info' 或 'unclear'。"""),
    ("user", "{request}")
])

if llm:
    coordinator_router_chain = coordinator_router_prompt | llm | StrOutputParser()

# --- 定義委派邏輯(相當於 ADK 基於 sub_agents 的 Auto-Flow) ---
# 用 RunnableBranch 依路由鏈的輸出進行路由。

# 定義 RunnableBranch 的各個分支
branches = {
    "booker": RunnablePassthrough.assign(output=lambda x: booking_handler(x['request']['request'])),
    "info": RunnablePassthrough.assign(output=lambda x: info_handler(x['request']['request'])),
    "unclear": RunnablePassthrough.assign(output=lambda x: unclear_handler(x['request']['request'])),
}

# 建立 RunnableBranch:取路由鏈的輸出,把原始輸入('request')導向對應處理常式。
delegation_branch = RunnableBranch(
    (lambda x: x['decision'].strip() == 'booker', branches["booker"]),  # 加上 .strip()
    (lambda x: x['decision'].strip() == 'info', branches["info"]),      # 加上 .strip()
    branches["unclear"]  # 'unclear' 或其他輸出的預設分支
)

# 把路由鏈與委派分支組合成單一 runnable
# 路由鏈的輸出('decision')會連同原始輸入('request')一起傳給 delegation_branch。
coordinator_agent = {
    "decision": coordinator_router_chain,
    "request": RunnablePassthrough()
} | delegation_branch | (lambda x: x['output'])  # 擷取最終輸出

# --- 使用範例 ---
def main():
    if not llm:
        print("\n因 LLM 初始化失敗,略過執行。")
        return

    print("--- 執行訂位請求 ---")
    request_a = "幫我訂一張飛往倫敦的機票。"
    result_a = coordinator_agent.invoke({"request": request_a})
    print(f"最終結果 A:{result_a}")

    print("\n--- 執行資訊請求 ---")
    request_b = "義大利的首都是哪裡?"
    result_b = coordinator_agent.invoke({"request": request_b})
    print(f"最終結果 B:{result_b}")

    print("\n--- 執行不明確的請求 ---")
    request_c = "跟我說說量子物理。"
    result_c = coordinator_agent.invoke({"request": request_c})
    print(f"最終結果 C:{result_c}")

if __name__ == "__main__":
    main()
```

程式碼定義三個模擬處理常式,核心是 `coordinator_router_chain`:用 `ChatPromptTemplate` 指示 LLM 把請求歸類為『booker』、『info』或『unclear』,其輸出由 `RunnableBranch` 委派給對應函式。`coordinator_agent` 把元件串起:先取決策,再傳請求給選定處理常式並擷取輸出。`main` 以三個請求示範路由,並含初始化錯誤處理,整體模擬「中央協調者依意圖委派任務」的基本多代理框架。

## 動手實作範例(Google ADK)

不同於以運算圖為基礎的架構,ADK 範式中的路由通常透過定義一組離散的「工具(tools)」實作;對工具的選擇由框架內部邏輯運用底層模型,把使用者意圖對應到正確的處理常式。以下範例建立一個「Coordinator」代理,依指令把請求路由到專門子代理(處理訂位的「Booker」與處理一般資訊的「Info」),子代理再用特定工具模擬處理。

```python
# Copyright (c) 2025 Marco Fago
#
# 本程式碼以 MIT 授權釋出,完整授權條款見 repository 中的 LICENSE 檔案。
import uuid
from typing import Dict, Any, Optional
from google.adk.agents import Agent
from google.adk.runners import InMemoryRunner
from google.adk.tools import FunctionTool
from google.genai import types
from google.adk.events import Event

# --- 定義工具函式 ---
# 這些函式模擬專門代理的動作。
def booking_handler(request: str) -> str:
    """
    處理機票與飯店的訂位請求。
    Args:
        request: 使用者的訂位請求。
    Returns:
        確認訂位已處理的訊息。
    """
    print("-------------------------- 呼叫 Booking 處理常式 ----------------------------")
    return f"已模擬針對 '{request}' 的訂位動作。"

def info_handler(request: str) -> str:
    """
    處理一般資訊請求。
    Args:
        request: 使用者的問題。
    Returns:
        表示資訊請求已處理的訊息。
    """
    print("-------------------------- 呼叫 Info 處理常式 ----------------------------")
    return f"針對 '{request}' 的資訊請求。結果:模擬的資訊擷取。"

def unclear_handler(request: str) -> str:
    """處理無法委派的請求。"""
    return f"協調者無法委派請求:'{request}'。請進一步釐清。"

# --- 從函式建立工具 ---
booking_tool = FunctionTool(booking_handler)
info_tool = FunctionTool(info_handler)

# 定義各自配備工具的專門子代理
booking_agent = Agent(
    name="Booker",
    model="gemini-2.0-flash",
    description="一個專門的代理,透過呼叫訂位工具來處理所有機票與飯店的訂位請求。",
    tools=[booking_tool]
)

info_agent = Agent(
    name="Info",
    model="gemini-2.0-flash",
    description="一個專門的代理,透過呼叫資訊工具來提供一般資訊並回答使用者的問題。",
    tools=[info_tool]
)

# 定義帶有明確委派指令的父代理
coordinator = Agent(
    name="Coordinator",
    model="gemini-2.0-flash",
    instruction=(
        "你是主要的協調者。你唯一的任務是分析傳入的使用者請求,"
        "並把它們委派給適當的專門代理。不要試圖直接回答使用者。\n"
        "- 對於任何與訂機票或飯店有關的請求,委派給 'Booker' 代理。\n"
        "- 對於其他所有一般資訊問題,委派給 'Info' 代理。"
    ),
    description="一個協調者,將使用者請求路由到正確的專門代理。",
    # 定義了 sub_agents 即預設啟用 LLM 驅動的委派(Auto-Flow)。
    sub_agents=[booking_agent, info_agent]
)

# --- 執行邏輯 ---
async def run_coordinator(runner: InMemoryRunner, request: str):
    """以給定請求執行協調者代理並進行委派。"""
    print(f"\n--- 以請求執行協調者:'{request}' ---")
    final_result = ""
    try:
        user_id = "user_123"
        session_id = str(uuid.uuid4())
        await runner.session_service.create_session(
            app_name=runner.app_name, user_id=user_id, session_id=session_id
        )

        for event in runner.run(
            user_id=user_id,
            session_id=session_id,
            new_message=types.Content(
                role='user',
                parts=[types.Part(text=request)]
            ),
        ):
            if event.is_final_response() and event.content:
                # 優先直接從 event.content 取得文字,避免逐一走訪 parts
                if hasattr(event.content, 'text') and event.content.text:
                    final_result = event.content.text
                elif event.content.parts:
                    # 後備方案:走訪 parts 擷取文字(可能觸發警告)
                    text_parts = [part.text for part in event.content.parts if part.text]
                    final_result = "".join(text_parts)
                # 取得最終回應後即跳出迴圈
                break

        print(f"協調者最終回應:{final_result}")
        return final_result
    except Exception as e:
        print(f"處理請求時發生錯誤:{e}")
        return f"處理請求時發生錯誤:{e}"

async def main():
    """執行 ADK 範例的主函式。"""
    print("--- Google ADK 路由範例(ADK Auto-Flow 風格) ---")
    print("注意:需先安裝 Google ADK 並完成驗證。")
    runner = InMemoryRunner(coordinator)

    # 使用範例
    result_a = await run_coordinator(runner, "幫我在巴黎訂一間飯店。")
    print(f"最終輸出 A:{result_a}")

    result_b = await run_coordinator(runner, "世界上最高的山是哪一座?")
    print(f"最終輸出 B:{result_b}")

    result_c = await run_coordinator(runner, "跟我說一個隨機的冷知識。")  # 應導向 Info
    print(f"最終輸出 C:{result_c}")

    result_d = await run_coordinator(runner, "查詢下個月飛往東京的航班。")  # 應導向 Booker
    print(f"最終輸出 D:{result_d}")

if __name__ == "__main__":
    import nest_asyncio
    nest_asyncio.apply()
    await main()
```

此腳本由一個 Coordinator 與兩個子代理(`sub_agents`)Booker、Info 組成,每個子代理配備一個包裝模擬動作函式的 `FunctionTool`。`unclear_handler` 作為後備,但目前 `run_coordinator` 並未在委派失敗時明確使用它。由於 Coordinator 定義了 `sub_agents`,委派由 ADK 的 Auto-Flow 自動處理:`run_coordinator` 建立 `InMemoryRunner` 與 session,透過 `runner.run` 處理請求並產出事件,再從 `event.content` 擷取最終回應。

## 重點速覽

**是什麼(What):** 代理系統往往要回應無法靠單一線性流程處理的多樣輸入。單純的循序工作流程無法依情境決策、為特定任務選擇正確工具或子流程,因而僵化、難以駕馭真實世界請求的複雜與多變。

**為什麼(Why):** 路由為代理引入條件邏輯,讓系統先分析查詢判定意圖,再動態把控制流程導向最適切的工具、函式或子代理。決策可由提示 LLM、預先定義的規則,或以嵌入為基礎的語意相似度驅動。它把靜態的執行路徑,轉為靈活、具情境感知、能選擇最佳行動的工作流程。

**經驗法則(Rule of thumb):** 當代理必須依使用者輸入或當前狀態,在多個工作流程、工具或子代理之間做抉擇時,就用路由。對需要分流(triage)或分類請求的應用尤其關鍵——例如能區分業務諮詢、技術支援與帳戶管理的客服機器人。

## 視覺摘要

![圖 1:路由器模式,使用一個 LLM 作為路由器。](assets/02-routing/fig-1-router-pattern.png)

*圖 1:路由器(Router)模式——使用一個 LLM 作為路由器。*

## 結論

路由是建構動態、具回應能力之代理系統的關鍵一步,讓代理能就「如何處理資訊、回應輸入、運用工具或子代理」做出明智決策,應用範圍從客服聊天機器人到複雜的資料處理管線。其決策邏輯可用 LLM、規則或嵌入相似度實作,藉此處理多樣輸入並調整行為,超越線性執行。

本章兩個範例展現兩種有效途徑:LangGraph 以圖為基礎的結構提供視覺化、明確的狀態與轉換定義,適合錯綜的多步驟工作流程;Google ADK 則著重定義各項能力(工具),仰賴框架把請求路由到適當工具,對擁有一組明確離散動作的代理更為簡單。精通路由模式,是打造多功能且穩健之代理應用的關鍵。

## 參考資料

1. LangGraph Documentation: <https://www.langchain.com/>
2. Google Agent Development Kit Documentation: <https://google.github.io/adk-docs/>
