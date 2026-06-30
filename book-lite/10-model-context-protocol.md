# 第 10 章:模型情境協定(Model Context Protocol)

要讓 LLM 有效扮演代理(agent),能力就必須超越多模態生成,還要能與外部環境互動——存取最新資料、運用外部軟體、執行操作任務。模型情境協定(Model Context Protocol,MCP)為此而生:它提供標準化介面,讓 LLM 與外部資源對接,是促成一致且可預測整合的關鍵。

## MCP 模式總覽

MCP 像是一個萬用轉接頭,讓任何 LLM(如 Gemini、GPT、Mixtral、Claude)不必為每個對象客製整合,就能插接到任何外部系統、資料庫或工具。它是一套開放標準,統一了 LLM 與外部應用程式、資料來源及工具的溝通方式。

MCP 採主從式(client-server)架構:MCP 伺服器(server)對外揭露資料(資源,resources)、互動式範本(提示,prompts)與可執行函式(工具,tools),再由 MCP 用戶端(client,可以是 LLM 宿主應用程式或 AI 代理本身)消費。這種標準化大幅降低了整合複雜度。

不過 MCP 只是一份「代理介面」契約,成效取決於底層 API 的設計。風險在於:開發者可能直接把舊式 API 原封包裝,而這對代理往往不是最佳做法。例如工單系統只能逐一取得完整工單,代理要摘要高優先度工單時就會既慢又不準。底層 API 應補上過濾、排序這類確定性功能,協助非確定性的代理高效運作——代理不會神奇取代確定性工作流程,反而常需要更強的確定性支援。

同理,MCP 也可能包裝一個輸入或輸出對代理本質上難以理解的 API。API 唯有在資料格式對代理友善時才有用,而這正是 MCP 不會強制保證的。例如文件儲存庫若以 PDF 回傳檔案,但代理無法解析 PDF,這個伺服器就形同無用;更好的做法是回傳文字版本(如 Markdown)。開發者不能只想到「連接」,還必須考量所交換資料的本質。

## MCP 與工具函式呼叫(Tool Function Calling)的比較

MCP 與工具函式呼叫都讓 LLM 能與外部能力互動並執行動作,但做法與抽象層次不同。

工具函式呼叫是 LLM 對某個預先定義好的工具發出的直接請求(此處「工具」與「函式」交替使用),特徵是一對一(one-to-one)溝通:LLM 依使用者意圖格式化請求,應用程式執行後把結果回傳給 LLM。這個過程通常是專有的,在不同 LLM 供應商之間各有差異。

MCP 則是標準化介面,讓 LLM 得以發現、溝通並運用外部能力。它是一套開放協定,促成與各式工具系統的互動,目標是建立一個生態系:任何符合規範的工具都能被任何符合規範的 LLM 存取,從而帶來互通性(interoperability)、可組合性(composability)與可重用性(reusability)。藉由聯邦式(federated)模型,只需把各自獨立的舊式服務包進符合 MCP 規範的介面,就能帶進現代生態系,被組合進新的工作流程並由 LLM 協調,無需昂貴重寫即獲得敏捷性與可重用性。

以下拆解兩者的根本差異:

| 特性 | 工具函式呼叫(Tool Function Calling) | 模型情境協定(MCP) |
| --- | --- | --- |
| 標準化(Standardization) | 專有且與供應商綁定。格式與實作在不同的 LLM 供應商之間各有差異。 | 一套開放、標準化的協定,促進不同 LLM 與工具之間的互通性。 |
| 範疇(Scope) | 一種讓 LLM 請求執行某個特定、預先定義好之函式的直接機制。 | 一個更廣泛的框架,規範 LLM 與外部工具如何彼此發現與溝通。 |
| 架構(Architecture) | LLM 與應用程式之工具處理邏輯之間的一對一互動。 | 一種主從式架構,讓由 LLM 驅動的應用程式(用戶端)能連接並運用各式各樣的 MCP 伺服器(工具)。 |
| 發現(Discovery) | LLM 是在特定對話的情境中被明確告知有哪些工具可用。 | 能對可用工具進行動態發現。MCP 用戶端可以查詢伺服器,以了解它提供哪些能力。 |
| 可重用性(Reusability) | 工具整合往往與所使用的特定應用程式及 LLM 緊密耦合。 | 促進可重用、獨立式「MCP 伺服器」的開發,這些伺服器可被任何符合規範的應用程式存取。 |

簡而言之:函式呼叫像給 AI 一組客製打造的特定工具,對任務固定的工作坊很有效率;MCP 則像標準化的電源插座系統,本身不提供工具,卻讓任何符合規範的工具都能插上運作,打造出動態擴充的工作坊。簡單應用程式用特定工具就夠;但對需要持續調適、複雜且互連的 AI 系統,MCP 這類萬用標準不可或缺。

## MCP 的其他考量

要評估 MCP 是否適用,還需考量幾個關鍵面向:

- **工具 vs. 資源 vs. 提示:** 資源是靜態資料(如 PDF、資料庫紀錄);工具是執行動作的可執行函式(如寄信、查 API);提示是引導 LLM 如何與資源或工具互動的範本,確保互動有結構且有效。
- **可發現性(Discoverability):** MCP 用戶端可動態查詢伺服器提供哪些工具與資源。這種「即時(just-in-time)」發現,對需在不重新部署下調適新能力的代理很強大。
- **安全性(Security):** 揭露工具與資料需要穩固的安全措施。實作必須納入身分驗證(authentication)與授權(authorization),控制哪些用戶端可存取哪些伺服器、能執行哪些動作。
- **實作(Implementation):** MCP 是開放標準,但實作可能複雜。供應商(如 Anthropic)或 FastMCP 已提供 SDK,把大量樣板程式碼抽象化,讓建立與連接用戶端、伺服器更容易。
- **錯誤處理(Error Handling):** 協定必須定義錯誤(工具執行失敗、伺服器不可用、請求無效)如何回傳給 LLM,好讓它理解失敗並嘗試替代做法。
- **本機 vs. 遠端伺服器:** MCP 伺服器可部署於代理同一台本機,或不同的遠端伺服器。處理敏感資料時可為速度與安全選本機;遠端則允許整個組織共享、可擴展地存取通用工具。
- **隨選 vs. 批次:** MCP 同時支援隨選互動式工作階段與大規模批次處理,如何選擇取決於應用程式(即時對話式代理 vs. 批次資料分析管線)。
- **傳輸機制(Transportation Mechanism):** 協定也定義傳輸層。本機互動使用透過 STDIO 的 JSON-RPC,達成高效率的行程間通訊;遠端連線則用對網路友善的 Streamable HTTP 與伺服器推送事件(SSE),促成持久高效的主從式通訊。

MCP 以主從式模型標準化資訊流,各元件如下:

1. **大型語言模型(LLM):** 核心智慧。處理請求、擬定計畫,並決定何時需存取外部資訊或執行動作。
2. **MCP 用戶端(MCP Client):** 包覆在 LLM 外層的封裝層,扮演中介者,把 LLM 的意圖轉譯成符合 MCP 標準的請求,並負責發現、連接與溝通。
3. **MCP 伺服器(MCP Server):** 通往外部世界的閘道,向獲授權的用戶端揭露工具、資源與提示。每個伺服器通常負責某個特定領域(如內部資料庫、電子郵件服務、公開 API)。
4. **選擇性的第三方(3P)服務:** MCP 伺服器所管理並揭露的實際外部工具、應用程式或資料來源,是真正執行動作的最終端點(如查詢專有資料庫、與 SaaS 平台互動、呼叫天氣 API)。

互動流程如下:

1. **發現(Discovery):** 用戶端代表 LLM 查詢伺服器有哪些能力,伺服器以清單(manifest)回應其工具(如 `send_email`)、資源(如 `customer_database`)與提示。
2. **請求擬定(Request Formulation):** LLM 判定要用某個工具(如寄信),擬定請求,指定工具(`send_email`)與必要參數(收件人、主旨、內文)。
3. **用戶端通訊(Client Communication):** 用戶端把 LLM 擬定的請求作為標準化呼叫傳給對應伺服器。
4. **伺服器執行(Server Execution):** 伺服器驗證用戶端身分與請求,接著透過底層軟體執行動作(如呼叫郵件 API 的 `send()`)。
5. **回應與情境更新(Response and Context Update):** 執行後伺服器回傳標準化回應(成功與否、相關輸出如確認 ID),用戶端再把結果交回 LLM 更新情境,推進下一步。

## 實務應用與使用案例

MCP 大幅拓展了 AI/LLM 的能力。以下是九個關鍵使用案例:

- **資料庫整合:** 讓 LLM 與代理無縫存取結構化資料。例如用「MCP Toolbox for Databases」,代理可由自然語言驅動查詢 Google BigQuery、生成報告或更新紀錄。
- **生成式媒體協調:** 透過「MCP Tools for Genmedia Services」,代理可協調涉及 Google Imagen(影像)、Veo(影片)、Chirp 3 HD(語音)、Lyria(音樂)的工作流程,進行動態內容創作。
- **外部 API 互動:** 提供標準化方式讓 LLM 呼叫任何外部 API,如擷取即時天氣、股價、寄信或與 CRM 互動。
- **基於推理的資訊擷取:** 借助 LLM 推理能力,MCP 能依查詢精準擷取資訊——不像傳統搜尋回傳整份文件,而是擷取出直接回答複雜問題的那一個條款或陳述。
- **客製化工具開發:** 開發者可建構工具並透過 MCP 伺服器(如 FastMCP)揭露,讓內部函式或專有系統以標準化格式提供給 LLM,無需修改 LLM。
- **標準化的 LLM 對應用程式通訊:** MCP 確保一致的通訊層,降低整合負擔、促進供應商間互通,並簡化複雜代理系統的開發。
- **複雜工作流程協調:** 組合多個 MCP 揭露的工具與資料,代理可協調多步驟流程,例如擷取客戶資料、生成個人化行銷影像、草擬並寄出量身打造的電子郵件。
- **物聯網裝置控制:** 代理可用 MCP 向智慧家居、工業感測器或機器人發送指令,實現對實體系統的自然語言控制與自動化。
- **金融服務自動化:** 讓 LLM 與金融資料、交易平台或合規系統互動,分析市場資料、執行交易、生成理財建議或自動化法規申報,並維持安全標準化的通訊。

簡言之,MCP 讓代理能從資料庫、API 與網路存取即時資訊,執行寄信、更新紀錄、控制裝置等動作,並整合多方來源資料完成複雜任務;它也支援媒體生成工具。

## 使用 ADK 的動手實作範例

本節說明如何連接提供檔案系統操作的本機 MCP 伺服器,使 ADK 代理能與本機檔案系統互動。

### 使用 MCPToolset 設定代理

建立一個 `agent.py`(例如 `./adk_agent_samples/mcp_agent/agent.py`),在 `LlmAgent` 的 `tools` 清單中實例化 `MCPToolset`。關鍵是把 `args` 中的目錄路徑換成本機某個 MCP 伺服器可存取目錄的絕對路徑,該目錄即代理檔案系統操作的根目錄。

```python
import os
from google.adk.agents import LlmAgent
from google.adk.tools.mcp_tool.mcp_toolset import MCPToolset, StdioServerParameters

# 建立指向 'mcp_managed_files' 資料夾的絕對路徑,該資料夾與本腳本同目錄,
# 確保示範時開箱即用;正式環境應指向更持久且安全的位置。
TARGET_FOLDER_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mcp_managed_files")

# 在代理使用前確保目標目錄已存在。
os.makedirs(TARGET_FOLDER_PATH, exist_ok=True)

root_agent = LlmAgent(
    model='gemini-2.0-flash',
    name='filesystem_assistant_agent',
    instruction=(
        '協助使用者管理檔案。你可以列出檔案、讀取檔案以及寫入檔案。'
        f'你正在以下這個目錄中操作:{TARGET_FOLDER_PATH}'
    ),
    tools=[
        MCPToolset(
            connection_params=StdioServerParameters(
                command='npx',
                args=[
                    "-y",  # 給 npx 的引數,用來自動確認安裝
                    "@modelcontextprotocol/server-filesystem",
                    # 這裡「必須」是指向某個資料夾的絕對路徑。
                    TARGET_FOLDER_PATH,
                ],
            ),
            # 選擇性:可過濾 MCP 伺服器揭露的工具。
            # 例如只允許讀取:
            # tool_filter=['list_directory', 'read_file']
        )
    ],
)
```

`npx`(Node Package Execute)隨附於 npm 5.2.0 及之後版本,能直接從 npm registry 執行 Node.js 套件而免去全域安裝。它常被用來執行眾多以 Node.js 套件形式發布的社群 MCP 伺服器。

還需建立 `__init__.py`(與 `agent.py` 同目錄),確保 `agent.py` 被識別為 ADK 可發現的 Python 套件。

```python
# ./adk_agent_samples/mcp_agent/__init__.py
from . import agent
```

也可使用其他受支援的指令。例如連接到 `python3`:

```python
connection_params = StdioConnectionParams(
    server_params={
        "command": "python3",
        "args": ["./agent/mcp_server.py"],
        "env": {
            "SERVICE_ACCOUNT_PATH": SERVICE_ACCOUNT_PATH,
            "DRIVE_FOLDER_ID": DRIVE_FOLDER_ID
        }
    }
)
```

UVX 是運用 `uv` 在暫時、隔離的 Python 環境中執行指令的命令列工具,讓你執行 Python 工具與套件而無需全域或專案安裝。可透過 MCP 伺服器執行它。

```python
connection_params = StdioConnectionParams(
    server_params={
        "command": "uvx",
        "args": ["mcp-google-sheets@latest"],
        "env": {
            "SERVICE_ACCOUNT_PATH": SERVICE_ACCOUNT_PATH,
            "DRIVE_FOLDER_ID": DRIVE_FOLDER_ID
        }
    }
)
```

MCP 伺服器建立後,下一步就是連接到它。

### 透過 ADK Web 連接 MCP 伺服器

在終端機切換到 `mcp_agent` 的上層目錄(如 `adk_agent_samples`),執行 `adk web`:

```bash
cd ./adk_agent_samples # 或你對應的上層目錄
adk web
```

ADK Web UI 載入後,從代理選單選擇 `filesystem_assistant_agent`,並試試這類提示:

- 「顯示這個資料夾的內容。」
- 「讀取 `sample.txt` 檔案。」(假設 `sample.txt` 位於 `TARGET_FOLDER_PATH`。)
- 「`another_file.md` 裡有什麼?」

### 使用 FastMCP 建立 MCP 伺服器

FastMCP 是高階 Python 框架,把協定複雜性抽象掉,讓開發者專注於核心邏輯。它讓開發者用簡單的 Python 裝飾器(decorator)快速定義工具、資源與提示,並能自動生成綱要(schema)——解讀函式簽名、型別提示與說明字串,建構出 AI 模型介面規格,把手動設定降到最低、減少人為錯誤。

除基本工具建立外,FastMCP 還支援伺服器組合(server composition)與代理轉送(proxying)等進階模式,讓複雜多元件系統得以模組化開發、讓既有服務無縫整合進 AI 可存取的框架,並針對高效率、分散式、可擴展的應用程式做了最佳化。

### 使用 FastMCP 設定伺服器

以下示範一個基本的「greet」(問候)工具。啟用後,ADK 代理與其他 MCP 用戶端就能透過 HTTP 與它互動。

```python
# fastmcp_server.py
# 本腳本示範如何用 FastMCP 建立一個簡單的 MCP 伺服器,
# 它揭露單一一個用來產生問候語的工具。

# 1. 請先安裝 FastMCP:
# pip install fastmcp

from fastmcp import FastMCP, Client

# 初始化 FastMCP 伺服器。
mcp_server = FastMCP()

# 定義一個簡單的工具函式。
# `@mcp_server.tool` 裝飾器會把這個函式註冊為 MCP 工具。
# docstring 會成為這個工具給 LLM 看的描述。
@mcp_server.tool
def greet(name: str) -> str:
    """
    產生一句個人化的問候語。

    參數:
        name:要問候的對象姓名。

    回傳:
        一個問候字串。
    """
    return f"Hello, {name}! Nice to meet you."

# 或者,若想從腳本中執行它:
if __name__ == "__main__":
    mcp_server.run(
        transport="http",
        host="127.0.0.1",
        port=8000
    )
```

這段腳本定義單一函式 `greet`,接收名字並回傳個人化問候語。`@tool()` 裝飾器自動把它註冊為 AI 或其他程式可用的工具,FastMCP 會用函式的說明字串與型別提示告訴代理:工具如何運作、需要哪些輸入、回傳什麼。

執行時會啟動 FastMCP 伺服器,在 `localhost:8000` 監聽,讓 `greet` 作為網路服務對外提供。接著可設定代理連接此伺服器,把 `greet` 當作更大型任務的一部分使用。伺服器會持續運行直到手動停止。

### 使用 ADK 代理消費 FastMCP 伺服器

可把 ADK 代理設為 MCP 用戶端來使用運行中的 FastMCP 伺服器,需設定 `HttpServerParameters` 並填入伺服器網路位址(通常是 `http://localhost:8000`)。

可加入 `tool_filter` 把工具使用限制在特定工具(如 `'greet'`)。當收到「Greet John Doe」這類提示時,代理內嵌的 LLM 會辨識出 `'greet'` 工具,以引數「John Doe」呼叫並回傳結果。這示範了如何把透過 MCP 揭露的自訂工具與 ADK 代理整合。

建立代理檔案(例如 `./adk_agent_samples/fastmcp_client_agent/agent.py`),用 `HttpServerParameters` 與運行中的 FastMCP 伺服器建立連線:

```python
# ./adk_agent_samples/fastmcp_client_agent/agent.py
import os
from google.adk.agents import LlmAgent
from google.adk.tools.mcp_tool.mcp_toolset import MCPToolset, HttpServerParameters

# 定義 FastMCP 伺服器的位址。
# 請確認你的 fastmcp_server.py 正在這個連接埠上運行。
FASTMCP_SERVER_URL = "http://localhost:8000"

root_agent = LlmAgent(
    model='gemini-2.0-flash',  # 或你偏好的模型
    name='fastmcp_greeter_agent',
    instruction='你是一個友善的助理,可以依照人們的名字向他們問候。請使用「greet」工具。',
    tools=[
        MCPToolset(
            connection_params=HttpServerParameters(
                url=FASTMCP_SERVER_URL,
            ),
            # 選擇性:過濾 MCP 伺服器揭露的工具
            # 本範例中我們預期只有 'greet'
            tool_filter=['greet']
        )
    ],
)
```

這段腳本定義一個使用 Gemini 模型的 `fastmcp_greeter_agent`,賦予它「友善助理、負責問候」的指令,並用 `MCPToolset` 連接到運行在 `localhost:8000`(即前一範例的 FastMCP 伺服器),授予存取其上 `greet` 工具的權限。本質上,這設定了系統的用戶端部分:一個了解目標、也清楚該用哪個外部工具的代理。

別忘了在 `fastmcp_client_agent` 目錄建立 `__init__.py`,確保代理被識別為 ADK 可發現的套件。

操作步驟:先在新終端機執行 `python fastmcp_server.py` 啟動伺服器;接著前往 `fastmcp_client_agent` 的上層目錄(如 `adk_agent_samples`)執行 `adk web`;UI 載入後選擇 `fastmcp_greeter_agent`,輸入「Greet John Doe」測試。代理將使用伺服器上的 `greet` 工具產生回應。

## 重點速覽

**是什麼(What):** 要扮演有效的代理,LLM 必須超越文字生成,具備與外部環境互動以存取最新資料、運用外部軟體的能力。若沒有標準化的溝通方法,LLM 與每個外部工具或資料來源的整合都會變成客製、複雜且無法重用的工作。這種臨時拼湊的做法阻礙可擴展性,使複雜互連的 AI 系統既難建構又缺乏效率。

**為什麼(Why):** MCP 提供標準化解法,扮演 LLM 與外部系統之間的萬用介面。它以開放協定定義外部能力如何被發現與使用,並以主從式模型讓伺服器向任何符合規範的用戶端揭露工具、資源與提示;LLM 驅動的應用程式作為用戶端,以可預測的方式動態發現並使用資源。這孕育出由可互通、可重用元件構成的生態系,大幅簡化複雜代理工作流程的開發。

**經驗法則(Rule of thumb):** 當你建構複雜、可擴展或企業級的代理系統,需與多樣且不斷演進的外部工具、資料來源及 API 互動時,就使用 MCP;當互通性是優先考量、或代理需在不重新部署下動態發現新能力時,它都是理想選擇。若應用程式較簡單、函式數量固定有限,直接使用工具函式呼叫可能就已足夠。

## 視覺摘要

![圖 1:模型情境協定。使用者透過提示與作為 MCP 用戶端的代理互動,代理再經由 MCP 伺服器連接到工具、API、舊式服務、資料服務與包裝層等外部資源,最終把輸出回傳給使用者。](assets/10-model-context-protocol/fig-1-model-context-protocol.png)

*圖 1:模型情境協定(Model Context Protocol)。使用者送出提示,作為 MCP 用戶端的代理透過 MCP 伺服器連接到工具(Tools)、API、舊式服務(Legacy Services)、資料服務(Data Services,如網頁、外部資料庫等)與包裝層(Wrappers),並把處理後的輸出回傳給使用者。*

## 重點整理

- MCP 是一套開放標準,促進 LLM 與外部應用程式、資料來源及工具之間的標準化溝通。
- 它採主從式架構,定義揭露與消費資源、提示與工具的方法。
- ADK 同時支援運用既有 MCP 伺服器,以及透過 MCP 伺服器揭露 ADK 工具。
- FastMCP 簡化 MCP 伺服器的開發與管理,尤其適合揭露以 Python 實作的工具。
- MCP Tools for Genmedia Services 讓代理能整合 Google Cloud 的生成式媒體能力(Imagen、Veo、Chirp 3 HD、Lyria)。
- MCP 讓 LLM 與代理能與真實系統互動、存取動態資訊,並執行超越文字生成的動作。

## 結論

MCP 是一套開放標準,以主從式架構促進 LLM 與外部系統之間的溝通,讓 LLM 透過標準化工具存取資源、運用提示並執行動作。它讓 LLM 能與資料庫互動、管理生成式媒體工作流程、控制 IoT 裝置並自動化金融服務。本章的實務範例示範了如何設定代理與 MCP 伺服器(檔案系統伺服器與 FastMCP 伺服器)溝通,並說明它與 ADK 的整合。MCP 是開發互動式 AI 代理的關鍵元件,讓代理的能耐得以超越基本語言能力。

## 參考資料

1. Model Context Protocol (MCP) Documentation. (Latest). Model Context Protocol (MCP). <https://google.github.io/adk-docs/mcp/>
2. FastMCP Documentation. FastMCP. <https://github.com/jlowin/fastmcp>
3. MCP Tools for Genmedia Services. MCP Tools for Genmedia Services. <https://google.github.io/adk-docs/mcp/#mcp-servers-for-google-cloud-genmedia>
4. MCP Toolbox for Databases Documentation. (Latest). MCP Toolbox for Databases. <https://google.github.io/adk-docs/mcp/databases/>
