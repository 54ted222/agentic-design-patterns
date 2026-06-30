# 第 12 章:例外處理與復原(Exception Handling and Recovery)

要在多樣化的真實環境中可靠運作,AI 代理(AI agent)必須能應對無法預見的情況、錯誤與故障。如同人類會適應意外障礙,智慧型代理也需要穩健的機制來偵測問題、啟動復原,或至少以可控的方式失敗。這正是例外處理與復原模式的核心:同時兼顧主動式準備與反應式策略,讓代理即使遭遇困難仍能維持功能完整、提升可靠度與可信賴度。整合完善的監控與診斷工具,更能讓代理在問題擴大前就加以辨識與處理。

這個模式有時會與反思(reflection)搭配:若初次嘗試失敗並引發例外(exception),反思過程可分析失敗原因,並以更精煉的做法(例如改良提示)重新嘗試,以解決錯誤。

## 例外處理與復原模式總覽

此模式因應 AI 代理管理運作失敗的需求,核心是預先設想潛在問題(如工具錯誤或服務無法使用),並擬定緩解與復原策略,將代理恢復到穩定狀態。實務例子包括:處理資料庫錯誤的聊天機器人、應對金融錯誤的交易機器人、處理裝置故障的智慧家庭代理。

![圖 1:AI 代理之例外處理與復原的關鍵組成元件](assets/12-exception-handling-and-recovery/fig-1-exception-handling-components.png)

*圖 1:AI 代理之例外處理與復原的關鍵組成元件。*

**錯誤偵測(Error Detection):** 在問題發生時加以辨識。問題可能表現為:無效或格式不正確的工具輸出、特定 API 錯誤(如 404 Not Found、500 Internal Server Error)、反應時間異常過長,或偏離預期格式的不連貫回應。也可導入其他代理或專門監控系統,更主動地攔截異常。

**錯誤處理(Error Handling):** 偵測到錯誤後擬定回應計畫,包括:在日誌中記錄錯誤細節以供除錯(記錄);重試動作或請求、必要時微調參數,對暫時性錯誤(transient errors)尤其有效(重試);運用替代策略維持部分功能(後備);在無法立即完全復原時仍提供部分價值(優雅降級);以及在需要人工協作時警示操作員或其他代理(通知)。

**復原(Recovery):** 錯誤後將系統恢復到穩定可運作的狀態。可能涉及還原近期變更或交易以撤銷錯誤影響(狀態回滾);徹底調查成因以防再犯;透過自我修正或重新規劃(replanning)調整計畫、邏輯或參數;在嚴重情況下,將問題委派給人類操作員或更高層級系統(升級轉介)。

實作這套模式能把 AI 代理從脆弱不可靠的系統,轉變為穩健可信賴的元件,在高度難以預測的環境中有效運作,將停機時間降到最低。

## 實務應用與使用案例

任何部署於無法保證完美條件之真實情境的代理,都需要例外處理與復原。

- **客戶服務聊天機器人:** 客戶資料庫暫時離線時不應當機,而應偵測 API 錯誤、告知使用者為暫時性問題、建議稍後再試,或升級轉介給人類客服。

- **自動化金融交易:** 交易機器人可能遇到「資金不足」或「市場休市」錯誤,必須記錄錯誤、不反覆嘗試同一筆無效交易,並通知使用者或調整策略。

- **智慧家庭自動化:** 控制燈具的代理可能因網路或裝置故障無法開燈,應偵測失敗、重試,若仍失敗則通知使用者並建議手動介入。

- **資料處理代理:** 處理批次文件時若遇損毀檔案,應略過該檔、記錄錯誤、繼續處理其他檔案,最後回報被略過的檔案,而非讓整個程序停擺。

- **網頁爬取代理:** 遇到 CAPTCHA、網站結構變動或伺服器錯誤(如 404、503)時需優雅處理,例如暫停、改用代理伺服器(proxy),或回報失敗的 URL。

- **機器人技術與製造業:** 機械手臂因對位不正無法夾取零件時,須透過感測器回饋偵測失敗、嘗試重新校準與重試,若問題持續則警示操作員或改用其他零件。

簡言之,這個模式是建構「不僅聰明,且面對真實複雜性時可靠、具韌性、對使用者友善」之代理的根本。

## 動手實作範例(ADK)

例外處理與復原對系統的穩健性至關重要。以下範例展示代理如何回應一次失敗的工具呼叫——失敗可能源於不正確的工具輸入,或工具所依賴之外部服務的問題。

```python
from google.adk.agents import Agent, SequentialAgent

# 代理 1:嘗試使用主要工具,職責範圍狹窄而明確。
primary_handler = Agent(
    name="primary_handler",
    model="gemini-2.0-flash-exp",
    instruction="""
    你的工作是取得精確的地點資訊。
    請使用 get_precise_location_info 工具,並帶入使用者提供的地址。
    """,
    tools=[get_precise_location_info]
)

# 代理 2:後備處理器,檢查狀態以決定動作。
fallback_handler = Agent(
    name="fallback_handler",
    model="gemini-2.0-flash-exp",
    instruction="""
    透過檢視 state["primary_location_failed"],判斷主要的地點查詢是否失敗。
    - 如果為 True,從使用者原始查詢中擷取城市,並使用 get_general_area_info 工具。
    - 如果為 False,則不採取任何動作。
    """,
    tools=[get_general_area_info]
)

# 代理 3:從狀態中呈現最終結果。
response_agent = Agent(
    name="response_agent",
    model="gemini-2.0-flash-exp",
    instruction="""
    審視儲存在 state["location_result"] 中的地點資訊,
    清楚而簡潔地呈現給使用者。
    如果 state["location_result"] 不存在或為空,則為無法取得該地點向使用者致歉。
    """,
    tools=[]  # 這個代理只針對最終狀態進行推理。
)

# SequentialAgent 確保這些處理器以有保證的順序執行。
robust_location_agent = SequentialAgent(
    name="robust_location_agent",
    sub_agents=[primary_handler, fallback_handler, response_agent]
)
```

這段程式碼用 ADK 的 `SequentialAgent` 搭配三個子代理(sub-agent),建構分層式的地點檢索系統:`primary_handler` 先用 `get_precise_location_info` 嘗試取得精確地點;`fallback_handler` 檢查狀態變數判斷主要查詢是否失敗,若失敗則從使用者查詢擷取城市並改用 `get_general_area_info`;`response_agent` 審視狀態中的地點資訊並呈現給使用者,若無結果則道歉。`SequentialAgent` 確保三者依預定順序執行。

## 重點速覽

**是什麼(What):** 在真實環境運作的 AI 代理,無可避免會遇到無法預見的情況、錯誤與系統故障,範圍涵蓋工具失敗、網路問題乃至無效資料,都威脅到代理完成任務的能力。若缺乏有結構的管理方式,代理面對意外障礙時會變得脆弱、不可靠,難以部署於需要穩定表現的關鍵應用。

**為什麼(Why):** 此模式提供標準化解法,賦予代理預先設想、管理失敗並從中復原的能力。它涵蓋主動式錯誤偵測(監控工具輸出與 API 回應)與反應式處理策略(記錄、重試暫時性失敗、後備機制);對嚴重問題則定義復原協定,包括還原至穩定狀態、透過調整計畫自我修正,或升級轉介給人類。這種系統化做法確保代理維持運作完整、從失敗中學習,並在難以預測的環境中可靠運作。

**經驗法則(Rule of thumb):** 當 AI 代理部署於動態真實環境,可能發生系統失敗、工具錯誤、網路問題或不可預測輸入,且運作可靠性是關鍵需求時,使用此模式。

## 視覺摘要

![圖 2:例外處理模式](assets/12-exception-handling-and-recovery/fig-2-exception-handling-pattern.png)

*圖 2:例外處理模式。*

**重點整理:**

- 例外處理與復原對建構穩健可靠的代理至關重要,核心是偵測錯誤、優雅處理錯誤並實作復原策略。
- 錯誤偵測涵蓋驗證工具輸出、檢查 API 錯誤代碼與使用逾時(timeouts)。
- 處理策略包括記錄、重試、後備、優雅降級與通知。
- 復原聚焦於透過診斷、自我修正或升級轉介恢復穩定運作。
- 此模式確保代理即使在難以預測的真實環境中也能有效運作。

## 結論

例外處理與復原模式對開發穩健可信賴的 AI 代理至關重要,它因應代理如何辨識並管理意外問題、實作適切回應,並復原至穩定狀態。本章涵蓋錯誤偵測、透過記錄/重試/後備等機制處理錯誤,以及恢復正常運作的各種復原策略,並以跨領域的實務應用展現此模式在處理真實複雜性與潛在失敗時如何提升代理的可靠性與適應力。

## 參考資料

1. McConnell, S. (2004). *Code Complete* (2nd ed.). Microsoft Press.
2. Shi, Y., Pei, H., Feng, L., Zhang, Y., & Yao, D. (2024). Towards Fault Tolerance in Multi-Agent Reinforcement Learning. arXiv preprint arXiv:2412.00534.
3. O'Neill, V. (2022). Improving Fault Tolerance and Reliability of Heterogeneous Multi-Agent IoT Systems Using Intelligence Transfer. *Electronics*, 11(17), 2724.
