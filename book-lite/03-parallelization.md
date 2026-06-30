# 第 3 章:平行化(Parallelization)

## 平行化模式總覽

提示鏈(Prompt Chaining)用於循序流程、路由(Routing)用於動態切換路徑;但許多代理(agentic)任務其實包含可同時執行的多個子任務,這正是平行化(Parallelization)的價值所在。

平行化是同時(concurrently)執行多個元件,例如 LLM 呼叫、工具使用,甚至整個子代理(sub-agent)(見圖 1)。彼此獨立的任務不必依序等待,因此對於可拆解成多個獨立部分的任務,能大幅縮短整體執行時間——尤其在與具延遲(latency)的外部服務(API、資料庫)互動時,可同時發出多個請求。

以「研究某主題並摘要」的代理為例:循序做法是搜尋來源 A → 摘要 A → 搜尋來源 B → 摘要 B → 綜整;平行做法則是同時搜尋 A 與 B、再同時摘要 A 與 B,最後綜整(綜整這一步通常仍是循序,需等平行步驟完成)。核心理念就是找出工作流程中不依賴其他輸出的環節並平行化。

實作上通常需要支援非同步(asynchronous)或多執行緒/多行程的框架,而現代代理框架多半已內建非同步設計。

![圖 1:使用子代理進行平行化的範例。](assets/03-parallelization/fig-1-parallelization-sub-agents.png)

*圖 1:使用子代理進行平行化的範例。*

LangChain、LangGraph 與 Google ADK 都提供平行執行機制:在 LangChain 表達式語言(LCEL)中,可用運算子(如代表循序的 `|`)組合可執行(runnable)物件並建構出同時執行的分支;LangGraph 憑藉圖(graph)結構,讓單一狀態轉移觸發多個節點以啟用平行分支;Google ADK 則提供原生機制管理代理的平行執行,提升複雜多代理系統的效率與可擴展性。此模式是最佳化複雜代理工作流程效能的關鍵技術。

## 實務應用與使用案例

平行化可在多種應用中最佳化代理效能:

**1. 資訊蒐集與研究:** 研究某公司的代理,可同時搜尋新聞、拉取股價、檢查社群媒體提及並查詢公司資料庫,比循序查詢更快獲得全面視野。

**2. 資料處理與分析:** 分析顧客回饋的代理,可對一批回饋同時執行情緒分析、擷取關鍵字、分類並找出緊急問題,迅速提供多面向分析。

**3. 多 API 或工具互動:** 旅遊規劃代理可同時查機票、搜尋飯店空房、查找當地活動與餐廳推薦,更快呈現完整計畫。

**4. 具多個元件的內容生成:** 撰寫行銷郵件的代理,可同時生成主旨列、草擬內文、尋找圖片與撰寫行動呼籲(call-to-action)文字。

**5. 驗證與查核:** 驗證使用者輸入的代理,可同時檢查電子郵件格式、驗證電話號碼、核對地址並檢查不雅字眼,更快回饋有效性。

**6. 多模態處理:** 分析含文字與影像之貼文的代理,可同時對文字做情緒/關鍵字分析、對影像做物件/場景描述,更快整合多模態洞見。

**7. A/B 測試或多選項生成:** 生成創意文案的代理,可用略有差異的提示或模型同時為文章生成三個標題,以便快速比較選優。

平行化是代理設計中的基礎最佳化技術,藉由對獨立任務同時執行,建構出效能更高、回應更靈敏的應用。

## 動手實作範例(LangChain)

在 LangChain 中,平行執行透過 LCEL 達成:把多個可執行元件組織在字典或清單結構中,當它被當作輸入傳給後續元件時,LCEL 執行階段便會同時執行其中的可執行物件。在 LangGraph 中,則是把圖架構成讓多個無直接循序依賴的節點從單一共同節點觸發,各自獨立執行直到在後續匯流點(convergence point)彙整。

以下範例以 LangChain 建構平行工作流程:回應單一查詢時同時執行兩項以上彼此獨立的操作,再把各自輸出彙整為統一結果。先決條件包括安裝 `langchain`、`langchain-community` 及模型供應商函式庫(如 `langchain-openai`),並在本機設定有效的 API 金鑰。

```python
import os
import asyncio
from typing import Optional
from langchain_openai import ChatOpenAI
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser
from langchain_core.runnables import Runnable, RunnableParallel, RunnablePassthrough

# --- 設定 ---
# 請確認你的 API 金鑰環境變數已設定(例如 OPENAI_API_KEY)
try:
    llm: Optional[ChatOpenAI] = ChatOpenAI(model="gpt-4o-mini", temperature=0.7)
except Exception as e:
    print(f"Error initializing language model: {e}")
    llm = None

# --- 定義彼此獨立的鏈 ---
# 這三條鏈代表可以平行執行的不同任務。
summarize_chain: Runnable = (
    ChatPromptTemplate.from_messages([
        ("system", "請精簡地摘要以下主題:"),
        ("user", "{topic}")
    ])
    | llm
    | StrOutputParser()
)

questions_chain: Runnable = (
    ChatPromptTemplate.from_messages([
        ("system", "請針對以下主題生成三個有趣的問題:"),
        ("user", "{topic}")
    ])
    | llm
    | StrOutputParser()
)

terms_chain: Runnable = (
    ChatPromptTemplate.from_messages([
        ("system", "請從以下主題中辨識出 5 到 10 個關鍵詞,並以逗號分隔:"),
        ("user", "{topic}")
    ])
    | llm
    | StrOutputParser()
)

# --- 建構「平行 + 綜整」鏈 ---
# 1. 定義要平行執行的任務區塊;這些結果連同原始 topic 一起餵入下一步。
map_chain = RunnableParallel(
    {
        "summary": summarize_chain,
        "questions": questions_chain,
        "key_terms": terms_chain,
        "topic": RunnablePassthrough(),  # 把原始 topic 直接傳遞下去
    }
)

# 2. 定義最終的綜整提示,用來組合平行的各項結果。
synthesis_prompt = ChatPromptTemplate.from_messages([
    ("system", """根據以下資訊:
摘要:{summary}
相關問題:{questions}
關鍵詞:{key_terms}
綜整出一個全面的答案。"""),
    ("user", "原始主題:{topic}")
])

# 3. 把平行結果導入綜整提示,接著串上 LLM 與輸出解析器,建構完整的鏈。
full_parallel_chain = map_chain | synthesis_prompt | llm | StrOutputParser()

# --- 執行鏈 ---
async def run_parallel_example(topic: str) -> None:
    """
    以特定主題非同步地呼叫平行處理鏈,並印出綜整後的結果。

    Args:
        topic: 要交由 LangChain 鏈處理的輸入主題。
    """
    if not llm:
        print("LLM not initialized. Cannot run example.")
        return

    print(f"\n--- Running Parallel LangChain Example for Topic: '{topic}' ---")
    try:
        # `ainvoke` 的輸入是單一 'topic' 字串,會傳給 map_chain 中的每個可執行物件。
        response = await full_parallel_chain.ainvoke(topic)
        print("\n--- Final Response ---")
        print(response)
    except Exception as e:
        print(f"\nAn error occurred during chain execution: {e}")

if __name__ == "__main__":
    test_topic = "太空探索的歷史"
    # 在 Python 3.7+ 中,asyncio.run 是執行非同步函式的標準做法。
    asyncio.run(run_parallel_example(test_topic))
```

請注意,asyncio 提供的是並行(concurrency)而非平行(parallelism):它在單一執行緒上透過事件迴圈(event loop)運作——當某任務閒置(如等待網路請求)時切換到其他任務,營造同時推進的效果,但仍受限於 Python 的全域直譯器鎖(GIL)。

程式碼先初始化一個 `ChatOpenAI`(gpt-4o-mini)實例,並用 try-except 增加穩健性;接著定義三條獨立的鏈,各自摘要主題、生成三個相關問題、辨識 5 到 10 個關鍵詞,每條鏈都由 `ChatPromptTemplate` 接 LLM 再接 `StrOutputParser` 組成。`RunnableParallel` 把三條鏈綑綁同時執行,並以 `RunnablePassthrough` 保留原始主題供後續使用;最後的綜整 `ChatPromptTemplate` 以摘要、問題、關鍵詞與原始主題為輸入,生成全面答案。端到端的 `full_parallel_chain` 即由 `map_chain` 接綜整提示、LLM 與輸出解析器而成,並透過非同步函式 `run_parallel_example` 以 `asyncio.run` 執行。本質上,這建立了一個讓多個 LLM 呼叫(摘要、問題、關鍵詞)同時發生、再由最後一次呼叫組合的工作流程,展現了 LangChain 平行化的核心理念。

## 動手實作範例(Google ADK)

接著以 Google ADK 為例,運用 `ParallelAgent` 與 `SequentialAgent` 等基本元件(primitive),建構善用同時執行以提升效率的代理流程。

```python
from google.adk.agents import LlmAgent, ParallelAgent, SequentialAgent
from google.adk.tools import google_search

GEMINI_MODEL="gemini-2.0-flash"

# --- 1. 定義研究員子代理(將平行執行)---

# 研究員 1:再生能源
researcher_agent_1 = LlmAgent(
    name="RenewableEnergyResearcher",
    model=GEMINI_MODEL,
    instruction="""你是一位專精於能源領域的 AI 研究助理。
請研究「再生能源來源」的最新進展。
請使用所提供的 Google 搜尋工具。
請精簡地(1 到 2 句)摘要你的關鍵發現。
只輸出摘要本身。
""",
    description="研究再生能源來源。",
    tools=[google_search],
    # 把結果存入 state,供 merger 代理使用
    output_key="renewable_energy_result"
)

# 研究員 2:電動車
researcher_agent_2 = LlmAgent(
    name="EVResearcher",
    model=GEMINI_MODEL,
    instruction="""你是一位專精於交通運輸領域的 AI 研究助理。
請研究「電動車技術」的最新發展。
請使用所提供的 Google 搜尋工具。
請精簡地(1 到 2 句)摘要你的關鍵發現。
只輸出摘要本身。
""",
    description="研究電動車技術。",
    tools=[google_search],
    # 把結果存入 state,供 merger 代理使用
    output_key="ev_technology_result"
)

# 研究員 3:碳捕捉
researcher_agent_3 = LlmAgent(
    name="CarbonCaptureResearcher",
    model=GEMINI_MODEL,
    instruction="""你是一位專精於氣候解決方案的 AI 研究助理。
請研究「碳捕捉方法」的現況。
請使用所提供的 Google 搜尋工具。
請精簡地(1 到 2 句)摘要你的關鍵發現。
只輸出摘要本身。
""",
    description="研究碳捕捉方法。",
    tools=[google_search],
    # 把結果存入 state,供 merger 代理使用
    output_key="carbon_capture_result"
)

# --- 2. 建立 ParallelAgent(讓研究員們同時執行)---
# 協調研究員的同時執行;一旦所有研究員都完成並把結果存入 state 便結束。
parallel_research_agent = ParallelAgent(
    name="ParallelWebResearchAgent",
    sub_agents=[researcher_agent_1, researcher_agent_2, researcher_agent_3],
    description="平行執行多個研究代理以蒐集資訊。"
)

# --- 3. 定義 Merger 代理(在平行代理之*後*執行)---
# 接收平行代理存入 session state 的結果,綜整成單一、結構化、附帶出處的回應。
merger_agent = LlmAgent(
    name="SynthesisAgent",
    model=GEMINI_MODEL,  # 若綜整需要,也可改用更強大的模型
    instruction="""你是一位負責將研究發現組合成結構化報告的 AI 助理。

你的主要任務是綜整以下這些研究摘要,並清楚地將各項發現歸屬到其來源領域。請為每個主題使用標題來組織你的回應。確保報告連貫,並順暢地整合各項重點。

**至關重要:你的整份回應「必須」「僅」以下方「輸入摘要」中所提供的資訊為依據。請勿加入任何未出現在這些特定摘要中的外部知識、事實或細節。**

**輸入摘要:**

*   **再生能源:**
    {renewable_energy_result}

*   **電動車:**
    {ev_technology_result}

*   **碳捕捉:**
    {carbon_capture_result}

**輸出格式:**

## 近期永續科技進展摘要

### 再生能源發現
(依據 RenewableEnergyResearcher 的發現)
[僅就上方提供的再生能源輸入摘要進行綜整與闡述。]

### 電動車發現
(依據 EVResearcher 的發現)
[僅就上方提供的電動車輸入摘要進行綜整與闡述。]

### 碳捕捉發現
(依據 CarbonCaptureResearcher 的發現)
[僅就上方提供的碳捕捉輸入摘要進行綜整與闡述。]

### 整體結論
[提供一段簡短(1 到 2 句)的結語,僅連結上方所呈現的各項發現。]

只輸出依循此格式的結構化報告。請勿在此結構之外加入引言或結語性的語句,並嚴格遵守僅使用所提供之輸入摘要內容的規定。
""",
    description="將平行代理的研究發現組合成一份結構化、附帶出處的報告,並嚴格以所提供的輸入為依據。",
    # 合併不需要工具
    # 此處不需要 output_key,因為它的直接回應就是整個序列的最終輸出
)

# --- 4. 建立 SequentialAgent(協調整體流程)---
# 主代理:先執行 ParallelAgent 填充 state,再執行 MergerAgent 產出最終輸出。
sequential_pipeline_agent = SequentialAgent(
    name="ResearchAndSynthesisPipeline",
    # 先進行平行研究,然後合併
    sub_agents=[parallel_research_agent, merger_agent],
    description="協調平行研究並綜整其結果。"
)

root_agent = sequential_pipeline_agent
```

這個多代理系統用來研究並綜整永續科技進展:三個 `LlmAgent` 分別專注再生能源、電動車技術與碳捕捉方法,都使用 `GEMINI_MODEL` 與 `google_search`,精簡摘要後以 `output_key` 存入 session state。`ParallelWebResearchAgent`(`ParallelAgent`)讓三者同時執行,全部完成並填充 state 後結束。`MergerAgent`(`LlmAgent`)以這些摘要為輸入綜整報告,並嚴格要求僅依輸入、禁止加入外部知識,輸出為各主題附標題、末附整體結論的結構化報告。最後 `ResearchAndSynthesisPipeline`(`SequentialAgent`)作為主控者協調全程:先跑 `ParallelAgent` 研究,完成後跑 `MergerAgent` 綜整;它被設為 `root_agent`,即系統的執行進入點。

## 重點速覽

**是什麼(What):** 許多代理工作流程含多個必須完成的子任務。純循序執行——每項任務都等前一項完成——往往緩慢,當任務依賴外部 I/O(呼叫不同 API、查多個資料庫)時延遲更成為瓶頸;此時總處理時間等於所有任務耗時之和,拖累整體效能與回應速度。

**為什麼(Why):** 平行化提供標準化解法,讓彼此獨立的任務同時執行。它找出工作流程中不依賴彼此即時輸出的元件(如工具使用或 LLM 呼叫),並用 LangChain、Google ADK 等框架內建結構來定義與管理。例如主行程觸發數個平行子任務,等全部完成才進入下一步,藉此大幅縮短總執行時間。

**經驗法則(Rule of thumb):** 當工作流程包含多個可同時執行的獨立操作時使用此模式,例如從數個 API 擷取資料、處理不同資料區塊,或生成多份內容以供後續綜整。

## 視覺摘要

![圖 2:平行化設計模式。](assets/03-parallelization/fig-2-parallelization-design-pattern.png)

*圖 2:平行化設計模式。*

## 結論

重點回顧:

- 平行化是同時執行獨立任務以提升效率的模式,在任務需等待外部資源(如 API 呼叫)時格外有用。
- 採用並行/平行架構會引入可觀的複雜度與成本,影響設計、除錯與系統日誌記錄等開發階段。
- LangChain 與 Google ADK 等框架內建支援平行執行;在 LCEL 中,`RunnableParallel` 是讓多個可執行物件並排運行的關鍵結構。
- Google ADK 可透過「LLM 驅動的委派(LLM-Driven Delegation)」促成平行:由協調者(Coordinator)代理的 LLM 找出獨立子任務,觸發各有專長的子代理同時處理。
- 平行化降低整體延遲,讓代理系統面對複雜任務時更具回應力。

整體而言,平行化透過同時執行彼此獨立的子任務來最佳化運算工作流程,在涉及多次模型推論或外部服務呼叫的複雜操作中效益尤其明顯。不同框架機制各異:LangChain 用 `RunnableParallel` 明確定義並同時執行多條鏈;Google ADK 則透過多代理委派(multi-agent delegation),由協調者模型把子任務指派給各有專長、能同時運作的代理。把平行處理與循序(鏈式)及條件(路由)控制流程整合,便能建構出精密、高效能、能高效處理多樣複雜任務的運算系統。

## 參考資料

1. LangChain Expression Language(LCEL)Documentation(Parallelism):
   <https://python.langchain.com/docs/concepts/lcel/>
2. Google Agent Developer Kit(ADK)Documentation(Multi-Agent Systems):
   <https://google.github.io/adk-docs/agents/multi-agents/>
3. Python asyncio Documentation: <https://docs.python.org/3/library/asyncio.html>
