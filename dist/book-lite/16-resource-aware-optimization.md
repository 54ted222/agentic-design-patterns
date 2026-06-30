# 第 16 章:資源感知最佳化(Resource-Aware Optimization)

資源感知最佳化讓代理在運作中動態監控與管理運算、時間與財務資源。它不像規劃(planning)只排序動作,而是決定「如何執行動作」,以在預算內達成目標或最佳化效率——例如在「準確但昂貴」與「快速但平價」的模型間取捨,或決定是否多花運算換更精煉的回應。

備援機制(fallback mechanism)是關鍵策略:當偏好的模型過載或被限流時,自動切換到預設或較平價的模型,以優雅降級(graceful degradation)維持服務,而非徹底失敗。

## 實務應用與使用案例

- **成本最佳化的 LLM 使用:** 依預算決定複雜任務用大模型、簡單查詢用平價模型。
- **對延遲敏感的操作:** 即時系統選較快但可能較不完整的推理路徑。
- **能源效率:** 邊緣裝置(edge device)或電力受限環境下節省電池。
- **服務可靠性的備援:** 主要選擇不可用時自動切換備用模型。
- **資料用量管理:** 取摘要資料而非下載完整資料集,節省頻寬與儲存。
- **自適應的任務分配:** 多代理(multi-agent)系統中,代理依自身負載或可用時間自行指派任務。

## 動手實作範例

系統可評估每個問題的難度,動態選模型:簡單查詢用具成本效益的模型(如 Gemini Flash),複雜詢問用更強但更貴的模型(如 Gemini Pro),且決定也取決於預算與時間。

以階層式代理(hierarchical agent)的旅遊規劃器為例:高層級規劃(理解複雜請求、拆解多步驟行程、做邏輯決策)交給強大的「規劃器(planner)」LLM(如 Gemini Pro);計畫確立後,個別任務(查機票、確認空房、找評論)是簡單重複的網路查詢,這些「工具函式呼叫(tool function calls)」交給較快平價的模型(如 Gemini Flash)。

Google 的 ADK 以多代理架構支援此做法,讓應用模組化且可擴展。其模型彈性(model flexibility)可直接用各種 Gemini 模型或透過 LiteLLM 整合其他模型;協調(orchestration)能力支援 LLM 驅動的動態路由(routing);內建評估則可系統化評量並精煉系統(詳見〈評估與監控〉一章)。

以下定義兩個設定相同、但模型與成本不同的代理。

```python
# 概念性的類 Python 結構,非可執行程式碼
from google.adk.agents import Agent
# from google.adk.models.lite_llm import LiteLlm # 若使用 ADK 預設 Agent 未直接支援的模型

# 使用較昂貴的 Gemini Pro 2.5 的代理
gemini_pro_agent = Agent(
    name="GeminiProAgent",
    model="gemini-2.5-pro",  # 若實際模型名稱不同,此處為佔位符
    description="一個能力高強、可處理複雜查詢的代理。",
    instruction="你是一位擅長解決複雜問題的專家助理。"
)

# 使用較便宜的 Gemini Flash 2.5 的代理
gemini_flash_agent = Agent(
    name="GeminiFlashAgent",
    model="gemini-2.5-flash",  # 若實際模型名稱不同,此處為佔位符
    description="一個快速且高效率、可處理簡單查詢的代理。",
    instruction="你是一位處理直截了當問題的快速助理。"
)
```

路由器代理(Router Agent)可用簡單指標(如查詢長度)引導:短查詢給平價模型,長查詢給較強模型。更精密的路由器則以 LLM 或 ML 分析查詢複雜度——事實性回憶(factual recall)路由到 flash,需深度分析的查詢路由到 pro。提示調校(prompt tuning)與在「查詢與最佳模型」資料集上微調(fine-tuning),可進一步提升路由準確度。

```python
# 概念性的類 Python 結構,非可執行程式碼
from google.adk.agents import Agent, BaseAgent
from google.adk.events import Event
from google.adk.agents.invocation_context import InvocationContext
import asyncio

class QueryRouterAgent(BaseAgent):
    name: str = "QueryRouter"
    description: str = "依據複雜度,將使用者查詢路由到適當的 LLM 代理。"

    async def _run_async_impl(self, context: InvocationContext) -> AsyncGenerator[Event, None]:
        user_query = context.current_message.text  # 假設為文字輸入
        query_length = len(user_query.split())  # 簡單指標:字數

        if query_length < 20:  # 區分簡單與複雜的範例門檻
            print(f"短查詢路由到 Gemini Flash 代理(長度:{query_length})")
            # 在實際 ADK 設定中應 'transfer_to_agent' 或直接呼叫
            # 此處為示範,模擬呼叫並 yield 其回應
            response = await gemini_flash_agent.run_async(context.current_message)
            yield Event(author=self.name, content=f"Flash Agent processed: {response}")
        else:
            print(f"長查詢路由到 Gemini Pro 代理(長度:{query_length})")
            response = await gemini_pro_agent.run_async(context.current_message)
            yield Event(author=self.name, content=f"Pro Agent processed: {response}")
```

評論者代理(Critique Agent)評估回應並提供多用途回饋:在自我修正(self-correction)上找出錯誤、促使精煉輸出;為效能監控(performance monitoring)追蹤準確度與相關性;其回饋也能為強化學習(reinforcement learning)或微調提供訊號(如持續辨識 Flash 回應不佳,進而精煉路由邏輯)。它雖不直接管理預算,卻能透過辨識次佳路由(如簡單查詢誤導向 Pro、複雜查詢誤導向 Flash)間接協助控制成本。它可設定為只審閱生成文字,或連同原始查詢一併審閱,以全面評估回應與問題的契合度。

```python
CRITIC_SYSTEM_PROMPT = """
你是「評論者代理(Critic Agent)」,擔任我們這套協作式研究助理系統中的品質保證
一環。你的主要職責是「細緻地審查並挑戰」來自研究員代理(Researcher Agent)的
資訊,確保其「準確、完整且不偏頗的呈現」。

你的任務包括:
* 評估研究發現的事實正確性、完整性與潛在的偏向。
* 找出任何缺漏的資料或推理中的不一致之處。
* 提出能精煉或拓展當前理解的關鍵問題。
* 為強化內容或探索不同角度,提供建設性的建議。
* 確認最終產出是全面且平衡的。

所有的批評都必須具建設性。你的目標是強化這份研究,而非否定它。請清楚地架構你的
回饋,凸顯出需要修訂的具體要點。你最終的目標,是確保最終的研究成果達到盡可能最高
的品質標準。
"""
```

評論者代理依系統提示(system prompt)運作:該提示須確立其評估者角色、指明批判聚焦的領域、強調建設性回饋而非否定、鼓勵兼述優缺點,並引導回饋的架構方式。

## 動手實作:OpenAI 程式碼範例

此系統先把查詢分為三類,選出最具成本效益的處理路徑:

- **simple:** 可直接回答、無需複雜推理或外部資料的問題。
- **reasoning:** 需邏輯推演或多步驟思考,路由到更強模型。
- **internet_search:** 需當前資訊,自動觸發一次 Google 搜尋。

程式碼採 MIT 授權,可於 GitHub 取得:
(https://github.com/mahtabsyed/21-Agentic-Patterns/blob/main/16_Resource_Aware_Opt_LLM_Reflection_v2.ipynb)

```python
# MIT License
# Copyright (c) 2025 Mahtab Syed
# https://www.linkedin.com/in/mahtabsyed/

import os
import requests
import json
from dotenv import load_dotenv
from openai import OpenAI

# 載入環境變數
load_dotenv()

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
GOOGLE_CUSTOM_SEARCH_API_KEY = os.getenv("GOOGLE_CUSTOM_SEARCH_API_KEY")
GOOGLE_CSE_ID = os.getenv("GOOGLE_CSE_ID")

if not OPENAI_API_KEY or not GOOGLE_CUSTOM_SEARCH_API_KEY or not GOOGLE_CSE_ID:
    raise ValueError(
        "Please set OPENAI_API_KEY, GOOGLE_CUSTOM_SEARCH_API_KEY, and "
        "GOOGLE_CSE_ID in your .env file."
    )

client = OpenAI(api_key=OPENAI_API_KEY)


# --- 步驟 1:分類提示 ---
def classify_prompt(prompt: str) -> dict:
    system_message = {
        "role": "system",
        "content": (
            "你是一個分類器,分析使用者提示並『只』回傳三種類別之一:\n\n"
            "- simple\n"
            "- reasoning\n"
            "- internet_search\n\n"
            "規則:\n"
            "- 對不需推理或當前事件的直接事實性問題,使用 'simple'。\n"
            "- 對邏輯、數學或多步驟推論的問題,使用 'reasoning'。\n"
            "- 若提示牽涉當前事件、近期資料,或不在你訓練資料中的內容,使用 'internet_search'。\n\n"
            "只能以如下的 JSON 回覆:\n"
            '{ "classification": "simple" }'
        ),
    }
    user_message = {"role": "user", "content": prompt}

    response = client.chat.completions.create(
        model="gpt-4o", messages=[system_message, user_message], temperature=1
    )
    reply = response.choices[0].message.content
    return json.loads(reply)


# --- 步驟 2:Google 搜尋 ---
def google_search(query: str, num_results=1) -> list:
    url = "https://www.googleapis.com/customsearch/v1"
    params = {
        "key": GOOGLE_CUSTOM_SEARCH_API_KEY,
        "cx": GOOGLE_CSE_ID,
        "q": query,
        "num": num_results,
    }

    try:
        response = requests.get(url, params=params)
        response.raise_for_status()
        results = response.json()

        if "items" in results and results["items"]:
            return [
                {
                    "title": item.get("title"),
                    "snippet": item.get("snippet"),
                    "link": item.get("link"),
                }
                for item in results["items"]
            ]
        else:
            return []
    except requests.exceptions.RequestException as e:
        return {"error": str(e)}


# --- 步驟 3:生成回應 ---
def generate_response(prompt: str, classification: str, search_results=None) -> str:
    if classification == "simple":
        model = "gpt-4o-mini"
        full_prompt = prompt
    elif classification == "reasoning":
        model = "o4-mini"
        full_prompt = prompt
    elif classification == "internet_search":
        model = "gpt-4o"
        # 將每個搜尋結果 dict 轉為可讀字串
        if search_results:
            search_context = "\n".join(
                [
                    f"Title: {item.get('title')}\nSnippet: {item.get('snippet')}\nLink: {item.get('link')}"
                    for item in search_results
                ]
            )
        else:
            search_context = "No search results found."
        full_prompt = f"""請利用以下的網路搜尋結果來回答使用者的查詢:

{search_context}

查詢:{prompt}"""

    response = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": full_prompt}],
        temperature=1,
    )
    return response.choices[0].message.content, model


# --- 步驟 4:整合路由器 ---
def handle_prompt(prompt: str) -> dict:
    classification_result = classify_prompt(prompt)
    classification = classification_result["classification"]

    search_results = None
    if classification == "internet_search":
        search_results = google_search(prompt)

    answer, model = generate_response(prompt, classification, search_results)
    return {"classification": classification, "response": answer, "model": model}


test_prompt = "澳洲的首都是哪裡?"
# test_prompt = "請說明量子運算對密碼學的影響。"
# test_prompt = "2026 年澳洲網球公開賽何時開始?請給我完整日期。"

result = handle_prompt(test_prompt)
print("🧠 Classification:", result["classification"])
print("🧠 Model Used:", result["model"])
print("🔍 Response:\n", result["response"])
```

程式重點:從 `.env` 載入 API 金鑰,將提示分類為 simple、reasoning 或 internet_search;需當前資訊時呼叫 Google Custom Search,再依分類選對應的 OpenAI 模型生成回應(搜尋結果作為情境)。`handle_prompt` 串起整套流程,回傳分類、所用模型與答案。

## 動手實作範例(OpenRouter)

OpenRouter 以單一 API 端點(endpoint)統一存取數百種 AI 模型,內建自動故障轉移(failover)與成本最佳化,可整合至常用 SDK 或框架。

```python
import requests
import json

response = requests.post(
    url="https://openrouter.ai/api/v1/chat/completions",
    headers={
        "Authorization": "Bearer <OPENROUTER_API_KEY>",
        "HTTP-Referer": "<YOUR_SITE_URL>",  # 選用。用於 openrouter.ai 排名的網站 URL
        "X-Title": "<YOUR_SITE_NAME>",  # 選用。用於 openrouter.ai 排名的網站標題
    },
    data=json.dumps({
        "model": "openai/gpt-4o",  # 選用
        "messages": [
            {
                "role": "user",
                "content": "生命的意義是什麼?"
            }
        ]
    })
)
```

這段以 `requests` 向聊天補全(chat completion)端點發送 POST 請求,標頭含 API 金鑰與可選網站資訊,從指定模型(此例 `"openai/gpt-4o"`)取回應。

OpenRouter 提供兩種路由方法:

- **自動化模型選擇(Automated Model Selection):** 依提示內容把請求路由到精選集合中的最佳模型,實際處理的模型識別碼回傳在回應的中介資料(metadata)中。

```json
{
  "model": "openrouter/auto",
  ... // Other params
}
```

- **循序模型備援(Sequential Model Fallback):** 指定一份階層式模型清單以提供冗餘(redundancy)。系統先試主要模型,若因不可用、限流或內容過濾等錯誤而失敗,便自動改用清單中下一個,直到成功或用盡。最終成本與回傳的模型識別碼,對應於成功完成的那個模型。

```json
{
  "models": ["anthropic/claude-3.5-sonnet", "gryphe/mythomax-l2-13b"],
  ... // Other params
}
```

OpenRouter 另提供依累計 token 產量排名的排行榜(https://openrouter.ai/rankings),並收錄各供應商(ChatGPT、Gemini、Claude)的最新模型(見圖 1)。

![圖 1:OpenRouter 網站(https://openrouter.ai/)](assets/16-resource-aware-optimization/fig-1-openrouter-website.png)

*圖 1:OpenRouter 網站(https://openrouter.ai/)*

## 超越動態模型切換:代理資源最佳化的光譜

除動態模型切換外,以下技巧也對資源感知最佳化至關重要:

- **動態模型切換(Dynamic Model Switching):** 依任務複雜度與可用運算資源選模型——簡單用輕量平價模型,複雜用更精密耗資源的模型。
- **自適應工具使用與選擇(Adaptive Tool Use & Selection):** 為每個子任務挑最有效率的工具,並權衡 API 成本、延遲與執行時間。
- **情境修剪與摘要(Contextual Pruning & Summarization):** 摘要互動歷史、只留最相關資訊,降低提示 token 數與推論成本。
- **主動式資源預測(Proactive Resource Prediction):** 預測未來工作負載並主動配置資源,避免瓶頸。
- **成本敏感的探索(Cost-Sensitive Exploration):** 多代理系統中把「通訊成本」與「運算成本」並重,降低整體支出。
- **節能部署(Energy-Efficient Deployment):** 為資源嚴苛環境最小化能源足跡,延長運作時間並降低成本。
- **平行化與分散式運算意識(Parallelization & Distributed Computing Awareness):** 把運算負載分散到多台機器或處理器,提升吞吐量。
- **習得的資源配置策略(Learned Resource Allocation Policies):** 依回饋與效能指標,隨時間調適並最佳化配置策略。
- **優雅降級與備援機制(Graceful Degradation and Fallback Mechanisms):** 資源嚴峻時仍能在能力縮減狀態下運作、退回替代策略,維持必要功能。

## 重點速覽

**是什麼(What):** 資源感知最佳化要管理智慧系統中運算、時間與財務資源的消耗。LLM 應用既貴又慢,為每項任務都挑最佳模型往往效率不彰,因而在「輸出品質」與「所需資源」間形成根本取捨。缺乏動態管理策略,系統就無法因應變動的任務複雜度,也無法在預算與效能限制內運作。

**為什麼(Why):** 標準解法是讓代理系統依任務智慧監控與配置資源:由「路由器代理(Router Agent)」先做複雜度分類,再轉送到最適合的 LLM 或工具——簡單查詢用快速便宜的模型,複雜推理用更強的模型;「評論者代理(Critique Agent)」評估回應品質、提供回饋以持續改善路由邏輯。這種動態多代理做法在品質與成本效益間取得平衡。

**經驗法則(Rule of thumb):** 適用於:面對 API 或運算的嚴格預算;建構對延遲敏感、需快速回應的應用;部署在電池有限的邊緣裝置等受限硬體;以程式化方式平衡品質與成本;管理「不同任務有不同資源需求」的複雜多步驟工作流程。

## 視覺摘要

![圖 2:資源感知最佳化設計模式](assets/16-resource-aware-optimization/fig-2-resource-aware-optimization-pattern.png)

*圖 2:資源感知最佳化設計模式*

## 結論

資源感知最佳化讓代理在真實世界限制下高效運作:動態管理運算、時間與財務資源,達成最佳的效能與成本效益。核心要素是多代理架構帶來的模組化與可擴展性(回答、路由、評論代理各司其職)、LLM 驅動的動態路由(簡單用 Flash、複雜用 Pro),以及評論者代理透過回饋促成自我修正、效能監控與路由精煉。動態模型切換、自適應工具使用、情境修剪等技巧不可或缺;習得的資源配置策略與優雅降級等進階策略則提升代理在各種條件下的韌性。把這些原則整合進代理設計,是建構可擴展、穩健且永續 AI 系統的根本。

## 參考資料

1. Google's Agent Development Kit(ADK):<https://google.github.io/adk-docs/>
2. Gemini Flash 2.5 & Gemini 2.5 Pro:<https://aistudio.google.com/>
3. OpenRouter:<https://openrouter.ai/docs/quickstart>
