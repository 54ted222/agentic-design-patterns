# 第 13 章:人在迴路中(Human-in-the-Loop)

人在迴路中(Human-in-the-Loop,HITL)是開發與部署代理(Agent)時的關鍵策略,刻意把人類的判斷力、創造力與細膩理解,與 AI 的運算能力和效率交織在一起。當 AI 日益深入關鍵決策時,這種整合往往不只是選項,而是必要。

HITL 的核心,是確保 AI 在倫理界線與安全協定內運作。在複雜、模糊或高風險的領域中,AI 一旦誤判影響可能極為深遠,完全自主反而不智。HITL 正視此現實:即便技術快速進步,人類的監督、策略性投入與協作互動仍不可或缺。其根本理念是人機「協同綜效(synergy)」——不把 AI 當成人類的替代品,而是擴增與強化人類能力的工具,共同達成單靠任何一方都無法企及的成果。

實務上,人類可擔任驗證者審查 AI 輸出、即時引導與修正 AI 行為,或以夥伴身分透過互動式對話協作。無論形式為何,HITL 都強調維持人類掌控與監督,確保 AI 始終與人類倫理、價值觀、目標及社會期待保持一致。

## 人在迴路中模式總覽

HITL 把人類投入整合進 AI 工作流程以強化代理能力,承認最佳表現往往需要結合自動化處理與人類洞見,尤其在高複雜度或涉及倫理的情境中。其目的不是取代人類,而是確保關鍵判斷以人類理解為依據。

HITL 涵蓋幾個關鍵面向:

- **人類監督(Human Oversight):** 透過日誌審查或即時儀表板監控代理表現與輸出,確保其遵循準則並防止不良後果。
- **介入與修正(Intervention and Correction):** 代理遇到錯誤或模糊情境時請求人類介入,由操作者修正錯誤、補上缺漏資料或引導代理,同時有助於未來改進。
- **供學習用的人類回饋(Human Feedback for Learning):** 蒐集回饋以精煉模型,在「以人類回饋進行的強化學習」這類方法中尤為突出,人類偏好直接影響代理的學習軌跡。
- **決策擴增(Decision Augmentation):** AI 提供分析與建議,由人類做最終決策,以 AI 洞見強化人類決策而非完全自主。
- **人機協作(Human-Agent Collaboration):** 各展所長的合作;例行資料處理交給代理,創造性問題解決或複雜協商由人類負責。
- **升級政策(Escalation Policies):** 規範代理何時、以何種方式把任務升級給人類的協定,以防在超出代理能力的情境中出錯。

HITL 讓代理得以運用於完全自主不可行或不被允許的敏感領域,並透過回饋迴路提供持續改進機制。例如金融上,大型企業貸款核准需由人類放款專員評估領導者品格等質性因素;法律上,量刑這類涉及複雜道德推理的關鍵決策須由人類法官保有最終裁量權。

**注意事項(Caveats):** HITL 最主要的限制是缺乏可擴展性——人類監督雖然準確,卻無法處理數以百萬計的任務,因此往往需採混合做法,以自動化追求規模、以 HITL 確保準確性。其有效性也高度仰賴操作者專業:唯有純熟的開發者才能辨識軟體中細微的錯誤,而標註訓練資料的人類也可能需接受特別訓練才能產出高品質資料。最後,HITL 引發隱私疑慮,敏感資訊往往須先嚴謹匿名化才能呈現給人類檢視,增添流程複雜度。

## 實務應用與使用案例

HITL 在準確性、安全性、倫理或細膩理解居於首位的場景中至關重要:

- **內容審核:** AI 快速過濾海量內容找出違規(如仇恨言論、垃圾訊息),模糊或邊界案例則升級給人類審核員做最終決定。
- **自動駕駛:** 車輛自主處理多數駕駛任務,但在 AI 無法有把握應對的複雜、危險情境(如極端天氣、異常路況)中把控制權交還人類駕駛。
- **金融詐欺偵測:** AI 依模式標記可疑交易,高風險或模糊警示送交人類分析師調查並做最終判定。
- **法律文件審查:** AI 快速掃描分類大量文件以辨識相關條款或證據,再由人類法律專業人員確認準確性、情境與法律意涵。
- **客戶支援(複雜問題):** 聊天機器人處理例行詢問,若問題過於複雜、情緒激動或需同理心,則無縫交接給人類支援人員。
- **資料標記與標註:** 人類準確標記影像、文字或音訊,為模型訓練提供真實標準(ground truth);隨模型演進這是持續過程。
- **生成式 AI 的精煉:** LLM 生成創意內容(如行銷文案、設計構想)後,由人類編輯或設計師審查精煉,確保符合品牌準則並維持品質。
- **自主網路:** AI 運用 KPI 與模式分析警示、預測網路問題與流量異常,但高風險警示等關鍵決策仍升級給人類分析師調查並判定是否核准網路變更。

這個模式善用 AI 提升可擴展性與效率,同時維持人類監督以確保品質、安全與倫理合規。

**「人在迴路上(Human-on-the-loop)」** 是一種變體:由人類專家定義總體政策,AI 則處理即時行動以確保合規。兩個例子:

- **自動化金融交易系統:** 人類專家設定總體投資策略,例如「維持 70% 科技股與 30% 債券的組合,單一公司投資不得超過 5%,並自動賣出任何跌破買進價 10% 的股票」。AI 即時監控股市,在符合條件時立即執行交易——以高速行動落實人類設定的較慢、較具策略性的政策。
- **現代客服中心(Call Center):** 人類經理建立高層級政策,例如「任何提及『服務中斷』的來電立即轉接技術支援」或「客戶語氣顯示高度挫折時,主動提議轉接人類客服」。AI 即時聆聽並自主執行這些政策,無需就每個案例尋求人類介入,從而依人類的策略性指引管理大量即時行動。

## 動手實作範例

以下示範一個 ADK 代理辨識出需要人類審查的情境並啟動升級流程,讓人類在代理自主能力受限或需複雜判斷時介入。這並非單一框架獨有,LangChain 等熱門框架也提供類似工具。

```python
from google.adk.agents import Agent
from google.adk.tools.tool_context import ToolContext
from google.adk.callbacks import CallbackContext
from google.adk.models.llm import LlmRequest
from google.genai import types
from typing import Optional

# 工具的佔位實作(在需要時請替換成實際的實作)
def troubleshoot_issue(issue: str) -> dict:
    return {"status": "success", "report": f"Troubleshooting steps for {issue}."}

def create_ticket(issue_type: str, details: str) -> dict:
    return {"status": "success", "ticket_id": "TICKET123"}

def escalate_to_human(issue_type: str) -> dict:
    # 在真實系統中,這通常會把案件轉移到人類處理佇列
    return {"status": "success", "message": f"Escalated {issue_type} to a human specialist."}

technical_support_agent = Agent(
    name="technical_support_specialist",
    model="gemini-2.0-flash-exp",
    instruction="""
你是我們這家電子產品公司的技術支援專員。

首先,檢查使用者在 state["customer_info"]["support_history"] 中是否有支援歷史。若有,請在你的回應中參照這段歷史。

針對技術問題:
1. 使用 troubleshoot_issue 工具來分析問題。
2. 引導使用者完成基本的疑難排解步驟。
3. 若問題仍然存在,使用 create_ticket 記錄此問題。

針對超出基本疑難排解範圍的複雜問題:
1. 使用 escalate_to_human 轉接給人類專員。

維持專業但具同理心的語氣。在提供清晰解決步驟的同時,體諒技術問題可能造成的挫折感。
""",
    tools=[troubleshoot_issue, create_ticket, escalate_to_human]
)

def personalization_callback(
    callback_context: CallbackContext, llm_request: LlmRequest
) -> Optional[LlmRequest]:
    """為 LLM 請求加入個人化資訊。"""
    # 從 state 取得客戶資訊
    customer_info = callback_context.state.get("customer_info")
    if customer_info:
        customer_name = customer_info.get("name", "valued customer")
        customer_tier = customer_info.get("tier", "standard")
        recent_purchases = customer_info.get("recent_purchases", [])
        # 組出要以系統訊息形式注入提示的個人化資訊
        personalization_note = (
            f"\n重要個人化資訊:\n"
            f"客戶姓名:{customer_name}\n"
            f"客戶層級:{customer_tier}\n"
        )
        if recent_purchases:
            personalization_note += f"近期購買:{', '.join(recent_purchases)}\n"

        if llm_request.contents:
            # 在第一段內容之前,加入一則系統訊息
            system_content = types.Content(
                role="system",
                parts=[types.Part(text=personalization_note)]
            )
            llm_request.contents.insert(0, system_content)

    return None  # 回傳 None 以使用修改後的請求繼續執行
```

這段程式碼示範如何用 Google 的 ADK 建立一個圍繞 HITL 設計的技術支援代理。代理扮演智慧型第一線支援,配置特定指令並裝備 `troubleshoot_issue`、`create_ticket` 與 `escalate_to_human` 等工具來管理完整支援流程,其中升級工具是 HITL 設計的核心,確保複雜或敏感案例交付人類專員。

另一項關鍵特色是透過專屬回呼(callback)達成的深度個人化:在聯繫 LLM 前,函式動態從代理狀態(state)擷取客戶姓名、層級與購買歷史,並以系統訊息注入提示,使代理能提供量身打造、參照使用者歷史的回應。把結構化工作流程、人類監督與動態個人化結合,正展現了 ADK 如何促成精密而穩健的 AI 支援解決方案。

## 重點速覽

**是什麼(What):** AI(包括先進 LLM)在面對需要細膩判斷、倫理推理或對複雜模糊情境深刻理解的任務時往往力有未逮,缺乏人類固有的創造力與常識推理。在高風險環境部署完全自主 AI 風險重大,錯誤可能導致嚴重的安全、財務或倫理後果,因此僅靠自動化往往不明智,並可能損及系統的有效性與可信賴度。

**為什麼(Why):** HITL 透過策略性地把人類監督整合進 AI 工作流程,提供標準化解法,創造出共生夥伴關係——AI 負責繁重運算與資料處理,人類提供關鍵驗證、回饋與介入,確保 AI 行動與人類價值觀及安全協定一致。此框架減輕完全自動化的風險,並透過持續從人類投入中學習強化系統能力,帶來更穩健、準確且合乎倫理的成果。

**經驗法則(Rule of thumb):** 當你要在錯誤會帶來重大安全、倫理或財務後果的領域(如醫療、金融、自主系統)部署 AI,或任務涉及 LLM 無法可靠處理的模糊與細微差異(如內容審核、複雜客戶支援升級)時使用本模式;當目標是以高品質、人類標記的資料持續改進模型,或精煉生成式 AI 輸出以符合特定品質標準時,也應採用 HITL。

**視覺摘要:**

![圖 1:人在迴路中設計模式](assets/13-human-in-the-loop/fig-1-human-in-the-loop-pattern.png)

*圖 1:人在迴路中設計模式。*

## 重點整理

- HITL 把人類的智慧與判斷整合進 AI 工作流程,在複雜或高風險情境中對安全、倫理與有效性至關重要。
- 關鍵面向包括人類監督、介入、供學習用的回饋與決策擴增;升級政策讓代理知道何時該把任務交接給人類,不可或缺。
- HITL 使負責任的 AI 部署與持續改進成為可能。
- 主要缺點是本質上缺乏可擴展性(準確性與處理量的權衡),以及對高度熟練領域專家的依賴;實作上還帶來訓練操作者、以匿名化處理隱私等營運挑戰。

## 結論

本章探討了至關重要的 HITL 模式,以及它在打造穩健、安全且合乎倫理之 AI 系統中的角色。把人類監督、介入與回饋整合進代理工作流程,能顯著提升表現與可信賴度,尤其在複雜敏感領域——從內容審核、醫療診斷到自動駕駛與客戶支援。程式碼範例展示了 ADK 如何透過升級機制促成這些人機互動。隨著 AI 能力持續精進,HITL 仍是負責任 AI 開發的基石,確保人類價值觀與專業始終居於智慧型系統設計的核心。

## 參考資料

1. A Survey of Human-in-the-loop for Machine Learning, Xingjiao Wu, Luwei Xiao, Yixuan Sun, Junhang Zhang, Tianlong Ma, Liang He. <https://arxiv.org/abs/2108.00941>
