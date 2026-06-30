# 第 20 章:優先排序(Prioritization)

在複雜且動態的環境中,代理(Agent)常會面臨眾多潛在行動、相互衝突的目標,以及有限的資源。若缺乏決定下一步的明確流程,代理便容易效率下降、運作延遲,甚至無法達成關鍵目標。優先排序模式讓代理依重要性、急迫性、相依關係與既定準則來評估並排序任務、目標或行動,確保心力集中在最關鍵的任務上,提升整體成效並更貼合目標。

## 優先排序模式總覽

當代理同時面對多項需求時,優先排序能促成有依據的決策,讓重要或緊急的活動優先於較不關鍵者——在資源受限、時間有限、目標衝突的現實情境中尤為重要。其運作通常包含四個要素:

- **準則定義(criteria definition):** 建立評估規則或指標,例如急迫性(時間敏感度)、重要性(對主要目標的影響)、相依關係(是否為其他任務的前置條件)、資源可用性、成本效益分析,以及個人化場景中的使用者偏好。
- **任務評估(task evaluation):** 針對既定準則評估每項任務,方法可從簡單規則,到由大型語言模型(LLM)進行的評分或推理。
- **排程或選擇邏輯(scheduling/selection logic):** 依評估結果選出最佳的下一個行動或任務序列,可能運用佇列(queue)或進階規劃元件。
- **動態重新排序(dynamic re-prioritization):** 在情況改變時(如出現新的關鍵事件或截止期限將近)調整優先順序,維持代理的適應力與回應力。

優先排序可發生在不同層級:選擇總體目標(高層級目標優先排序)、為計畫中的步驟排序(子任務優先排序),或挑選下一個立即執行的行動(行動選擇)。這與人類團隊的運作如出一轍——管理者綜合各方意見來排定任務順序,讓代理在複雜、多目標的環境中展現更聰明、更有效率、更穩健的行為。

## 實務應用與使用案例

- **自動化客戶支援:** 把緊急請求(如系統中斷回報)排在例行事項(如重設密碼)之前,並可優先處理高價值客戶。
- **雲端運算:** 在需求高峰期把資源優先配置給關鍵應用程式,並把較不緊急的批次工作(batch jobs)挪到離峰時段以最佳化成本。
- **自動駕駛系統:** 持續為行動排序以確保安全,例如避免碰撞的煞車優先於車道紀律或燃油效率。
- **金融交易:** 交易機器人依市場狀況、風險承受度、利潤空間與即時新聞為交易排序,使高優先順序交易即時執行。
- **專案管理:** 依截止期限、相依關係、團隊可用性與策略重要性,為看板任務排序。
- **網路資安:** 依威脅嚴重度、潛在影響與資產關鍵性為警示排序,確保即時回應最危險的威脅。
- **個人助理 AI:** 依使用者自訂的重要性、即將到來的截止期限與當前情境,安排行事曆事件、提醒與通知。

這些例子共同說明:排定優先順序的能力,是 AI 代理得以提升表現與決策能力的根本所在。

## 動手實作範例

以下運用 LangChain 開發一個專案經理 AI 代理(Project Manager AI agent),能協助建立、排序並指派任務給團隊成員,展示如何把 LLM 與量身打造的工具結合以進行自動化專案管理。

```python
import os
import asyncio
from typing import List, Optional, Dict, Type
from dotenv import load_dotenv
from pydantic import BaseModel, Field
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.tools import Tool
from langchain_openai import ChatOpenAI
from langchain.agents import AgentExecutor, create_react_agent
from langchain.memory import ConversationBufferMemory

# --- 0. 組態與設定 ---
# 從 .env 檔案載入 OPENAI_API_KEY。
load_dotenv()

# ChatOpenAI 用戶端會自動從環境變數讀取 API 金鑰。
llm = ChatOpenAI(temperature=0.5, model="gpt-4o-mini")

# --- 1. 任務管理系統 ---
class Task(BaseModel):
    """代表系統中的單一任務。"""
    id: str
    description: str
    priority: Optional[str] = None  # P0、P1、P2
    assigned_to: Optional[str] = None  # 工作者名稱

class SuperSimpleTaskManager:
    """高效且穩健的記憶體內任務管理器。"""
    def __init__(self):
        # 使用字典(dictionary)以達成 O(1) 的查詢、更新與刪除。
        self.tasks: Dict[str, Task] = {}
        self.next_task_id = 1

    def create_task(self, description: str) -> Task:
        """建立並儲存一個新任務。"""
        task_id = f"TASK-{self.next_task_id:03d}"
        new_task = Task(id=task_id, description=description)
        self.tasks[task_id] = new_task
        self.next_task_id += 1
        print(f"DEBUG: Task created - {task_id}: {description}")
        return new_task

    def update_task(self, task_id: str, **kwargs) -> Optional[Task]:
        """使用 Pydantic 的 model_copy 安全地更新任務。"""
        task = self.tasks.get(task_id)
        if task:
            # 使用 model_copy 進行型別安全的更新。
            update_data = {k: v for k, v in kwargs.items() if v is not None}
            updated_task = task.model_copy(update=update_data)
            self.tasks[task_id] = updated_task
            print(f"DEBUG: Task {task_id} updated with {update_data}")
            return updated_task
        print(f"DEBUG: Task {task_id} not found for update.")
        return None

    def list_all_tasks(self) -> str:
        """列出系統中目前所有的任務。"""
        if not self.tasks:
            return "No tasks in the system."
        task_strings = []
        for task in self.tasks.values():
            task_strings.append(
                f"ID: {task.id}, Desc: '{task.description}', "
                f"Priority: {task.priority or 'N/A'}, "
                f"Assigned To: {task.assigned_to or 'N/A'}"
            )
        return "Current Tasks:\n" + "\n".join(task_strings)

task_manager = SuperSimpleTaskManager()

# --- 2. 專案經理代理的工具 ---
# 使用 Pydantic 模型作為工具參數,以獲得更好的驗證與清晰度。
class CreateTaskArgs(BaseModel):
    description: str = Field(description="該任務的詳細描述。")

class PriorityArgs(BaseModel):
    task_id: str = Field(description="要更新的任務 ID,例如 'TASK-001'。")
    priority: str = Field(description="要設定的優先順序。必須是 'P0'、'P1'、'P2' 其中之一。")

class AssignWorkerArgs(BaseModel):
    task_id: str = Field(description="要更新的任務 ID,例如 'TASK-001'。")
    worker_name: str = Field(description="要指派該任務的工作者名稱。")

def create_new_task_tool(description: str) -> str:
    """以給定的描述建立一個新的專案任務。"""
    task = task_manager.create_task(description)
    return f"Created task {task.id}: '{task.description}'."

def assign_priority_to_task_tool(task_id: str, priority: str) -> str:
    """為指定的任務 ID 指派優先順序(P0、P1、P2)。"""
    if priority not in ["P0", "P1", "P2"]:
        return "Invalid priority. Must be P0, P1, or P2."
    task = task_manager.update_task(task_id, priority=priority)
    return f"Assigned priority {priority} to task {task.id}." if task else f"Task {task_id} not found."

def assign_task_to_worker_tool(task_id: str, worker_name: str) -> str:
    """把任務指派給特定的工作者。"""
    task = task_manager.update_task(task_id, assigned_to=worker_name)
    return f"Assigned task {task.id} to {worker_name}." if task else f"Task {task_id} not found."

# 專案經理代理可使用的所有工具
pm_tools = [
    Tool(
        name="create_new_task",
        func=create_new_task_tool,
        description="先使用這個工具來建立一個新任務並取得它的 ID。",
        args_schema=CreateTaskArgs
    ),
    Tool(
        name="assign_priority_to_task",
        func=assign_priority_to_task_tool,
        description="在任務建立之後,使用這個工具來為任務指派優先順序。",
        args_schema=PriorityArgs
    ),
    Tool(
        name="assign_task_to_worker",
        func=assign_task_to_worker_tool,
        description="在任務建立之後,使用這個工具來把任務指派給特定的工作者。",
        args_schema=AssignWorkerArgs
    ),
    Tool(
        name="list_all_tasks",
        func=task_manager.list_all_tasks,
        description="使用這個工具來列出所有目前的任務及其狀態。"
    ),
]

# --- 3. 專案經理代理定義 ---
pm_prompt_template = ChatPromptTemplate.from_messages([
    ("system", """你是一個專注的專案經理 LLM 代理。你的目標是有效率地管理專案任務。
當你收到一個新的任務請求時,請依下列步驟進行:
1. 首先,使用 `create_new_task` 工具以給定的描述建立任務。你必須先做這一步以取得 `task_id`。
2. 接著,分析使用者的請求,看看是否提到優先順序或指派對象。
- 如果提到優先順序(例如「緊急」、「盡快」、「關鍵」),就對應到 P0,使用 `assign_priority_to_task`。
- 如果提到某位工作者,就使用 `assign_task_to_worker`。
3. 如果有任何資訊(優先順序、指派對象)缺漏,你必須做出合理的預設指派(例如指派 P1 優先順序,並指派給 'Worker A')。
4. 任務處理完成後,使用 `list_all_tasks` 來顯示最終狀態。
可用的工作者:'Worker A'、'Worker B'、'Review Team'
優先順序層級:P0(最高)、P1(中等)、P2(最低)
"""),
    ("placeholder", "{chat_history}"),
    ("human", "{input}"),
    ("placeholder", "{agent_scratchpad}")
])

# 建立代理執行器(agent executor)
pm_agent = create_react_agent(llm, pm_tools, pm_prompt_template)
pm_agent_executor = AgentExecutor(
    agent=pm_agent,
    tools=pm_tools,
    verbose=True,
    handle_parsing_errors=True,
    memory=ConversationBufferMemory(memory_key="chat_history", return_messages=True)
)

# --- 4. 簡單的互動流程 ---
async def run_simulation():
    print("--- Project Manager Simulation ---")

    # 情境 1:處理一個新的緊急功能請求
    print("\n[User Request] I need a new login system implemented ASAP. It should be assigned to Worker B.")
    await pm_agent_executor.ainvoke({"input": "Create a task to implement a new login system. It's urgent and should be assigned to Worker B."})

    print("\n" + "-"*60 + "\n")

    # 情境 2:處理一個較不緊急、細節較少的內容更新
    print("[User Request] We need to review the marketing website content.")
    await pm_agent_executor.ainvoke({"input": "Manage a new task: Review marketing website content."})

    print("\n--- Simulation Complete ---")

# 執行模擬
if __name__ == "__main__":
    asyncio.run(run_simulation())
```

這段程式碼以 Python 與 LangChain 實作一個簡單的任務管理系統,模擬由 LLM 驅動的專案經理代理。`SuperSimpleTaskManager` 用字典在記憶體中高效管理任務以快速取回資料;每項任務由 `Task` Pydantic 模型表示,含唯一識別碼、描述、選用的優先順序(P0、P1、P2)與選用的指派對象,並提供建立、修改與取回任務的方法。

代理透過一組工具與任務管理器互動:建立任務、指派優先順序、分配人員、列出所有任務;每個工具都以 Pydantic 模型界定參數以確保驗證。`AgentExecutor` 配置了語言模型、工具集與對話記憶元件以維持情境連續性,並透過特定的 `ChatPromptTemplate` 引導代理先建立任務、再依情況指派優先順序與人員,最後輸出完整任務清單;資訊缺漏時則套用預設(P1、'Worker A')。非同步的 `run_simulation` 執行兩個情境——一個指定人員的緊急任務,一個輸入極少的較不緊急任務——並因 `verbose=True` 將代理的行動與推理輸出到主控台。

## 重點速覽

**是什麼(What):** 在複雜環境中運作的 AI 代理,面臨眾多潛在行動、相互衝突的目標與有限資源。若缺乏決定下一步的明確方法,代理便會變得既無效率又無成效,造成顯著的運作延遲,甚至完全無法達成主要目標。核心挑戰在於:如何駕馭龐大的選項數量,確保代理有目的、有邏輯地行動。

**為什麼(Why):** 優先排序模式提供標準化解法,讓代理依明確準則(急迫性、重要性、相依關係、資源成本)評估每個潛在行動,判定出最關鍵、最及時的方針。這項代理(Agentic)能力讓系統動態適應變化、有效管理受限資源;透過聚焦最高優先項目,代理行為變得更聰明、更穩健,並更貼合策略目標。

**經驗法則(Rule of thumb):** 當代理系統必須在資源受限下,自主管理多項(且經常相互衝突的)任務或目標,以在動態環境中有效運作時,就使用優先排序模式。

**視覺摘要:**

![圖 1:優先排序設計模式](assets/20-prioritization/fig-1-prioritization-pattern.png)

*圖 1:優先排序設計模式*

## 重點整理

- 優先排序讓 AI 代理能在複雜、多面向的環境中有效運作。
- 代理運用既定準則(例如急迫性、重要性與相依關係)來評估任務並為其排序。
- 動態重新排序讓代理能因應即時的變化,調整其運作焦點。
- 優先排序發生在不同層級,涵蓋總體的策略目標,以及立即的戰術決策。
- 有效的優先排序,能提升 AI 代理的效率與運作穩健度。

## 結論

優先排序是高效代理型 AI(agentic AI)的基石,讓系統帶著目的與智慧駕馭動態環境的複雜性。代理依既定準則(急迫性、重要性、相依關係)自主評估眾多相互衝突的任務與目標,就「有限資源該投注何處」做出有理據的決策,超越單純的任務執行,成為主動、具策略性的決策者,展現近乎人類的精巧推理。

其中的關鍵特徵是動態重新排序,賦予代理在條件改變時即時調整焦點的自主性。正如程式碼範例所示,代理能詮釋含糊的請求、自主選用適當工具,並以合乎邏輯的順序安排行動——這種自我管理工作流程的能力,正是真正的代理系統與單純自動化腳本的分野。優先排序同時發生於總體策略目標與立即戰術決策等不同層級;精通它,是打造能在複雜真實情境中有效、可靠運作之穩健智慧型代理的根本所在。

## 參考資料

1. Examining the Security of Artificial Intelligence in Project Management: A Case Study of AI-driven Project Scheduling and Resource Allocation in Information Systems Projects: <https://www.irejournals.com/paper-details/1706160>
2. AI-Driven Decision Support Systems in Agile Software Project Management: Enhancing Risk Mitigation and Resource Allocation: <https://www.mdpi.com/2079-8954/13/3/208>
