# 第 4 章:反思(Reflection)

## 反思模式總覽

前幾章探討了鏈接(Chaining)、路由(Routing)與平行化(Parallelization)等基礎代理模式。但即便工作流程再精密,代理最初的輸出或計畫也未必最佳。反思(Reflection)模式正是為此而生:讓代理評估自身的工作、輸出或內部狀態,並用該評估來精煉回應。它是一種自我修正、自我改進的機制,可由代理自身執行,也可由另一個專責分析的獨立代理促成。

不同於循序鏈接或路由,反思引入了一個回饋迴路(feedback loop):代理產生輸出後會檢視它,找出問題與可改進之處,再據以產生更好的版本。這個過程通常包含四步:

1. **執行(Execution):** 產生初始輸出。
2. **評估/批判(Evaluation/Critique):** 透過另一次 LLM 呼叫或一組規則,分析事實準確性、連貫性、風格、完整度或指令遵循度等。
3. **反思/精煉(Reflection/Refinement):** 根據批判決定如何改進,可能是重寫輸出、調整參數,甚至修改計畫。
4. **迭代(Iteration,選用):** 重複上述過程,直到結果令人滿意或達到停止條件。

一種極有效的實作是把過程拆成兩個角色,即「生成者—批判者(Generator-Critic)」或「生產者—審閱者(Producer-Reviewer)」模型:

1. **生產者代理(Producer Agent):** 專注於生成內容(撰寫程式碼、草擬文章、制定計畫),產生第一版輸出。
2. **批判者代理(Critic Agent):** 唯一職責是評估生產者的輸出,通常搭配特定角色設定(如「資深軟體工程師」「一絲不苟的事實查核員」),依特定標準找出瑕疵並提供結構化回饋。

這種關注點分離(separation of concerns)能避免代理審閱自身工作時的認知偏誤(cognitive bias):批判者以全新視角專注找錯,回饋傳回生產者後再生成精煉版本。本章的 LangChain 範例以「reflector_prompt」建立批判者角色,ADK 範例則明確定義生產者與審閱者兩個代理。

實作反思需把工作流程架構成包含回饋迴路,可用迭代迴圈,或運用支援狀態管理(state management)與條件轉移(conditional transition)的框架。單步的評估與精煉可在 LangChain/LangGraph、ADK 或 Crew.AI 的鏈中實作,但真正的迭代式反思通常需要更複雜的編排(orchestration)。

反思也與目標設定及監控(見第 11 章)相交:目標提供自我評估的基準,監控追蹤進展,反思則扮演修正引擎,利用回饋分析偏差並調整策略,把代理從被動執行者轉為目的性系統。此外,當 LLM 保有對話記憶(見第 8 章)時,反思成效會顯著提升——對話歷史提供了情境,讓代理能在先前互動與演進目標的背景下評估,從過往批判中學習。沒有記憶,每次反思都是孤立事件;有了記憶,反思成為累積性過程,每個循環都奠基於前一個之上。

## 實務應用與使用案例

在輸出品質、準確性或限制遵循至關重要的情境中,反思極具價值:

**1. 創意寫作與內容生成:** 撰寫部落格文章的代理生成初稿,針對流暢度、語氣與清晰度批判後重寫,反覆直到達標,產出更精煉的內容。

**2. 程式碼生成與除錯:** 撰寫 Python 函式的代理寫出初版後,執行測試或靜態分析找出錯誤與低效之處,再據以修改,生成更穩健的程式碼。

**3. 複雜問題解決:** 解邏輯謎題的代理提出一個步驟,評估它是否更接近解答或引入矛盾,必要時回溯,提升在複雜問題空間中探索的能力。

**4. 摘要與資訊綜整:** 摘要長文件的代理生成初步摘要,與原文關鍵重點比對後補上缺漏資訊,產出更準確全面的摘要。

**5. 規劃與策略:** 規劃行動的代理生成計畫後,模擬執行或依限制評估可行性,再修訂計畫,發展出更切實際的計畫。

**6. 對話式代理:** 客戶支援聊天機器人在使用者回應後審閱對話歷史與最近訊息,確保連貫並準確回應最新輸入,帶來更自然的對話。

反思為代理系統增添一層後設認知(meta-cognition),讓它們從自身輸出與過程中學習,帶來更可靠、更高品質的結果。

## 動手實作範例(LangChain)

完整的迭代式反思需要狀態管理與循環執行——在 LangGraph 這類圖框架中為原生支援,也可用自訂程式碼處理。而單一反思循環的基本原理,可用 LCEL(LangChain 表達式語言)的組合式語法有效示範。

以下範例用 LangChain 與 OpenAI 的 GPT-4o,實作一個反思迴圈,迭代生成並精煉一個計算階乘(factorial)的 Python 函式:從任務提示生成初始程式碼,接著依模擬資深工程師角色的批判反覆精煉,直到批判判定程式碼完美或達到最大迭代次數。

首先安裝所需函式庫:

```bash
pip install langchain langchain-community langchain-openai
```

你還需為所選語言模型(OpenAI、Google Gemini 或 Anthropic)設定好環境中的 API 金鑰。

```python
import os
from dotenv import load_dotenv
from langchain_openai import ChatOpenAI
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.messages import SystemMessage, HumanMessage

# --- 設定 ---
# 從 .env 檔案載入環境變數(用於 OPENAI_API_KEY)
load_dotenv()

# 檢查 API 金鑰是否已設定
if not os.getenv("OPENAI_API_KEY"):
    raise ValueError("在 .env 檔案中找不到 OPENAI_API_KEY,請補上。")

# 初始化 Chat LLM。使用 gpt-4o 以獲得更好的推理能力。
# 採用較低的 temperature 以取得更具確定性的輸出。
llm = ChatOpenAI(model="gpt-4o", temperature=0.1)


def run_reflection_loop():
    """以多步反思迴圈逐步改進一個 Python 函式。"""
    # --- 核心任務 ---
    task_prompt = """
    你的任務是建立一個名為 `calculate_factorial` 的 Python 函式。
    這個函式應該:
    1. 接受單一整數 `n` 作為輸入。
    2. 計算它的階乘(n!)。
    3. 包含一個清楚的 docstring,說明函式用途。
    4. 處理邊界情況:0 的階乘是 1。
    5. 處理無效輸入:當輸入為負數時,丟出 ValueError。
    """

    # --- 反思迴圈 ---
    max_iterations = 3
    current_code = ""
    # 建構一份對話歷史,在每一步中提供情境。
    message_history = [HumanMessage(content=task_prompt)]

    for i in range(max_iterations):
        print("\n" + "="*25 + f" 反思迴圈:第 {i + 1} 次迭代 " + "="*25)

        # --- 1. 生成 / 精煉階段 ---
        # 第一次迭代為生成,後續迭代為精煉。
        if i == 0:
            print("\n>>> 階段 1:生成初始程式碼...")
            # 第一則訊息就只是任務提示。
            response = llm.invoke(message_history)
            current_code = response.content
        else:
            print("\n>>> 階段 1:根據先前批判精煉程式碼...")
            # 此時歷史已含任務、上一版程式碼與上一次批判,指示模型套用批判。
            message_history.append(HumanMessage(content="請依據所提供的批判來精煉這段程式碼。"))
            response = llm.invoke(message_history)
            current_code = response.content

        print("\n--- 生成的程式碼(v" + str(i + 1) + ")---\n" + current_code)
        message_history.append(response)  # 把生成的程式碼加入歷史

        # --- 2. 反思階段 ---
        print("\n>>> 階段 2:對生成的程式碼進行反思...")
        # 為 reflector 代理建立特定提示,要求模型扮演資深程式碼審閱者。
        reflector_prompt = [
            SystemMessage(content="""
                你是一位資深軟體工程師,也是 Python 專家。
                你的職責是執行一絲不苟的程式碼審查。
                請依據原始任務需求,嚴格評估所提供的 Python 程式碼。
                找出錯誤、風格問題、遺漏的邊界情況,以及可改進之處。
                如果程式碼完美無瑕且滿足所有需求,就只回覆「CODE_IS_PERFECT」這個短語。
                否則,請以條列清單的方式提供你的批判。
            """),
            HumanMessage(content=f"原始任務:\n{task_prompt}\n\n待審查的程式碼:\n{current_code}")
        ]
        critique_response = llm.invoke(reflector_prompt)
        critique = critique_response.content

        # --- 3. 停止條件 ---
        if "CODE_IS_PERFECT" in critique:
            print("\n--- 批判 ---\n未發現進一步批判,程式碼已令人滿意。")
            break

        print("\n--- 批判 ---\n" + critique)
        # 把批判加入歷史,供下一次精煉迴圈使用。
        message_history.append(HumanMessage(content=f"對上一版程式碼的批判:\n{critique}"))

    print("\n" + "="*30 + " 最終結果 " + "="*30)
    print("\n反思過程後的最終精煉程式碼:\n")
    print(current_code)


if __name__ == "__main__":
    run_reflection_loop()
```

程式碼先設定環境、載入 API 金鑰,並以較低 temperature 初始化 GPT-4o。核心任務要求撰寫一個計算階乘的函式,並對 docstring、邊界情況與負數錯誤處理有特定要求。`run_reflection_loop` 編排迭代精煉:第一次迭代依任務提示生成程式碼,後續迭代依前一步批判精煉。一個獨立的「reflector」角色(同一模型搭配不同系統提示)以資深工程師身分批判,以條列問題清單呈現,若無問題則回應「CODE_IS_PERFECT」。迴圈持續直到程式碼完美或達上限。對話歷史在每一步傳給模型,同時為生成/精煉與反思階段提供情境,最後印出最終程式碼。

## 動手實作範例(ADK)

以下是用 Google ADK 實作的概念性範例,以生成者—批判者(Generator-Critic)結構展示此模式:生成者產生初始結果,批判者提供回饋,引導生成者朝更精煉的最終輸出邁進。

```python
from google.adk.agents import SequentialAgent, LlmAgent

# 第一個代理負責生成初始草稿。
generator = LlmAgent(
    name="DraftWriter",
    description="針對給定的主題,生成初始的草稿內容。",
    instruction="針對使用者的主題,撰寫一段簡短而具資訊性的段落。",
    output_key="draft_text"  # 輸出會被儲存到這個 state key。
)

# 第二個代理負責批判第一個代理產生的草稿。
reviewer = LlmAgent(
    name="FactChecker",
    description="審查給定的文字是否具備事實準確性,並提供結構化的批判。",
    instruction="""
    你是一位一絲不苟的事實查核員。
    1. 閱讀 state key 'draft_text' 中所提供的文字。
    2. 仔細驗證所有主張的事實準確性。
    3. 你的最終輸出必須是一個包含兩個鍵的字典:
       - "status":一個字串,其值為 "ACCURATE"(準確)或 "INACCURATE"(不準確)。
       - "reasoning":一個字串,為你的 status 提供清楚的解釋;若發現問題,請引用具體的問題點。
    """,
    output_key="review_output"  # 結構化的字典會被儲存在這裡。
)

# SequentialAgent 確保 generator 會在 reviewer 之前執行。
review_pipeline = SequentialAgent(
    name="WriteAndReview_Pipeline",
    sub_agents=[generator, reviewer]
)

# 執行流程:
# 1. generator 執行 -> 把它的段落儲存到 state['draft_text']。
# 2. reviewer 執行 -> 讀取 state['draft_text'],並把字典輸出儲存到 state['review_output']。
```

這段程式碼示範如何用循序代理管線生成並審閱文字。`generator` 針對主題撰寫一段簡短文字,存到 state key `draft_text`;`reviewer` 則扮演事實查核員,從 `draft_text` 讀取文字並驗證準確性,輸出帶有 `status`(ACCURATE/INACCURATE)與 `reasoning` 的結構化字典,存到 `review_output`。`SequentialAgent`(`review_pipeline`)確保 `generator` 先執行、`reviewer` 後執行,實現結構化的內容創作與審閱流程。注意:另有一個運用 ADK `LoopAgent` 的替代實作可供參考。

作結前須留意一項取捨:反思雖能顯著提升品質,卻會帶來更高的成本與延遲(latency),因為每個精煉迴圈都可能需要新的 LLM 呼叫,不適合對時間敏感的應用;它也相當耗用記憶體,因對話歷史會隨每次迭代不斷膨脹。

## 重點速覽

**是什麼(What):** 代理最初的輸出往往不夠好,可能不準確、不完整或無法滿足複雜要求,而基本工作流程缺乏辨識並修正自身錯誤的機制。解法是讓代理評估自身工作,或更穩健地引入一個獨立的批判者代理,避免初始回應不論品質直接成為最終答案。

**為什麼(Why):** 反思建立一個回饋迴路:由「生產者」代理生成輸出,再由「批判者」(或生產者本身)依預定標準評估,並用批判生成改進版本。這個「生成、評估、精煉」的迭代過程逐步提升品質,帶來更準確、更連貫、更可靠的成果。

**經驗法則(Rule of thumb):** 當輸出品質、準確性與細節比速度和成本更重要時使用反思,尤其適合生成精煉長篇內容、撰寫與除錯程式碼,以及制定詳盡計畫。當任務需要高度客觀性或專業評估時,採用獨立的批判者代理。

## 視覺摘要

![圖 1:反思設計模式,自我反思](assets/04-reflection/fig-1-self-reflection.png)

*圖 1:反思設計模式——自我反思(self-reflection)。代理接收使用者的提示後產生輸出,並透過反思迴路檢視自身的輸出以進行精煉,最終把結果回傳給使用者。*

![圖 2:反思設計模式,生產者與批判者代理](assets/04-reflection/fig-2-producer-critique.png)

*圖 2:反思設計模式——生產者(Producer)與批判者(Critique)代理。生產者代理產生輸出,由批判者代理進行反思與批判,並把回饋傳回生產者以精煉結果。*

## 重點整理

- 反思最主要的優勢是能迭代地自我修正並精煉輸出,顯著提升品質、準確性與複雜指令的遵循度。
- 它由執行、評估/批判與精煉構成回饋迴路,對需要高品質或細膩輸出的任務至關重要。
- 生產者—批判者(Producer-Critic)模型是強大的實作方式,以獨立代理(或被提示扮演的角色)評估初始輸出,提升客觀性並帶來更專業、更結構化的回饋。
- 代價是延遲與運算開銷增加,並有超出情境視窗(context window)或被 API 限流(throttle)的風險。
- 完整迭代式反思常需具狀態工作流程(如 LangGraph),但單一反思步驟可用 LangChain 的 LCEL 實作;Google ADK 也能透過循序工作流程促成反思。
- 此模式讓代理執行自我修正,並隨時間提升表現。

## 結論

反思為代理工作流程提供關鍵的自我修正機制,讓改進以迭代方式超越單次執行:系統生成輸出、依標準評估、再用評估產生精煉成果。這項評估可由代理本身執行(自我反思),或更有效地由獨立的批判者代理執行——這正是此模式的關鍵架構選擇。雖然完全自主的多步反思需要穩健的狀態管理,其核心原理在單一的「生成—批判—精煉」循環中便能有效展現。作為一種控制結構,反思可與其他基礎模式整合,建構更穩健、功能更複雜的代理系統。

## 參考資料

1. Training Language Models to Self-Correct via Reinforcement Learning:
   <https://arxiv.org/abs/2409.12917>
2. LangChain Expression Language (LCEL) Documentation:
   <https://python.langchain.com/docs/introduction/>
3. LangGraph Documentation: <https://www.langchain.com/langgraph>
4. Google Agent Developer Kit (ADK) Documentation (Multi-Agent Systems):
   <https://google.github.io/adk-docs/agents/multi-agents/>
