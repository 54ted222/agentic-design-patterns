# 第 20 章:優先排序(Prioritization)

複雜動態環境中,代理(Agent)常面臨眾多潛在行動、衝突目標與有限資源。缺乏決定下一步的明確流程,就會效率下降、延遲甚至無法達標。優先排序模式讓代理依重要性、急迫性、相依關係與既定準則評估並排序任務,把心力集中在最關鍵處。

## 優先排序模式總覽

當代理同時面對多項需求,優先排序能讓重要或緊急的活動優先於次要者——在資源受限、時間有限、目標衝突的現實中尤為關鍵。其運作含四個要素:

- **準則定義(criteria definition):** 建立評估指標,如急迫性(時間敏感度)、重要性(對主要目標的影響)、相依關係(是否為他項前置)、資源可用性、成本效益,以及使用者偏好。
- **任務評估(task evaluation):** 依準則評估每項任務,方法可從簡單規則到由大型語言模型(LLM)評分或推理。
- **排程或選擇邏輯(scheduling/selection logic):** 依評估結果選出最佳的下一個行動或序列,可能運用佇列或規劃元件。
- **動態重新排序(dynamic re-prioritization):** 在情況改變時(如新關鍵事件或截止將近)調整順序,維持適應力。

優先排序可發生在不同層級:選總體目標(目標優先排序)、為計畫步驟排序(子任務優先排序),或挑下一個立即行動(行動選擇)。這如同人類團隊——管理者綜合各方意見排定順序,讓代理在多目標環境中更聰明、更穩健。

## 實務應用與使用案例

- **自動化客戶支援:** 把緊急請求(如系統中斷)排在例行事項(如重設密碼)之前,並優先處理高價值客戶。
- **雲端運算:** 高峰期把資源優先配給關鍵應用,把較不緊急的批次工作(batch jobs)挪到離峰以最佳化成本。
- **自動駕駛系統:** 持續為行動排序以確保安全,如避撞煞車優先於車道紀律或燃油效率。
- **金融交易:** 交易機器人依市場、風險、利潤與即時新聞排序,使高優先交易即時執行。
- **專案管理:** 依截止期限、相依關係、團隊可用性與策略重要性為看板任務排序。
- **網路資安:** 依威脅嚴重度、潛在影響與資產關鍵性為警示排序,即時回應最危險威脅。
- **個人助理 AI:** 依使用者自訂重要性、截止期限與當前情境安排行事曆、提醒與通知。

排定優先順序的能力,是 AI 代理提升表現與決策力的根本。

## 動手實作範例

以下用 LangChain 開發一個專案經理 AI 代理(Project Manager AI agent),協助建立、排序並指派任務,展示如何結合 LLM 與自訂工具進行自動化專案管理。

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

`SuperSimpleTaskManager` 用字典在記憶體中管理任務,每項任務以 `Task` Pydantic 模型表示(識別碼、描述、選用優先順序與指派對象)。代理透過四個工具(建立、指派優先順序、分配人員、列出任務)操作,各工具以 Pydantic 模型界定參數做驗證。`AgentExecutor` 結合語言模型、工具集與對話記憶,並由 `ChatPromptTemplate` 引導代理先建立任務、再依情況指派優先順序與人員、最後列出清單;資訊缺漏時套用預設(P1、'Worker A')。`run_simulation` 跑兩個情境——一個指定人員的緊急任務、一個輸入極少的任務——並因 `verbose=True` 將推理過程印到主控台。

## 重點速覽

**是什麼(What):** 複雜環境中的 AI 代理面臨眾多行動、衝突目標與有限資源。缺乏決定下一步的明確方法,就會既無效率又無成效,延遲甚至無法達標。核心挑戰是:如何駕馭龐大的選項數量,讓代理有目的、有邏輯地行動。

**為什麼(Why):** 優先排序模式提供標準化解法,讓代理依明確準則(急迫性、重要性、相依關係、資源成本)評估每個行動,判定最關鍵、最及時的方針。這項能力讓系統動態適應變化、管理受限資源;聚焦最高優先項目,行為便更聰明、更穩健、更貼合策略目標。

**經驗法則(Rule of thumb):** 當代理系統須在資源受限下,自主管理多項(且常相互衝突的)任務或目標,以在動態環境中有效運作時,就用優先排序模式。

**視覺摘要:**

![圖 1:優先排序設計模式](assets/20-prioritization/fig-1-prioritization-pattern.png)

*圖 1:優先排序設計模式*

## 結論

優先排序是高效代理型 AI(agentic AI)的基石。代理依既定準則(急迫性、重要性、相依關係)自主評估眾多衝突的任務與目標,就「有限資源該投注何處」做出有理據的決策,從單純執行升級為主動、具策略性的決策者。

其關鍵特徵是動態重新排序——條件改變時即時調整焦點。如範例所示,代理能詮釋含糊請求、自主選用工具、依邏輯排序行動;這種自我管理工作流程的能力,正是真正代理系統與自動化腳本的分野。優先排序橫跨總體策略目標與立即戰術決策,精通它是打造穩健、可靠智慧型代理的根本。

## 參考資料

1. Examining the Security of Artificial Intelligence in Project Management: A Case Study of AI-driven Project Scheduling and Resource Allocation in Information Systems Projects: <https://www.irejournals.com/paper-details/1706160>
2. AI-Driven Decision Support Systems in Agile Software Project Management: Enhancing Risk Mitigation and Resource Allocation: <https://www.mdpi.com/2079-8954/13/3/208>
