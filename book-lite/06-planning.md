# 第 6 章:規劃(Planning)

智慧行為不只是對眼前輸入做出反應,還需要前瞻性、把複雜任務拆解成易於掌控的步驟,並擬定達成目標的策略。這正是規劃(Planning)模式的核心:讓代理(agent)或代理系統制定一連串行動,從初始狀態邁向目標狀態。

## 規劃模式總覽

可以把規劃代理想像成一位你可以委以複雜目標的專家。當你說「籌辦一場團隊外出活動」時,你定義的是「做什麼」(目標與限制),而非「怎麼做」。代理的任務是理解初始狀態(預算、人數、日期)與目標狀態(成功訂好的活動),自主規劃出連接兩者的最佳行動序列。這份計畫不是事先就已知,而是因應請求被創造出來的。

關鍵特徵是適應力。初始計畫只是起點,而非僵硬的腳本。代理真正的威力在於能納入新資訊、繞過障礙:若中意的場地無法使用或外燴已被預訂,有能力的代理不會失敗,而會登錄新限制、重新評估選項,並制定新計畫(例如建議替代場地或日期)。

但彈性與可預測性之間有取捨。動態規劃是特定工具,而非萬用解法。當問題的解法已被充分理解且可重複時,把代理約束在固定的工作流程中更有效——這犧牲自主性以換取可靠、一致的結果。因此,究竟要用規劃代理還是單純的任務執行代理,取決於一個關鍵問題:「怎麼做」需要被探索,還是早已為人所知?

## 實務應用與使用案例

規劃讓代理把高層次目標轉化為由離散、可執行步驟組成的結構化計畫,在動態或複雜環境中尤其重要。

- **程序性任務自動化:** 協調複雜工作流程。例如「新進員工到職」可拆解為建立帳號、指派訓練模組、跨部門協調等子任務;代理依邏輯順序執行,並呼叫工具或與系統互動以管理依賴關係。
- **機器人學與自主導航:** 規劃是狀態空間遍歷的根本。系統(實體或虛擬)須生成一條從初始狀態到目標狀態的路徑,針對時間或能源等指標最佳化,同時遵守避障、交通規則等環境限制。
- **結構化資訊綜整:** 生成研究報告等複雜輸出時,代理可制定包含資訊蒐集、摘要、結構化與迭代精煉的計畫。多步驟的客戶支援也可依診斷、解決方案實作與問題升級建立有系統的計畫。

本質上,規劃讓代理超越被動反應,邁向以目標為導向的行為,並提供解決「需要一連串相互依賴操作」之問題所需的邏輯框架。

## 動手實作範例(Crew AI)

以下示範如何用 Crew AI 框架實作規劃者(Planner)模式:代理先針對複雜查詢制定多步驟計畫,再循序執行。

```python
import os
from dotenv import load_dotenv
from crewai import Agent, Task, Crew, Process
from langchain_openai import ChatOpenAI

# 為了安全性,從 .env 檔案載入環境變數
load_dotenv()

# 1. 明確定義語言模型
llm = ChatOpenAI(model="gpt-4-turbo")

# 2. 定義一個清楚且聚焦的代理
planner_writer_agent = Agent(
    role='文章規劃者與撰寫者',
    goal='針對指定主題進行規劃,然後撰寫一份簡潔、引人入勝的摘要。',
    backstory=(
        '你是一位專業的技術寫作者兼內容策略師。'
        '你的強項在於動筆之前先擬定一份清楚、可付諸行動的計畫,'
        '確保最終的摘要既具有資訊性又易於消化吸收。'
    ),
    verbose=True,
    allow_delegation=False,
    llm=llm  # 把這個特定的 LLM 指派給代理
)

# 3. 定義任務,並給予結構化、具體的預期輸出
topic = "強化學習在 AI 中的重要性"
high_level_task = Task(
    description=(
        f"1. 針對主題「{topic}」的摘要,建立一份條列式的計畫。\n"
        f"2. 根據你的計畫撰寫摘要,字數維持在 200 字左右。"
    ),
    expected_output=(
        "一份最終報告,包含兩個明確區分的段落:\n\n"
        "### 計畫\n"
        "- 一份條列清單,概述摘要的主要重點。\n\n"
        "### 摘要\n"
        "- 一份針對該主題、簡潔且結構良好的摘要。"
    ),
    agent=planner_writer_agent,
)

# 用一個清楚的流程建立 crew
crew = Crew(
    agents=[planner_writer_agent],
    tasks=[high_level_task],
    process=Process.sequential,
)

# 執行任務
print("## 正在執行規劃與撰寫任務 ##")
result = crew.kickoff()
print("\n\n---\n## 任務結果 ##\n---")
print(result)
```

這段程式碼用 CrewAI 建立一個代理,讓它先規劃、再撰寫摘要:匯入函式庫並載入 .env、明確定義 ChatOpenAI 模型、建立帶有角色與背景故事的 `planner_writer_agent`、定義帶有描述與預期輸出格式的 `Task`,最後組成循序處理的 crew 並以 `crew.kickoff()` 執行、印出結果。

## Google DeepResearch

Google Gemini DeepResearch(見圖 1)是以代理為基礎的系統,專為自主資訊檢索與綜整而設計。它透過多步驟的代理式管線運作,動態且迭代地查詢 Google 搜尋,系統化探索複雜主題:處理大量網路來源、評估資料相關性與知識缺口,並進行後續搜尋填補缺口,最終把經檢核的資訊彙整成附引用的結構化多頁摘要。

它並非單次「查詢—回應」,而是受管理、長時間運行的過程。它先把使用者提示解構成多重要點的研究計畫(見圖 1),呈現給使用者審閱與修改,讓研究走向在執行前協作式塑形。計畫核准後,管線啟動迭代式「搜尋—分析」迴圈:代理根據蒐集到的資訊動態制定並精煉查詢,主動找出知識缺口、佐證資料點並化解矛盾。

![圖 1:Google Deep Research 代理正在生成一份執行計畫,以便把 Google 搜尋當作工具來使用。](assets/06-planning/fig-1-deep-research-plan.png)

*圖 1:Google Deep Research 代理正在生成一份執行計畫,以便把 Google 搜尋當作工具來使用。*

關鍵架構元件是非同步(asynchronously)管理整個過程:即使分析數百個來源,調查仍對單點故障保持韌性,使用者可抽身離開並在完成時收到通知。系統也能整合使用者提供的文件,把私有來源與網路研究結合。最終輸出不是發現的串接清單,而是結構化的多頁報告——綜整階段中,模型會批判性評估資訊、辨識主題,並組織成帶有合乎邏輯章節的連貫敘事。報告可互動,通常包含語音概覽、圖表與連往原始引用的連結;模型還會明確回傳完整的來源清單(見圖 2),以引用形式提供完整透明度與直達第一手資訊的管道。

![圖 2:Deep Research 計畫被執行的範例,過程中把 Google 搜尋當作工具來搜尋各種網路來源。](assets/06-planning/fig-2-deep-research-execution.png)

*圖 2:Deep Research 計畫被執行的範例,過程中把 Google 搜尋當作工具來搜尋各種網路來源。*

藉由減少手動取得與綜整資料所需的時間與資源,Gemini DeepResearch 提供更結構化、詳盡的資訊探索方法,在複雜、多面向的研究任務中價值尤其明顯。例如在競爭分析中,可指示代理系統化蒐集市場趨勢、競爭對手產品規格、公眾情緒與行銷策略,取代手動追蹤的繁瑣工作,讓分析師專注於高層次策略詮釋(見圖 3)。

![圖 3:Google Deep Research 代理所生成的最終輸出,它代替我們分析了透過把 Google 搜尋當作工具而取得的各種來源。](assets/06-planning/fig-3-deep-research-output.png)

*圖 3:Google Deep Research 代理所生成的最終輸出,它代替我們分析了透過把 Google 搜尋當作工具而取得的各種來源。*

在學術探索方面,它是進行廣泛文獻回顧的強大工具:辨識並摘要奠基性論文、追溯概念在眾多出版品中的發展、描繪正在浮現的研究前沿,加速最初也最耗時的階段。其高效率源自把迭代式「搜尋—篩選」迴圈自動化(手動研究的核心瓶頸),其全面性則來自能處理遠超人類負荷的來源數量與種類,有助於減少選擇偏誤、提高揭露關鍵冷門資訊的機率,形成更穩健、有依據的理解。

## OpenAI Deep Research API

OpenAI Deep Research API 專為自動化複雜研究任務而設計,運用先進的代理式模型獨立推理、規劃並從真實來源綜整資訊。與單純問答模型不同,它接收高層次查詢後自主拆解成子問題,用內建工具進行網路搜尋,交付結構化、富含引用的最終報告。它提供對整個過程的直接程式化存取,撰寫本文時使用 o3-deep-research-2025-06-26 進行高品質綜整,以及速度更快的 o4-mini-deep-research-2025-06-26 因應延遲敏感的應用。

這個 API 把原本數小時的手動研究自動化,交付專業等級、以資料為驅動的報告,適合為商業策略、投資決策或政策建議提供資訊。主要好處包括:

- **結構化、附引用的輸出:** 產出組織良好的報告,內含與來源中介資料連結的行內引用,確保各項主張可查證、有資料支撐。
- **透明度:** 揭露所有中間步驟,包括代理的推理、執行的網路搜尋查詢與運行的程式碼,讓詳盡的除錯與分析成為可能。
- **可擴充性:** 支援模型情境協定(MCP),讓開發者把代理連接到私有知識庫與內部資料,融合公開研究與專有資訊。

使用時,向 `client.responses.create` 端點發送請求,指定模型、輸入提示與代理可用的工具。輸入通常包含定義代理人格與輸出格式的 system_message 與 user_query,並須納入 web_search_preview 工具,可選擇性加入 code_interpreter 或自訂 MCP 工具(見第 10 章)以存取內部資料。

````python
from openai import OpenAI

# 用你的 API key 初始化 client
client = OpenAI(api_key="YOUR_OPENAI_API_KEY")

# 定義代理的角色與使用者的研究問題
system_message = """你是一位專業研究者,正在準備一份結構化、以資料為驅動的報告。
著重於資料豐富的洞見、使用可靠的來源,並納入行內引用。"""

user_query = "研究司美格魯肽(semaglutide)對全球醫療體系的經濟影響。"

# 建立 Deep Research API 呼叫
response = client.responses.create(
    model="o3-deep-research-2025-06-26",
    input=[
        {
            "role": "developer",
            "content": [{"type": "input_text", "text": system_message}]
        },
        {
            "role": "user",
            "content": [{"type": "input_text", "text": user_query}]
        }
    ],
    reasoning={"summary": "auto"},
    tools=[{"type": "web_search_preview"}]
)

# 從回應中存取並印出最終報告
final_report = response.output[-1].content[0].text
print(final_report)

# --- 存取行內引用與中介資料 ---
print("--- 引用 ---")
annotations = response.output[-1].content[0].annotations
if not annotations:
    print("報告中找不到標註。")
else:
    for i, citation in enumerate(annotations):
        # 該引用所指向的文字段落
        cited_text = final_report[citation.start_index:citation.end_index]
        print(f"引用 {i+1}:")
        print(f"  被引用文字: {cited_text}")
        print(f"  標題: {citation.title}")
        print(f"  URL: {citation.url}")
        print(f"  位置: 字元 {citation.start_index}–{citation.end_index}")
        print("\n" + "="*50 + "\n")

# --- 檢視中間步驟 ---
print("--- 中間步驟 ---")

# 1. 推理步驟:模型所生成的內部計畫與摘要。
try:
    reasoning_step = next(item for item in response.output if item.type == "reasoning")
    print("\n[找到一個推理步驟]")
    for summary_part in reasoning_step.summary:
        print(f"  - {summary_part.text}")
except StopIteration:
    print("\n找不到推理步驟。")

# 2. 網路搜尋呼叫:代理所執行的確切搜尋查詢。
try:
    search_step = next(item for item in response.output if item.type == "web_search_call")
    print("\n[找到一個網路搜尋呼叫]")
    print(f"  執行的查詢: '{search_step.action['query']}'")
    print(f"  狀態: {search_step.status}")
except StopIteration:
    print("\n找不到網路搜尋步驟。")

# 3. 程式碼執行:代理使用程式碼直譯器(code interpreter)所運行的任何程式碼。
try:
    code_step = next(item for item in response.output if item.type == "code_interpreter_call")
    print("\n[找到一個程式碼執行步驟]")
    print("  程式碼輸入:")
    print(f"    ```python\n{code_step.input}\n    ```")
    print("  程式碼輸出:")
    print(f"    {code_step.output}")
except StopIteration:
    print("\n找不到程式碼執行步驟。")
````

這段程式碼用 OpenAI API 執行 Deep Research 任務:先以 API key 初始化 client、把代理角色定義為專業研究者並設定關於司美格魯肽經濟影響的問題、建構對 o3-deep-research-2025-06-26 的呼叫(要求自動產生推理摘要並啟用網路搜尋),接著擷取並印出最終報告。隨後從標註中存取並顯示行內引用與中介資料(被引用文字、標題、URL、位置),最後檢視並印出中間步驟:推理、網路搜尋呼叫(含執行查詢),以及若使用了程式碼直譯器的程式碼執行步驟。

## 重點速覽

**是什麼(What):** 複雜問題往往無法靠單一行動解決,而需要前瞻性才能達成期望結果。少了結構化做法,代理系統難以處理涉及多重步驟與依賴關係的多面向請求,也難以把高層次目標拆解成易於掌控的較小任務,導致不完整或不正確的結果。

**為什麼(Why):** 規劃模式讓代理先針對目標建立連貫計畫,把高層次目標分解成一連串較小、可付諸行動的步驟或子目標,使系統能管理複雜工作流程、協調工具,並以邏輯順序處理依賴關係。LLM 特別適合這項工作,因為它們能根據龐大訓練資料生成看似合理且有效的計畫。這把被動反應的代理轉化為能主動朝目標推進、必要時調整計畫的策略性執行者。

**經驗法則(Rule of thumb):** 當請求複雜到無法靠單一行動或工具處理時使用此模式。它非常適合自動化多步驟流程(生成研究報告、新進員工到職、競爭分析)。每當任務需要一連串相互依賴的操作才能達到最終、經綜整的結果時,就套用規劃模式。

## 視覺摘要

![圖 4:規劃設計模式](assets/06-planning/fig-4-planning-pattern.png)

*圖 4:規劃設計模式*

## 結論

規劃模式是基礎元件,把代理系統從被動回應者提升為具策略性、以目標為導向的執行者。現代 LLM 提供核心能力,能自主把高層次目標分解成連貫、可付諸行動的步驟。它的適用範圍小至直接、循序的任務執行(如 CrewAI 代理建立並遵循寫作計畫),大至更複雜、動態的系統——Google DeepResearch 正是典範,它建立迭代式研究計畫,並能反思、規劃、執行,根據持續蒐集的資訊調整演化。

可記住的重點:

- 規劃讓代理把複雜目標拆解成可付諸行動的循序步驟,是處理多步驟任務、工作流程自動化與複雜環境導航不可或缺的能力。
- LLM 能根據任務描述生成逐步做法;明確提示或設計任務要求規劃步驟,能在代理框架中鼓勵此行為。
- Google Deep Research 代理會反思、規劃並執行,代替我們分析透過把 Google 搜尋當作工具而取得的各種來源。

歸根究柢,規劃為人類意圖與複雜問題的自動化執行之間,提供了不可或缺的橋樑。

## 參考資料

1. Google DeepResearch(Gemini 功能):<https://gemini.google.com>
2. OpenAI, Introducing deep research:<https://openai.com/index/introducing-deep-research/>
3. Perplexity, Introducing Perplexity Deep Research:<https://www.perplexity.ai/hub/blog/introducing-perplexity-deep-research>
