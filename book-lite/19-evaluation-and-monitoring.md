# 第 19 章:評估與監控(Evaluation and Monitoring)

本章探討如何讓智慧代理(intelligent agent)有系統地評估自身表現、監控目標進展並偵測異常。相對於第 11 章的目標設定與第 17 章的推理機制,本章聚焦於對代理之有效性(effectiveness)、效率(efficiency)與需求遵循程度進行持續、且常是外部的衡量,涵蓋定義指標、建立回饋迴路(feedback loop)與報告系統(見圖 1)。

![圖 1:評估與監控的最佳實務做法。](assets/19-evaluation-and-monitoring/fig-1-best-practices.png)

*圖 1:評估與監控的最佳實務做法。*

## 實務應用與使用案例

- **即時系統中的效能追蹤:** 持續監控正式環境(production)中代理的準確度、延遲(latency)與資源消耗(例如客服機器人的解決率、回應時間)。
- **代理改良的 A/B 測試:** 平行比較不同代理版本或策略,找出最佳做法(例如為物流代理嘗試兩種規劃演算法)。
- **合規與安全稽核:** 產生自動化稽核報告,長期追蹤代理對倫理、法規與安全規範的遵循情形,可由人在迴路(human-in-the-loop)或另一代理驗證,並產生 KPI 或觸發警示。
- **企業系統:** 治理企業中的代理式 AI 需要新的控制工具,即 AI「合約(Contract)」——把任務目標、規則與控制機制明文化的動態協議。
- **漂移偵測(Drift Detection):** 監控輸出相關性與準確度,偵測因輸入分布變化(概念漂移)或環境變遷導致的退化。
- **異常偵測:** 辨識代理的非預期動作,可能代表錯誤、惡意攻擊或衍生行為。
- **學習進度評估:** 追蹤學習曲線、特定技能進步,以及跨任務與資料集的泛化(generalization)能力。

## 動手實作範例

為 AI 代理打造完整評估框架極為艱鉅,需考量模型表現、使用者互動、倫理與社會衝擊等眾多因素。但就實務落地而言,焦點可收斂到幾個關鍵使用案例。

**代理回應評估(Agent Response Assessment):** 此核心流程評估代理輸出的品質與準確度——判斷回應是否切題、正確、合乎邏輯、不帶偏見。指標可包括事實正確性、流暢度、文法精確度與意圖契合度。

```python
def evaluate_response_accuracy(agent_output: str, expected_output: str) -> float:
    """計算代理回應的簡易準確度分數。"""
    # 這是非常基本的完全比對;真實世界會使用更精密的指標
    return 1.0 if agent_output.strip().lower() == expected_output.strip().lower() else 0.0

# 範例用法
agent_response = "The capital of France is Paris."
ground_truth = "Paris is the capital of France."
score = evaluate_response_accuracy(agent_response, ground_truth)
print(f"Response accuracy: {score}")
```

`evaluate_response_accuracy` 在去除前後空白並轉小寫後,對輸出做嚴格的逐字元比對,相符回傳 1.0,否則 0.0。問題在於:上例兩個句子意義相同,但字串不一致,函式仍會錯誤回傳 0.0。

直接字串比較無法評估語意相似度,需要進階 NLP 技術。更精密的指標包括:字串相似度量測(萊文斯坦距離、傑卡德相似度)、關鍵字分析、運用嵌入模型餘弦相似度(cosine similarity)的語意相似度、LLM 即評審(後述),以及 RAG 專屬指標(忠實度 faithfulness、相關性 relevance)。

**延遲監控(Latency Monitoring):** 在速度為關鍵的應用中,量測代理處理請求並產出輸出所需的時間至關重要;過高延遲會損害使用者體驗,尤其在即時或互動環境。實務上不應只把延遲印到主控台,應記錄(log)到持久性儲存:結構化日誌(如 JSON)、時序資料庫(InfluxDB、Prometheus)、資料倉儲(Snowflake、BigQuery、PostgreSQL)或可觀測性平台(Datadog、Splunk、Grafana Cloud)。

**追蹤 token 用量:** LLM 計費通常取決於輸入與輸出 token 數,因此追蹤 token 用量對成本管理與資源最佳化至關重要,也有助於找出提示工程或回應生成中可改進之處。

```python
# 這只是概念性示意,實際的 token 計數取決於 LLM API
class LLMInteractionMonitor:
    def __init__(self):
        self.total_input_tokens = 0
        self.total_output_tokens = 0

    def record_interaction(self, prompt: str, response: str):
        # 真實情境請使用 LLM API 的 token 計數器或 tokenizer
        input_tokens = len(prompt.split())  # 暫用佔位算法
        output_tokens = len(response.split())  # 暫用佔位算法
        self.total_input_tokens += input_tokens
        self.total_output_tokens += output_tokens
        print(f"Recorded interaction: Input tokens={input_tokens}, Output tokens={output_tokens}")

    def get_total_tokens(self):
        return self.total_input_tokens, self.total_output_tokens

# 範例用法
monitor = LLMInteractionMonitor()
monitor.record_interaction("What is the capital of France?", "The capital of France is Paris.")
monitor.record_interaction("Tell me a joke.", "Why don't scientists trust atoms? Because they make up everything!")
input_t, output_t = monitor.get_total_tokens()
print(f"Total input tokens: {input_t}, Total output tokens: {output_t}")
```

`LLMInteractionMonitor` 以分割字串模擬 token 計數(實務應改用 LLM API 的 tokenizer),隨互動累加輸入與輸出總數,`get_total_tokens` 提供累計值供成本管理與最佳化使用。

**運用 LLM 即評審打造「有用性」自訂指標:** 評估「有用性(helpfulness)」這類主觀特質超出標準客觀指標範疇。一種做法是以 LLM 作為評估者,依預先定義的準則評估另一代理的輸出。「LLM 即評審(LLM-as-a-Judge)」善用 LLM 的語言能力,對主觀特質提供近似人類的細緻評估,勝過關鍵字比對或規則式評估;此技術仍在發展中,但在自動化、規模化的質性評估上潛力可觀。

```python
import google.generativeai as genai
import os
import json
import logging
from typing import Optional

# --- 設定 ---
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# 需先設定環境變數作為 API key 才能執行此腳本
# 例如在終端機:export GOOGLE_API_KEY='your_key_here'
try:
    genai.configure(api_key=os.environ["GOOGLE_API_KEY"])
except KeyError:
    logging.error("Error: GOOGLE_API_KEY environment variable not set.")
    exit(1)

# --- LLM 即評審用於法律問卷品質的評分準則(Rubric)---
LEGAL_SURVEY_RUBRIC = """
你是一位專精法律問卷的方法學專家,也是一位嚴格的法律審查者。你的任務是評估一道給定法律問卷題目的品質。
請就整體品質給出 1 到 5 分,並附上詳細理由與具體回饋。
請聚焦於以下準則:

1. **清晰度與精確性(分數 1-5):**
* 1:極度含糊、高度模稜兩可或令人困惑。
* 3:尚稱清楚,但仍有更精確的空間。
* 5:完全清楚、毫不含糊,且在法律術語(若適用)與意圖上都十分精確。

2. **中立性與偏見(分數 1-5):**
* 1:高度誘導性或帶有偏見,明顯把受訪者導向特定答案。
* 3:略帶暗示性,或可能被解讀為誘導性。
* 5:完全中立、客觀,不含任何誘導性語言或預設立場的字眼。

3. **相關性與聚焦(分數 1-5):**
* 1:與所述問卷主題無關,或超出範疇。
* 3:鬆散相關,但可以更聚焦。
* 5:與問卷目標直接相關,並妥善聚焦於單一概念。

4. **完整性(分數 1-5):**
* 1:省略了準確作答所需的關鍵資訊,或提供的脈絡不足。
* 3:大致完整,但缺少一些次要細節。
* 5:提供受訪者徹底作答所需的一切脈絡與資訊。

5. **對受眾的適切性(分數 1-5):**
* 1:使用目標受眾無法理解的行話,或對專家而言過於簡化。
* 3:大致適切,但某些用語可能偏難或過度簡化。
* 5:完美貼合目標問卷受眾所假定的法律知識與背景。

**輸出格式:**
你的回應「必須」是一個 JSON 物件,包含以下鍵:
* `overall_score`:一個 1 到 5 的整數(各準則分數的平均,或你的整體判斷)。
* `rationale`:一段簡潔摘要,說明為何給出此分數,並點出主要優缺點。
* `detailed_feedback`:一份條列清單,詳述對每項準則(清晰度、中立性、相關性、完整性、受眾適切性)的回饋,並提出具體改進建議。
* `concerns`:一份清單,列出任何具體的法律、倫理或方法學疑慮。
* `recommended_action`:一項簡短建議(例如:「為求中立而修改」、「照原樣核准」、「釐清範疇」)。
"""


class LLMJudgeForLegalSurvey:
    """運用生成式 AI 模型評估法律問卷題目品質的類別。"""

    def __init__(self, model_name: str = 'gemini-1.5-flash-latest', temperature: float = 0.2):
        """
        初始化 LLM Judge。
        參數:
            model_name (str):使用的 Gemini 模型名稱。
                              'gemini-1.5-flash-latest' 在速度與成本上較佳。
                              'gemini-1.5-pro-latest' 提供最高品質。
            temperature (float):生成溫度,越低越適合確定性評估。
        """
        self.model = genai.GenerativeModel(model_name)
        self.temperature = temperature

    def _generate_prompt(self, survey_question: str) -> str:
        """組出送給 LLM 評審的完整提示,將評分準則與待評題目串接。"""
        return f"{LEGAL_SURVEY_RUBRIC}\n\n---\n**待評估的法律問卷題目:**\n{survey_question}\n---"

    def judge_survey_question(self, survey_question: str) -> Optional[dict]:
        """
        以 LLM 評斷單一法律問卷題目的品質。
        參數:
            survey_question (str):待評估的法律問卷題目。
        回傳:
            Optional[dict]:含 LLM 判斷的字典,發生錯誤時回傳 None。
        """
        full_prompt = self._generate_prompt(survey_question)
        try:
            logging.info(f"Sending request to '{self.model.model_name}' for judgment...")
            response = self.model.generate_content(
                full_prompt,
                generation_config=genai.types.GenerationConfig(
                    temperature=self.temperature,
                    response_mime_type="application/json"
                )
            )
            # 檢查是否因內容審核或其他原因導致回應為空
            if not response.parts:
                safety_ratings = response.prompt_feedback.safety_ratings
                logging.error(f"LLM response was empty or blocked. Safety Ratings: {safety_ratings}")
                return None
            return json.loads(response.text)
        except json.JSONDecodeError:
            logging.error(f"Failed to decode LLM response as JSON. Raw response: {response.text}")
            return None
        except Exception as e:
            logging.error(f"An unexpected error occurred during LLM judgment: {e}")
            return None


# --- 範例用法 ---
if __name__ == "__main__":
    judge = LLMJudgeForLegalSurvey()

    # --- 良好範例 ---
    good_legal_survey_question = """
    To what extent do you agree or disagree that current intellectual property laws in Switzerland adequately protect emerging AI-generated content, assuming the content meets the originality criteria established by the Federal Supreme Court?
    (Select one: Strongly Disagree, Disagree, Neutral, Agree, Strongly Agree)
    """
    print("\n--- Evaluating Good Legal Survey Question ---")
    judgment_good = judge.judge_survey_question(good_legal_survey_question)
    if judgment_good:
        print(json.dumps(judgment_good, indent=2))

    # --- 帶偏見/不佳範例 ---
    biased_legal_survey_question = """
    Don't you agree that overly restrictive data privacy laws like the FADP are hindering essential technological innovation and economic growth in Switzerland?
    (Select one: Yes, No)
    """
    print("\n--- Evaluating Biased Legal Survey Question ---")
    judgment_biased = judge.judge_survey_question(biased_legal_survey_question)
    if judgment_biased:
        print(json.dumps(judgment_biased, indent=2))

    # --- 含糊/模糊範例 ---
    vague_legal_survey_question = """
    What are your thoughts on legal tech?
    """
    print("\n--- Evaluating Vague Legal Survey Question ---")
    judgment_vague = judge.judge_survey_question(vague_legal_survey_question)
    if judgment_vague:
        print(json.dumps(judgment_vague, indent=2))
```

`LLMJudgeForLegalSurvey` 透過 `google.generativeai` 與 Gemini 互動,把問卷題目連同詳細準則送給模型。準則涵蓋五項標準——清晰度與精確性、中立性與偏見、相關性與聚焦、完整性、對受眾的適切性——各給 1 到 5 分並要求附理由與回饋。`judge_survey_question` 要求模型依結構回傳 JSON(含整體分數、理由摘要、各標準詳細回饋、疑慮清單與建議行動),並處理 JSON 解碼錯誤或空回應等問題。腳本以良好、帶偏見、含糊三個範例示範運作。

在做結論前,先比較各種評估方法的優缺點。

| 評估方法 | 優點 | 缺點 |
| --- | --- | --- |
| 人工評估(Human Evaluation) | 能捕捉細微行為 | 難規模化、成本高且耗時,涉及主觀人為因素。 |
| LLM 即評審(LLM-as-a-Judge) | 一致、有效率且可規模化。 | 可能忽略中間步驟,受限於 LLM 本身能力。 |
| 自動化指標(Automated Metrics) | 可規模化、有效率且客觀。 | 在捕捉完整能力上可能有侷限。 |

## 代理軌跡(Agents trajectories)

評估代理軌跡(trajectory)至關重要,因為傳統軟體測試並不足夠:標準程式碼產出可預測的通過/失敗,代理則以機率方式運作,需同時對最終輸出與軌跡(達成解答的一連串步驟)做質性評估。多代理系統(multi-agent system)因不斷變動而更難評估,需要超越個體表現、衡量溝通與協作的精密指標,且測試方法須隨環境調適。

評估涉及檢視決策品質、推理過程與整體結果;超越原型階段後,自動化評估尤其有價值。分析軌跡與工具使用時,會把代理實際動作與預期的「基準真相(ground truth)」軌跡相比較。例如處理產品查詢的代理理想軌跡為:判定意圖、使用資料庫搜尋工具、審閱結果、生成報告。比較方法包括:完全比對(exact match)、依序比對(in-order match,允許額外步驟)、任意順序比對(any-order match)、精確率(precision)、召回率(recall),以及單一工具使用(single-tool use)。指標選擇取決於需求——高風險情境可能要求完全比對,有彈性的情況可採依序或任意順序比對。

代理評估主要有兩種做法:**測試檔(test files)** 與 **評估集檔(evalset files)**。測試檔為 JSON 格式,代表單一、簡單的互動或工作階段(session),適合開發期的單元測試,強調快速執行;每個測試檔含單一工作階段與多個回合(turn),一個回合即一次使用者與代理互動,包含查詢、預期工具使用軌跡、中間回應與最終回應。例如使用者要求「Turn off device_2 in the Bedroom」,指定代理使用 `set_device_info` 工具(location: Bedroom、device_id: device_2、status: OFF),預期最終回應為「I have set the device_2 status to off.」。測試檔可組織到資料夾並搭配 `test_config.json` 定義準則。評估集檔則以「評估集(evalset)」資料集評估互動,含多個可能很長的工作階段,適合模擬複雜多回合對話與整合測試(integration test);它由多個「評估(evals)」組成,每個代表一個工作階段含一或多個回合,並有參考最終回應(reference final response)。例如使用者先問「What can you do?」,再說「Roll a 10 sided dice twice and then check if 9 is a prime or not」,並定義預期的 `roll_die` 與 `check_prime` 工具呼叫及彙整結果的最終回應。

**多代理(Multi-agents):** 評估多代理系統很像評量團隊專案——眾多步驟與交接(handoff)反而是優勢,讓你能在每階段檢查品質。除了檢視每個代理在其職務上的表現,也必須評估整個系統的整體運作。可就協作動態提出幾個關鍵問題:

- **代理是否有效協作?** 例如「訂機票代理」訂好航班後,是否把正確日期與目的地傳給「訂飯店代理」?協作失敗可能導致飯店訂在錯誤週次。
- **是否擬定好計畫並貫徹?** 若計畫是先訂機票再訂飯店,而「飯店代理」在航班未確認前就訂房,就偏離了計畫。也要檢查代理是否卡關(例如無止盡搜尋「完美」租車卻不進入下一步)。
- **是否為正確任務選對代理?** 詢問旅程天氣應使用提供即時資料的「天氣代理」;若改用「一般知識代理」給出「夏天通常很溫暖」這種籠統答案,就選錯了工具。
- **增加更多代理是否提升表現?** 新增「餐廳訂位代理」是讓規劃更好,還是製造衝突、拖慢系統,顯示可擴展性(scalability)問題?

## 從代理到進階承包商(From Agents to Advanced Contractors)

近期有人提出(《Agent Companion》,gulli 等人)一種構想:從機率性、常不可靠的 AI 代理,演進為為高風險環境設計、更具確定性與當責性(accountable)的「承包商(contractors)」(見圖 2)。

當今代理依簡短、規格不足的指令運作,適合展示但在正式環境中脆弱——模糊性會導致失敗。「承包商」模型在使用者與 AI 間建立嚴謹、形式化的關係,如同人類的法律服務協議,由四大支柱支撐。

**一、形式化合約(Formalized Contract):** 一份作為單一事實來源(single source of truth)的詳細規格,遠超簡單提示。財務分析合約不會只說「analyze last quarter's sales」,而會要求「一份 20 頁 PDF 報告,分析 2025 年第一季歐洲市場銷售,含五個特定資料視覺化、與 2024 年第一季的對比分析,以及基於所附供應鏈中斷資料集的風險評估」。合約明確定義交付成果(deliverables)、精確規格、可接受資料來源、範疇,甚至預期運算成本與完成時間,使結果客觀可驗證。

**二、協商與回饋的動態生命週期(Dynamic Lifecycle of Negotiation and Feedback):** 合約是對話的起點而非靜態命令。承包商可分析條款並協商,例如當要求使用無法存取的專有資料來源時回饋:「指定的 XYZ 資料庫無法存取。請提供憑證,或核准使用替代的公開資料庫,但這可能略微改變資料粒度」。此階段讓代理在執行前標示模糊與風險,化解誤解、防止昂貴失敗,確保輸出契合真實意圖。

![圖 2:代理之間的合約執行範例。](assets/19-evaluation-and-monitoring/fig-2-contract-execution.png)

*圖 2:代理之間的合約執行範例。*

**三、以品質為核心的迭代執行(Quality-Focused Iterative Execution):** 與追求低延遲的代理不同,承包商優先重視正確性與品質,依循自我驗證(self-validation)與自我校正的原則。以程式碼生成合約為例,代理會生成多種演算法做法,針對合約定義的單元測試編譯執行,依效能、安全性與可讀性評分,只提交通過所有驗證的版本。這種「生成、審閱、改進直到符合規格」的內部迴路,對建立信任至關重要。

**四、透過子合約進行階層式分解(Hierarchical Decomposition via Subcontracts):** 對於複雜任務,主承包商代理可扮演專案經理,把目標拆解成更小的子任務,並生成形式化的「子合約(subcontracts)」。例如「建構電子商務行動應用程式」的主合約可分解為「設計 UI/UX」、「開發使用者驗證模組」、「建立產品資料庫綱要」、「整合金流閘道」等子合約;每個都是完整獨立的合約,可指派給專門代理。這種結構化分解讓系統能組織化、可規模化地處理龐大專案,標誌 AI 從工具轉為自主可靠的問題解決引擎。

歸根究柢,承包商框架把形式化規格、協商與可驗證執行嵌入代理核心邏輯,把 AI 從難以預測的助手提升為能以可稽核精確度自主管理複雜專案的可靠系統,為在「信任與當責至上」的關鍵任務領域部署 AI 鋪路。

## Google 的 ADK(Google's ADK)

最後看一個支援評估的具體框架。Google ADK 的代理評估(見圖 3)有三種方法:基於網頁的 UI(`adk web`),用於互動式評估與資料集生成;使用 pytest 的程式化整合,以納入測試管線;以及命令列介面(`adk eval`),適用於自動化評估(如定期建置與驗證)。

![圖 3:Google ADK 的評估支援。](assets/19-evaluation-and-monitoring/fig-3-adk-evaluation-support.png)

*圖 3:Google ADK 的評估支援。*

網頁 UI 讓使用者互動式建立工作階段並儲存到評估集,同時顯示評估狀態。pytest 整合透過呼叫 `AgentEvaluator.evaluate`(指定代理模組與測試檔路徑),把測試檔作為整合測試執行。命令列介面則以代理模組路徑與評估集檔促成自動化評估,可指定設定檔或印出詳細結果;在較大評估集中,可在檔名後以逗號分隔列出特定評估來選取執行。

## 重點速覽

**是什麼(What):** 代理式系統與 LLM 運作於複雜、動態環境,表現可能隨時間退化。其機率性、非確定性(non-deterministic)本質使傳統軟體測試不足以確保可靠性。多代理系統因與環境不斷變動,需要可調適的測試方法與能衡量協作成功的精密指標。資料漂移、非預期互動、工具呼叫與偏離目標等問題常在部署後浮現,因此持續評估有其必要,以衡量有效性、效率與對運作及安全要求的遵循程度。

**為什麼(Why):** 標準化的評估與監控框架提供有系統的方式評估並確保代理的持續表現。這涉及為準確度、延遲與資源消耗(如 token 用量)定義清楚指標,也包括分析軌跡以理解推理過程、運用 LLM 即評審做質性評估等進階技術。透過回饋迴路與報告系統,框架能促成持續改進、A/B 測試,以及對異常或效能漂移的偵測,確保代理與目標一致。

**經驗法則(Rule of thumb):** 當在即時、正式環境部署代理且即時表現與可靠性至關重要時使用;當需系統化比較代理或模型的不同版本以推動改進時;當在需合規、安全與倫理稽核的受監管或高風險領域運作時;當表現可能因資料或環境變化(漂移)而退化時;以及當評估複雜代理行為(動作軌跡與有用性等主觀輸出品質)時,此模式皆適用。

## 視覺摘要

![圖 4:評估與監控設計模式。](assets/19-evaluation-and-monitoring/fig-4-evaluation-monitoring-pattern.png)

*圖 4:評估與監控設計模式。*

## 重點整理

- 評估智慧代理超越傳統測試,要持續衡量其在真實環境中的有效性、效率與需求遵循程度。
- 實務應用包括:即時效能追蹤、改良用 A/B 測試、合規稽核,以及漂移與異常偵測。
- 基本評估著重回應準確度,真實情境則需更精密的指標,如延遲監控與 token 用量追蹤。
- 代理軌跡(一連串步驟)對評估至關重要,把實際動作與理想基準真相路徑相比較以找出錯誤與低效。
- ADK 提供結構化評估:用於單元測試的測試檔與用於整合測試的評估集檔,皆定義預期行為。
- 評估可透過網頁 UI 互動測試、以 pytest 做 CI/CD 整合,或透過命令列執行自動化工作流程。
- 要讓 AI 在高風險任務上可靠,須從簡單提示轉向形式化「合約」,精確定義可驗證的交付成果與範疇,讓代理能協商、釐清模糊並迭代驗證自身工作,從不可預測的工具轉為當責可信的系統。

## 結論

有效評估 AI 代理需超越單純的準確度檢查,轉而對動態環境中的表現做持續、多面向評估:包括對延遲與資源消耗的實務監控,以及透過軌跡對決策過程的精密分析。對於有用性這類細緻特質,LLM 即評審日益不可或缺,而 Google ADK 等框架則為單元與整合測試提供結構化工具。面對多代理系統時,焦點轉向評估協作成功與有效合作。

為確保關鍵應用的可靠性,典範正從提示驅動的代理轉向受形式化協議約束的「承包商」——它們依明確可驗證的條款運作,能協商、分解任務並自我驗證,以符合嚴格品質標準,從不可預測的工具轉為能處理高風險任務的當責系統。這項演進對於建立在關鍵任務領域部署精密代理式 AI 所需的信任,至關重要。

## 參考資料

相關研究包括:

1. ADK Web:<https://github.com/google/adk-web>
2. ADK Evaluate:<https://google.github.io/adk-docs/evaluate/>
3. Survey on Evaluation of LLM-based Agents:<https://arxiv.org/abs/2503.16416>
4. Agent-as-a-Judge: Evaluate Agents with Agents:<https://arxiv.org/abs/2410.10934>
5. Agent Companion, gulli et al.:<https://www.kaggle.com/whitepaper-agent-companion>
