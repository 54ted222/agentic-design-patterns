# 第 7 章:多代理協作(Multi-Agent Collaboration)

單體式(monolithic)代理面對複雜、跨領域任務時能力受限。多代理協作把系統建構成一組專精代理(specialized agents)的合作群體,核心是任務拆解(task decomposition):把高層目標分解成子問題,各指派給最適合的代理——擁有特定工具、資料存取權或推理能力者。

例如一個研究查詢可拆給負責檢索的研究代理、負責統計的資料分析代理,以及生成報告的綜整代理。成效不只來自分工,更取決於溝通機制:需要標準化的溝通協定(communication protocol)與共享本體論(shared ontology),讓代理交換資料、委派子任務並協調行動,確保輸出連貫。這種分散式架構帶來模組化、可擴展性與穩健性(單一代理失效未必導致整體崩潰),並達成綜效(synergistic)——整體表現超越群體中任何單一代理的上限。

## 多代理協作模式總覽

此模式讓多個獨立或半獨立代理協同達成共同目標。每個代理有明確角色、與整體一致的目標,並可能擁有不同工具或知識庫;威力正來自代理間的互動與綜效。

協作可採取多種形式:

- **循序交接(Sequential Handoffs):** 一個代理完成任務後把輸出傳給下一個代理。
- **平行處理(Parallel Processing):** 多個代理同時處理問題的不同部分,結果再合併。
- **辯論與共識(Debate and Consensus):** 擁有不同觀點與來源的代理投入討論評估選項,達成共識或做出更明智的決策。
- **階層式結構(Hierarchical Structures):** 管理者代理(manager agent)依工作代理(worker agents)的能力動態委派任務並綜整結果;每個代理也可只負責一組相關工具。
- **專家團隊(Expert Teams):** 不同領域的專精代理(研究員、寫手、編輯)協作產出複雜輸出。
- **評論者—審查者(Critic-Reviewer):** 一組代理產出初步輸出(計畫、初稿或答案),第二組代理以批判角度評估其政策、安全、合規、正確性與品質,再據此修訂。適用於程式碼生成、研究寫作與邏輯檢查,可提升品質、降低幻覺(hallucination)與錯誤。

一個多代理系統(見圖 1)由三要素構成:代理角色與職責的界定、代理間交換資訊的溝通管道,以及引導協作的任務流程或互動協定。

![圖 1:多代理系統範例。](assets/07-multi-agent/fig-1-multi-agent-system.png)

*圖 1:多代理系統範例。*

Crew AI 與 Google ADK 等框架正為此範式而設計,提供規範代理、任務與互動程序的結構。對於需要多種專精知識、涵蓋多個離散階段,或能從平行處理與跨代理佐證中獲益的挑戰,這套方法格外有效。

## 實務應用與使用案例

- **複雜研究與分析:** 代理團隊分工搜尋學術資料庫、摘要發現、辨識趨勢、綜整報告,如同人類研究團隊。
- **軟體開發:** 代理分擔需求分析、程式碼生成、測試與文件撰寫,彼此傳遞輸出以建構並驗證元件。
- **創意內容生成:** 行銷活動可由市場研究、文案撰寫、平面設計(使用影像生成工具)與社群排程代理協同完成。
- **金融分析:** 各代理分別擷取股票資料、分析新聞情緒、執行技術分析並生成投資建議。
- **客戶支援升級:** 第一線代理處理初步查詢,必要時把複雜問題升級給專家代理(技術或帳務),展現基於複雜度的循序交接。
- **供應鏈最佳化:** 各代理代表不同節點(供應商、製造商、配銷商),協同因應需求變化或中斷,最佳化庫存、物流與排程。
- **網路分析與修復:** 多個代理協作分診(triage)並修復問題、提出最佳處置,並能整合既有機器學習模型與工具。

界定專精代理並縝密編排其關係,使開發者得以建構出更模組化、可擴展,且能應對單一整合型代理難以克服之複雜性的系統。

## 探討相互關係與溝通結構

代理間如何互動與溝通,是設計有效多代理系統的根本。如圖 2 所示,關係與溝通模型構成一道光譜,從單一代理到量身打造的框架,各有優劣,並影響系統的效率、穩健性與適應性。

**1. 單一代理(Single Agent):** 自主運作,不與他者互動。實作直觀,但能力受限於自身範疇,適用於可獨力解決的子問題。

**2. 網路(Network):** 多個代理去中心化直接互動,通常為點對點(peer-to-peer)以共享資訊、資源與任務。具韌性(單一失效未必癱瘓系統),但龐大無結構的網路中,溝通開銷(communication overhead)與決策連貫難以管理。

**3. 監督者(Supervisor):** 專責監督者協調一群下屬代理,扮演溝通、任務分配與衝突調解的中央樞紐。權責清晰、控制簡化,但引入單點故障(single point of failure),下屬或任務過多時易成瓶頸。

**4. 監督者作為工具(Supervisor as a Tool):** 監督者不主導指揮控制,而是提供工具、資料、運算或分析支援,讓其他代理更有效執行任務,而不干涉其一舉一動。

**5. 階層式(Hierarchical):** 把監督者擴展為多層組織:高層督導低層,最底層執行操作。適合可拆解的複雜問題,各子問題由特定層級管理,兼顧可擴展性、複雜度管理與界限內的分散式決策。

![圖 2:代理以各種不同的方式進行溝通與互動。](assets/07-multi-agent/fig-2-communication-models.png)

*圖 2:代理以各種不同的方式進行溝通與互動。*

**6. 自訂(Custom):** 終極彈性,可混合前述模型,或為環境的獨特限制與機會設計全新架構,常見動機包括針對特定指標最佳化、處理高度動態環境或納入領域知識。需深入理解多代理原則,謹慎考量溝通協定、協調機制與湧現行為(emergent behaviors)。

選擇關係與溝通模型是關鍵設計決策,取決於任務複雜度、代理數量、期望自主程度、穩健性需求與可接受的溝通開銷。

## 動手實作範例(Crew AI)

以下用 CrewAI 定義一個 AI 團隊(crew)生成 AI 趨勢部落格文章。它從 `.env` 載入 API 金鑰,定義兩個代理:尋找並摘要趨勢的研究員(researcher)與據此撰文的寫手(writer);再定義兩個任務(寫作任務依賴研究輸出),組成循序流程(sequential process)的團隊,以「gemini-2.0-flash」初始化,由 `main` 透過 `kickoff()` 執行並印出結果。

```python
import os
from dotenv import load_dotenv
from crewai import Agent, Task, Crew, Process
from langchain_google_genai import ChatGoogleGenerativeAI

def setup_environment():
    """載入環境變數並檢查所需的 API 金鑰。"""
    load_dotenv()
    if not os.getenv("GOOGLE_API_KEY"):
        raise ValueError("找不到 GOOGLE_API_KEY,請在 .env 檔案中設定。")

def main():
    """使用最新的 Gemini 模型初始化並執行內容創作 AI 團隊。"""
    setup_environment()

    # 定義要使用的語言模型(Gemini 2.0 系列以獲得更佳效能)。
    # 若需最前沿的預覽版能力,可改用 "gemini-2.5-flash"。
    llm = ChatGoogleGenerativeAI(model="gemini-2.0-flash")

    # 定義具備特定角色與目標的代理
    researcher = Agent(
        role='資深研究分析師',
        goal='尋找並摘要 AI 領域的最新趨勢。',
        backstory="你是一位經驗豐富的研究分析師,擅長辨識關鍵趨勢並綜整資訊。",
        verbose=True,
        allow_delegation=False,
    )

    writer = Agent(
        role='技術內容寫手',
        goal='根據研究發現撰寫一篇清晰且引人入勝的部落格文章。',
        backstory="你是一位技藝精湛的寫手,能把複雜的技術主題轉化為淺顯易懂的內容。",
        verbose=True,
        allow_delegation=False,
    )

    # 為各代理定義任務
    research_task = Task(
        description="研究 2024-2025 年人工智慧領域前三大新興趨勢。聚焦於實際應用與潛在影響。",
        expected_output="一份關於前三大 AI 趨勢的詳細摘要,包含重點與來源。",
        agent=researcher,
    )

    writing_task = Task(
        description="根據研究發現撰寫一篇 500 字的部落格文章。文章應引人入勝,且讓一般大眾易於理解。",
        expected_output="一篇關於最新 AI 趨勢、完整的 500 字部落格文章。",
        agent=writer,
        context=[research_task],
    )

    # 建立團隊(Crew)
    blog_creation_crew = Crew(
        agents=[researcher, writer],
        tasks=[research_task, writing_task],
        process=Process.sequential,
        llm=llm,
        verbose=2  # 設定詳細程度,以取得詳細的團隊執行日誌
    )

    # 執行團隊
    print("## 正在以 Gemini 2.0 Flash 執行部落格創作團隊... ##")
    try:
        result = blog_creation_crew.kickoff()
        print("\n------------------\n")
        print("## 團隊最終輸出 ##")
        print(result)
    except Exception as e:
        print(f"\n發生未預期的錯誤: {e}")

if __name__ == "__main__":
    main()
```

接下來以 Google ADK 探討階層式、平行與循序協調,以及把代理當作工具的做法。

## 動手實作範例(Google ADK)

以下在 Google ADK 中以父子關係建構階層式結構。`greeter` 是 `LlmAgent` 問候者,`task_doer` 是衍生自 `BaseAgent` 的自訂 `TaskExecutor`(非 LLM 任務,此處僅 yield 一個完成事件);父代理 `coordinator` 依指令把問候委派給 `greeter`、把任務執行委派給 `task_doer`。兩者設為子代理(sub-agents)建立父子關係,程式並以斷言(assert)驗證。

```python
from google.adk.agents import LlmAgent, BaseAgent
from google.adk.agents.invocation_context import InvocationContext
from google.adk.events import Event
from typing import AsyncGenerator

# 透過擴充 BaseAgent 來正確地實作一個自訂代理
class TaskExecutor(BaseAgent):
    """具備自訂、非 LLM 行為的專精代理。"""
    name: str = "TaskExecutor"
    description: str = "執行一項預先定義好的任務。"

    async def _run_async_impl(self, context: InvocationContext) -> AsyncGenerator[Event, None]:
        """任務的自訂實作邏輯。"""
        # 你的自訂邏輯會放在這裡;本範例僅產生一個簡單的事件。
        yield Event(author=self.name, content="Task finished successfully.")

# 定義各別代理並適當初始化;LlmAgent 需指定模型。
greeter = LlmAgent(
    name="Greeter",
    model="gemini-2.0-flash-exp",
    instruction="你是一位友善的問候者。"
)

task_doer = TaskExecutor()  # 實體化我們具體的自訂代理

# 建立父代理並指派子代理;其描述與指令應引導委派邏輯。
coordinator = LlmAgent(
    name="Coordinator",
    model="gemini-2.0-flash-exp",
    description="一個能問候使用者並執行任務的協調者。",
    instruction="當被要求問候時,委派給 Greeter。當被要求執行任務時,委派給 TaskExecutor。",
    sub_agents=[
        greeter,
        task_doer
    ]
)

# ADK 框架會自動建立父子關係;初始化後以下斷言將通過。
assert greeter.parent_agent == coordinator
assert task_doer.parent_agent == coordinator

print("Agent hierarchy created successfully.")
```

下一段用 `LoopAgent` 建立迭代式工作流程。`ConditionChecker` 檢查工作階段狀態(session state)的「status」:為「completed」便升級(escalate)停止迴圈,否則繼續。`ProcessingStep` 是 `LlmAgent`,執行任務並在最後一步把「status」設為「completed」。`StatusPoller`(`LoopAgent`,`max_iterations=10`)循序執行兩個子代理,最多 10 次直到狀態為「completed」。

```python
import asyncio
from typing import AsyncGenerator
from google.adk.agents import LoopAgent, LlmAgent, BaseAgent
from google.adk.events import Event, EventActions
from google.adk.agents.invocation_context import InvocationContext

# 最佳實務:把自訂代理定義為完整、能自我描述的類別。
class ConditionChecker(BaseAgent):
    """檢查工作階段狀態中是否為 'completed' 的自訂代理。"""
    name: str = "ConditionChecker"
    description: str = "檢查某個流程是否已完成,並發出訊號讓迴圈停止。"

    async def _run_async_impl(
        self, context: InvocationContext
    ) -> AsyncGenerator[Event, None]:
        """檢查狀態並產生事件以繼續或停止迴圈。"""
        status = context.session.state.get("status", "pending")
        is_done = (status == "completed")

        if is_done:
            # 當條件達成時,升級以終止迴圈。
            yield Event(author=self.name, actions=EventActions(escalate=True))
        else:
            # 產生一個簡單的事件以繼續迴圈。
            yield Event(author=self.name, content="Condition not met, continuing loop.")

# LlmAgent 必須有一個模型與明確的指令。
process_step = LlmAgent(
    name="ProcessingStep",
    model="gemini-2.0-flash-exp",
    # 你是一段較長流程中的一個步驟,執行你的任務。
    # 如果你是最後一個步驟,請把工作階段狀態的「status」設為「completed」。
    instruction="你是一段較長流程中的一個步驟。執行你的任務。如果你是最後一個步驟,請把工作階段狀態中的「status」設為「completed」以更新狀態。"
)

# LoopAgent 負責編排這個工作流程。
poller = LoopAgent(
    name="StatusPoller",
    max_iterations=10,
    sub_agents=[
        process_step,
        ConditionChecker()  # 實體化這個定義良好的自訂代理。
    ]
)

# 這個 poller 會先執行 'process_step',接著執行 'ConditionChecker',
# 並反覆進行,直到狀態為 'completed' 或已達 10 次迭代為止。
```

下一段示範 `SequentialAgent` 線性工作流程。`step1`(命名「Step1_Fetch」,輸出存入狀態的「data」鍵)先跑,`step2`(命名「Step2_Process」)再分析 `session.state["data"]` 並提供摘要,由名為「MyPipeline」的 `SequentialAgent` 編排——這是多步驟 AI 或資料處理管線的常見模式。

```python
from google.adk.agents import SequentialAgent, Agent

# 這個代理的輸出會被儲存到 session.state["data"]
step1 = Agent(name="Step1_Fetch", output_key="data")

# 這個代理會使用前一步的資料;我們指示它如何尋找並使用這份資料。
step2 = Agent(
    name="Step2_Process",
    instruction="分析 state['data'] 中所找到的資訊,並提供一份摘要。"
)

pipeline = SequentialAgent(
    name="MyPipeline",
    sub_agents=[step1, step2]
)

# 當這條管線以初始輸入執行時,Step1 會先執行,其回應會被儲存到
# session.state["data"],接著 Step2 會執行並依指示使用狀態中的資訊。
```

以下示範 `ParallelAgent`,讓多個代理任務平行執行。`data_gatherer` 平行執行 `weather_fetcher`(天氣存入 `session.state["weather_data"]`)與 `news_fetcher`(頭條存入 `session.state["news_data"]`),完成後可從 `final_state` 取得所蒐集的資料。

```python
from google.adk.agents import Agent, ParallelAgent

# 把擷取邏輯定義為代理的工具會更好;為簡化本範例,
# 我們把邏輯直接嵌入代理指令中。實際場景中應使用工具。

# 定義將以平行方式執行的各別代理
weather_fetcher = Agent(
    name="weather_fetcher",
    model="gemini-2.0-flash-exp",
    instruction="取得指定地點的天氣,並只回傳天氣報告。",
    output_key="weather_data"  # 結果將被儲存在 session.state["weather_data"]
)

news_fetcher = Agent(
    name="news_fetcher",
    model="gemini-2.0-flash-exp",
    instruction="取得指定主題的頭條新聞,並只回傳那則新聞。",
    output_key="news_data"  # 結果將被儲存在 session.state["news_data"]
)

# 建立 ParallelAgent 來編排這些子代理
data_gatherer = ParallelAgent(
    name="data_gatherer",
    sub_agents=[
        weather_fetcher,
        news_fetcher
    ]
)
```

最後示範「代理作為工具(Agent as a Tool)」範式,讓一個代理像函式呼叫般運用另一個代理。`generate_image` 是模擬影像建立、回傳假造資料的工具;`image_generator_agent` 依文字提示使用它;父代理 `artist_agent` 先構思創意提示,再透過 `AgentTool` 包裝器把它當工具呼叫。`AgentTool` 是橋樑,讓高層代理編排低層專精代理。

```python
from google.adk.agents import LlmAgent
from google.adk.tools import agent_tool
from google.genai import types

# 1. 一個用於核心能力的簡單函式工具(遵循「把行動與推理分離」的最佳實務)。
def generate_image(prompt: str) -> dict:
    """
    根據文字提示生成一張影像。
    Args:
        prompt: 對所欲生成影像的詳細描述。
    Returns:
        一個包含狀態與所生成影像位元組的字典。
    """
    print(f"TOOL: 正在為提示生成影像: '{prompt}'")
    # 實際實作中這裡會呼叫影像生成 API;本範例回傳假造的影像資料。
    mock_image_bytes = b"mock_image_data_for_a_cat_wearing_a_hat"
    return {
        "status": "success",
        # 工具回傳原始位元組,代理會負責處理 Part 的建立。
        "image_bytes": mock_image_bytes,
        "mime_type": "image/png"
    }

# 2. 把 ImageGeneratorAgent 重構為一個 LlmAgent,會正確使用傳入的輸入。
image_generator_agent = LlmAgent(
    name="ImageGen",
    model="gemini-2.0-flash",
    description="根據一段詳細的文字提示生成一張影像。",
    instruction=(
        "你是一位影像生成專家。你的任務是接收使用者的請求,"
        "並使用 `generate_image` 工具來建立影像。"
        "應把使用者的整段請求作為該工具的「prompt」參數。"
        "在工具回傳影像位元組之後,你「必須」輸出該影像。"
    ),
    tools=[generate_image]
)

# 3. 把修正後的代理包裝在一個 AgentTool 中;這裡的描述就是父代理所看到的內容。
image_tool = agent_tool.AgentTool(
    agent=image_generator_agent,
    description="使用這個工具來生成一張影像。輸入應為一段描述所欲影像的提示。"
)

# 4. 父代理維持不變,其邏輯本來就正確。
artist_agent = LlmAgent(
    name="Artist",
    model="gemini-2.0-flash",
    instruction=(
        "你是一位富有創意的藝術家。首先,為一張影像構思一段富有創意且具描述性的提示。"
        "接著,使用 `ImageGen` 工具,以你構思的提示來生成該影像。"
    ),
    tools=[image_tool]
)
```

## 重點速覽

**是什麼(What):** 複雜問題往往超出單一單體式 LLM 代理的能力。獨力作戰的代理可能缺乏多元專精技能,或缺少所需工具存取權,形成瓶頸,導致跨領域目標效率低落、成果不完整或次佳。

**為什麼(Why):** 此模式建立由多個合作代理組成的系統:把複雜問題拆解成子問題,各指派給具備所需工具與能力的專精代理,透過既定溝通協定與循序交接、平行工作流或階層式委派等模型協作。分散式做法產生綜效,使群體達成任何單一代理都不可能的成果。

**經驗法則(Rule of thumb):** 當任務對單一代理過於複雜,且可拆解成需要專精技能或工具的子任務時使用。特別適合能從多元專業、平行處理或多階段結構化工作流程獲益的問題,如複雜研究與分析、軟體開發或創意內容生成。

## 視覺摘要

![圖 3:多代理設計模式。](assets/07-multi-agent/fig-3-multi-agent-pattern.png)

*圖 3:多代理設計模式。*

## 結論

多代理協作透過編排多個專精代理創造價值:以循序交接、平行處理、辯論或階層式結構,運用專精角色、分散任務與代理間溝通,特別適合需要多元專業或多個階段的複雜問題。理解代理協作,自然引導我們進一步探究它們與外部環境的互動。

## 參考資料

1. Multi-Agent Collaboration Mechanisms: A Survey of LLMs,
   <https://arxiv.org/abs/2501.06322>
2. Multi-Agent System — The Power of Collaboration,
   <https://aravindakumar.medium.com/introducing-multi-agent-frameworks-the-power-of-collaboration-e9db31bba1b6>
