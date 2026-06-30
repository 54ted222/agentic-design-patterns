# 第 15 章:代理間通訊(Inter-Agent Communication, A2A)

單一 AI 代理處理複雜、多面向問題時往往受限。代理間通訊(A2A)讓不同框架建構的代理得以協作:協調、任務委派與資訊交換。Google 的 A2A 協定即為此打造的開放標準。本章介紹 A2A 與其在 Google ADK 中的實作。

## 代理間通訊模式總覽

Agent2Agent(A2A)是開源標準,讓以 LangGraph、CrewAI、Google ADK 等不同技術開發的代理能互通協作,不受框架差異影響。它獲 Atlassian、Box、LangChain、MongoDB、Salesforce、SAP、ServiceNow 等公司支持,Microsoft 計畫整合進 Azure AI Foundry 與 Copilot Studio,Auth0、SAP 亦在跟進。

## A2A 的核心概念

A2A 建立在數個支柱上:核心參與者、代理卡、代理探索、通訊與任務、互動機制與安全性。

**核心參與者(Core Actors):** 三個主要實體:

- **使用者(User):** 發起對代理協助的請求。
- **A2A 用戶端(Client Agent):** 代表使用者請求動作或資訊的應用程式或代理。
- **A2A 伺服器(Remote Agent):** 以 HTTP 端點處理請求並回傳結果的代理,對用戶端而言是「不透明(opaque)」的系統,內部細節不需外露。

**代理卡(Agent Card):** 代理的數位身分,通常為 JSON 檔案,涵蓋互動與自動探索所需資訊:身分、端點 URL、版本、能力(如串流、推播通知)、技能、預設輸入/輸出模式與驗證需求。以下為 WeatherBot 範例:

```json
{
  "name": "WeatherBot",
  "description": "提供準確的天氣預報與歷史資料。",
  "url": "http://weather-service.example.com/a2a",
  "version": "1.0.0",
  "capabilities": {
    "streaming": true,
    "pushNotifications": false,
    "stateTransitionHistory": true
  },
  "authentication": {
    "schemes": [
      "apiKey"
    ]
  },
  "defaultInputModes": [
    "text"
  ],
  "defaultOutputModes": [
    "text"
  ],
  "skills": [
    {
      "id": "get_current_weather",
      "name": "取得目前天氣",
      "description": "檢索任何地點的即時天氣。",
      "inputModes": [
        "text"
      ],
      "outputModes": [
        "text"
      ],
      "examples": [
        "巴黎現在的天氣如何?",
        "東京目前的天氣狀況"
      ],
      "tags": [
        "weather",
        "current",
        "real-time"
      ]
    },
    {
      "id": "get_forecast",
      "name": "取得預報",
      "description": "取得未來 5 天的天氣預測。",
      "inputModes": [
        "text"
      ],
      "outputModes": [
        "text"
      ],
      "examples": [
        "紐約未來 5 天的預報",
        "這個週末倫敦會下雨嗎?"
      ],
      "tags": [
        "weather",
        "forecast",
        "prediction"
      ]
    }
  ]
}
```

**代理探索(Agent Discovery):** 讓用戶端找到代理卡,有三種策略:

- **眾所周知的 URI(Well-Known URI):** 託管於標準路徑(如 `/.well-known/agent.json`),適合公開、自動化存取。
- **策展註冊中心(Curated Registries):** 集中式目錄供發布與查詢,適合需集中管理與存取控制的企業。
- **直接設定(Direct Configuration):** 代理卡嵌入或私下分享,適用緊密耦合或不需動態探索的私有系統。

無論採何種方式,代理卡端點都應以存取控制、相互 TLS(mTLS)或網路限制來保護,尤其含敏感資訊時。

**通訊與任務(Communications and Tasks):** A2A 通訊圍繞非同步任務,每個任務是長流程的基本工作單位,有唯一識別碼,並歷經 submitted、working、completed 等狀態,支援平行處理。代理透過訊息(Message)通訊:訊息含中介資料屬性(如優先順序、建立時間)與承載內容的一個或多個部分(parts,可為純文字、檔案或結構化 JSON)。任務的具體輸出稱為產物(artifacts),亦由 parts 組成,可增量串流。所有通訊走 HTTP(S),以 JSON-RPC 2.0 傳遞酬載;伺服器產生的 contextId 則把相關任務分組,維持跨互動的情境連續性。

**互動機制(Interaction Mechanisms):** A2A 提供四種模式:

- **同步請求/回應:** 適合快速操作。用戶端送出請求並等待,於單次交換取得完整回應。
- **非同步輪詢:** 適合較長任務。伺服器即時回以「working」與任務 ID,用戶端週期性輪詢直到「completed」或「failed」。
- **串流更新(SSE):** 適合即時增量結果。建立伺服器到用戶端的持久單向連線,持續推送更新。
- **推播通知(Webhooks):** 適合極耗時任務。用戶端註冊 webhook URL,任務狀態顯著變化時伺服器主動通知。

代理卡會指明是否支援串流或推播。A2A 亦與模態無關(modality-agnostic),除文字外支援音訊、視訊等,實現多模態應用。

同步請求使用 `sendTask` 方法,期望單一完整回答:

```json
#同步請求範例
{
  "jsonrpc": "2.0",
  "id": "1",
  "method": "sendTask",
  "params": {
    "id": "task-001",
    "sessionId": "session-001",
    "message": {
      "role": "user",
      "parts": [
        {
          "type": "text",
          "text": "美元兌歐元的匯率是多少?"
        }
      ]
    },
    "acceptedOutputModes": ["text/plain"],
    "historyLength": 5
  }
}
```

串流請求則用 `sendTaskSubscribe` 建立持久連線,回傳多筆增量更新:

```json
# 串流請求範例
{
  "jsonrpc": "2.0",
  "id": "2",
  "method": "sendTaskSubscribe",
  "params": {
    "id": "task-002",
    "sessionId": "session-001",
    "message": {
      "role": "user",
      "parts": [
        {
          "type": "text",
          "text": "今天日圓兌英鎊的匯率是多少?"
        }
      ]
    },
    "acceptedOutputModes": ["text/plain"],
    "historyLength": 5
  }
}
```

**安全性(Security):** A2A 內建數種機制確保資料交換的穩健與完整:

- **相互傳輸層安全性(mTLS):** 加密且經驗證的連線,防止未授權存取與攔截。
- **全面的稽核日誌:** 詳實記錄通訊(資訊流向、涉及代理、執行動作),供問責、除錯與安全分析。
- **代理卡宣告:** 驗證需求在代理卡中明確宣告,集中簡化驗證管理。
- **憑證處理:** 代理通常以 OAuth 2.0 token 或 API 金鑰透過 HTTP 標頭驗證,避免憑證暴露於 URL 或訊息本體。

## A2A 與 MCP

A2A 與 Anthropic 的模型情境協定(MCP)互補(見圖 1):MCP 著重為代理建構情境、以及代理與外部資料和工具的互動;A2A 則促成代理之間的協調與通訊,使任務委派與協作成為可能。

![圖 1:A2A 與 MCP 協定的比較](assets/15-inter-agent-communication-a2a/fig-1-a2a-vs-mcp.png)

*圖 1:A2A 與 MCP 協定的比較*

A2A 旨在提升效率、降低整合成本,並推動複雜多代理系統的創新與互通性。

## 實務應用與使用案例

代理間通訊為各領域 AI 方案帶來模組化、可擴展性與更強智慧:

- **多框架協作:** A2A 的首要使用案例,讓不同框架(ADK、LangChain、CrewAI)的代理通訊協作,各自專精問題的不同面向。
- **自動化工作流程編排:** 在企業中讓代理委派與協調任務,例如一代理蒐集資料、委派另一代理分析、再交第三代理生成報告。
- **動態資訊檢索:** 主要代理向專門的擷取代理請求即時資訊(如市場資料),後者透過外部 API 蒐集並回傳。

## 動手實作範例

A2A 範例儲存庫位於 https://github.com/google-a2a/a2a-samples/tree/main/samples,提供 Java、Go、Python 範例,涵蓋 LangGraph、CrewAI、Azure AI Foundry、AG2 等框架(皆 Apache 2.0 授權)。以下聚焦如何用一個以 ADK 為基礎、搭配 Google 驗證工具的代理設定 A2A 伺服器。參見 https://github.com/google-a2a/a2a-samples/blob/main/samples/python/agents/birthday_planner_adk/calendar_agent/adk_agent.py

```python
import datetime
from google.adk.agents import LlmAgent  # type: ignore[import-untyped]
from google.adk.tools.google_api_tool import CalendarToolset  # type: ignore[import-untyped]


async def create_agent(client_id, client_secret) -> LlmAgent:
    """建構 ADK 代理。"""
    toolset = CalendarToolset(client_id=client_id, client_secret=client_secret)
    return LlmAgent(
        model='gemini-2.0-flash-001',
        name='calendar_agent',
        description="一個能協助管理使用者行事曆的代理",
        instruction=f"""
你是一個能協助管理使用者行事曆的代理。

使用者會請求關於其行事曆狀態的資訊,或是請求對其行事曆進行變更。
請使用所提供的工具來與行事曆 API 互動。

若未特別指定,請假設使用者想要的是「primary」(主要)行事曆。

使用 Calendar API 工具時,請使用格式正確的 RFC3339 時間戳記。

今天是 {datetime.datetime.now()}。
""",
        tools=await toolset.get_tools(),
    )
```

非同步函式 `create_agent` 以用戶端憑證初始化 `CalendarToolset` 存取 Google Calendar API,再建立 `LlmAgent`(設定 Gemini 模型、名稱、管理行事曆的指令與工具)。指令動態納入當前日期以提供時間情境。

接著看 calendar_agent 如何以指令與工具被定義(僅顯示說明所需片段,完整檔案見 https://github.com/a2aproject/a2a-samples/blob/main/samples/python/agents/birthday_planner_adk/calendar_agent/__main__.py):

```python
def main(host: str, port: int):
    # 確認已設定 API 金鑰(使用 Vertex AI API 時則不需要)。
    if os.getenv('GOOGLE_GENAI_USE_VERTEXAI') != 'TRUE' and not os.getenv(
        'GOOGLE_API_KEY'
    ):
        raise ValueError(
            'GOOGLE_API_KEY environment variable not set and '
            'GOOGLE_GENAI_USE_VERTEXAI is not TRUE.'
        )

    skill = AgentSkill(
        id='check_availability',
        name='Check Availability',
        description="使用使用者的 Google Calendar 檢查其在某個時段是否有空",
        tags=['calendar'],
        examples=['我明天早上 10 點到 11 點有空嗎?'],
    )

    agent_card = AgentCard(
        name='Calendar Agent',
        description="一個能管理使用者行事曆的代理",
        url=f'http://{host}:{port}/',
        version='1.0.0',
        defaultInputModes=['text'],
        defaultOutputModes=['text'],
        capabilities=AgentCapabilities(streaming=True),
        skills=[skill],
    )

    adk_agent = asyncio.run(create_agent(
        client_id=os.getenv('GOOGLE_CLIENT_ID'),
        client_secret=os.getenv('GOOGLE_CLIENT_SECRET'),
    ))

    runner = Runner(
        app_name=agent_card.name,
        agent=adk_agent,
        artifact_service=InMemoryArtifactService(),
        session_service=InMemorySessionService(),
        memory_service=InMemoryMemoryService(),
    )

    agent_executor = ADKAgentExecutor(runner, agent_card)

    async def handle_auth(request: Request) -> PlainTextResponse:
        await agent_executor.on_auth_callback(
            str(request.query_params.get('state')), str(request.url)
        )
        return PlainTextResponse('Authentication successful.')

    request_handler = DefaultRequestHandler(
        agent_executor=agent_executor, task_store=InMemoryTaskStore()
    )

    a2a_app = A2AStarletteApplication(
        agent_card=agent_card, http_handler=request_handler
    )

    routes = a2a_app.routes()
    routes.append(
        Route(
            path='/authenticate',
            methods=['GET'],
            endpoint=handle_auth,
        )
    )

    app = Starlette(routes=routes)
    uvicorn.run(app, host=host, port=port)


if __name__ == '__main__':
    main()
```

這段程式碼設定一個 A2A 相容的「Calendar Agent」:先檢驗 API 金鑰或 Vertex AI 設定,在 `AgentCard` 中定義「check_availability」技能與網路位址,建立 ADK 代理並以記憶體內(in-memory)服務管理產物、工作階段與記憶體,最後以納入驗證回呼與 A2A 處理器的 Starlette 應用、透過 Uvicorn 對外公開。

這展示了從定義能力到把代理當網頁服務執行的完整流程。運用代理卡與 ADK,開發者即可建立能整合 Google Calendar 等工具的可互通代理。更多示範見 https://www.trickle.so/blog/how-to-build-google-a2a-project,內含 Python 與 JavaScript 的用戶端/伺服器範例、多代理網頁應用與命令列介面。

## 重點速覽

**是什麼(What):** 單一 AI 代理(尤其建構於不同框架者)往往難以獨力處理複雜、多面向的問題,核心挑戰在於缺乏共通協定讓它們有效協作。沒有標準化做法,整合迥異的代理既昂貴又耗時,也阻礙專精代理結合各自技能解決更大任務。

**為什麼(Why):** A2A 是以 HTTP 為基礎的開放標準,讓不同 AI 代理無縫協調、委派任務並共享資訊,不受底層技術影響。核心元件代理卡是描述代理能力、技能與端點的數位身分檔案,促進探索與互動。A2A 提供同步與非同步等多種互動機制,培育模組化、可擴展的多代理生態系。

**經驗法則(Rule of thumb):** 當你需要編排兩個以上 AI 代理協作時使用,尤其它們以不同框架(Google ADK、LangGraph、CrewAI)建構時。它適合建構複雜、模組化的應用——專精代理各自處理工作流程的一部分(如分析委派一代理、報告生成委派另一代理),也適合代理需動態探索並運用彼此能力的場景。

**重點整理:**

- A2A 是開放、以 HTTP 為基礎的標準,促成不同框架代理間的通訊與協作。
- AgentCard 作為數位識別碼,讓其他代理自動探索並理解其能力。
- 同時提供同步請求-回應(`tasks/send`)與串流更新(`tasks/sendSubscribe`),並支援多輪對話(如維持情境的 `input-required` 狀態)。
- 鼓勵模組化架構,讓專精代理在不同連接埠上獨立運作,實現可擴展與分散性。
- Trickle AI 這類工具有助於將 A2A 通訊視覺化與追蹤,協助監控與除錯多代理系統。
- A2A 是管理跨代理任務的高層級協定,MCP 則為 LLM 提供對接外部資源的標準化介面。

## 視覺摘要

![圖 2:A2A 代理間通訊模式](assets/15-inter-agent-communication-a2a/fig-2-a2a-inter-agent-communication-pattern.png)

*圖 2:A2A 代理間通訊模式*

## 結論

A2A 確立了一項開放標準,克服單一 AI 代理與生俱來的孤立性。透過共通、以 HTTP 為基礎的框架,讓不同平台(Google ADK、LangGraph、CrewAI)上的代理無縫協作。核心元件代理卡作為數位身分清楚定義能力並供動態探索;協定彈性支援同步請求、非同步輪詢與即時串流等模式,使模組化、可擴展的架構成為可能,讓專精代理組合起來編排複雜的自動化工作流程。安全性是其根本面向,內建 mTLS 與明確驗證需求。A2A 與 MCP 互補,獨特地聚焦於代理間高層級的協調與任務委派;各大科技公司的支持與實作的可得性,凸顯其日益重要,為更精密、分散且智慧的多代理系統鋪平道路。

## 參考資料

1. Chen, B. (2025, April 22). How to Build Your First Google A2A Project: A Step-by-Step Tutorial. Trickle.so Blog. <https://www.trickle.so/blog/how-to-build-google-a2a-project>
2. Google A2A GitHub Repository. <https://github.com/google-a2a/A2A>
3. Google Agent Development Kit (ADK). <https://google.github.io/adk-docs/>
4. Getting Started with Agent-to-Agent (A2A) Protocol: <https://codelabs.developers.google.com/intro-a2a-purchasing-concierge#0>
5. Google AgentDiscovery: <https://a2a-protocol.org/latest/>
6. Communication between different AI frameworks such as LangGraph, CrewAI, and Google ADK: <https://www.trickle.so/blog/how-to-build-google-a2a-project>
7. Designing Collaborative Multi-Agent Systems with the A2A Protocol: <https://www.oreilly.com/radar/designing-collaborative-multi-agent-systems-with-the-a2a-protocol/>
