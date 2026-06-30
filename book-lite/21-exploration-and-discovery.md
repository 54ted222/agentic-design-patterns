# 第 21 章:探索與發現(Exploration and Discovery)

本章探討一系列讓智慧代理(intelligent agent)能主動搜尋新資訊、發掘新可能性,並辨識出「未知的未知(unknown unknowns)」的模式。探索與發現有別於反應式行為,也不同於在預定義解空間內最佳化;它強調代理主動進入陌生領域、實驗新做法,並生成新知識。當靜態知識或預寫解法不敷使用時,這對運作於開放式、複雜或快速演變領域的代理至關重要,因為它擴展了代理自身的理解與能力。

## 實務應用與使用案例

具備智慧排序與探索能力的 AI 代理,能在複雜環境中穿梭、發掘隱藏洞見並推動創新,進而最佳化流程、發現新知並生成內容。範例:

- **科學研究自動化:** 設計並執行實驗、分析結果、提出假說,以發現新材料、候選藥物或科學原理。
- **遊戲對弈與策略生成:** 探索遊戲狀態,發掘湧現策略或環境弱點(例如 AlphaGo)。
- **市場研究與趨勢觀察:** 掃描非結構化資料(社群媒體、新聞、報告),辨識趨勢、消費者行為或市場機會。
- **資安漏洞發掘:** 探查系統或程式碼庫,找出安全缺陷或攻擊向量。
- **創意內容生成:** 探索風格、主題或資料的組合,生成藝術、音樂或文學作品。
- **個人化教育與訓練:** AI 家教依學生進度、學習風格與弱點,排定學習路徑與內容優先順序。

## Google 共同科學家(Google Co-Scientist)

AI 共同科學家是 Google Research 開發、運行於 Gemini LLM 之上的運算層面科學協作者。它在假說生成、提案精煉與實驗設計等面向協助人類科學家,目的是處理早期研究中運算要求極高的部分,以增益(而非取代)人類的認知歷程,並有可能揭示資料中的關聯性。

**系統架構與方法論:** 它建立在多代理框架之上,整合多個專門化代理,各自扮演特定角色;一個監督代理(supervisor agent)在非同步任務執行框架內協調這些活動,使運算資源得以彈性擴展。核心代理及其功能包括(見圖 1):

- **生成代理(Generation agent):** 透過文獻探索與模擬科學辯論,產生初步假說。
- **反思代理(Reflection agent):** 扮演同儕審查者,評估假說的正確性、新穎性與品質。
- **排序代理(Ranking agent):** 以 Elo 為基礎的錦標賽機制,透過模擬辯論比較並排序假說。
- **演化代理(Evolution agent):** 透過簡化概念、綜整想法與探索非傳統推理路徑,精煉排名最高的假說。
- **鄰近代理(Proximity agent):** 計算鄰近圖,將相似想法分群,協助探索整個假說地景。
- **後設審查代理(Meta-review agent):** 綜整所有審查與辯論的洞見,辨識共通模式並回饋,使系統持續改善。

系統以 Gemini 提供語言理解、推理與生成能力,並納入「測試時運算擴展(test-time compute scaling)」,配置更多運算資源以迭代強化輸出,同時綜整學術文獻、網路資料與資料庫等多元來源。

![圖 1:(由作者提供)AI 共同科學家:從發想到驗證](assets/21-exploration-and-discovery/fig-1-ai-co-scientist-overview.png)

*圖 1:(由作者提供)AI 共同科學家:從發想(Ideation)到驗證(Validation)。*

系統依循迭代式的「生成、辯論、演化(generate, debate, and evolve)」做法,呼應科學方法。在人類輸入科學問題後,系統便進入自我改善循環,對假說進行生成、評估與精煉,評估包含代理間的內部評估與錦標賽式排序。

**驗證與成果:** 系統效用已在多項驗證研究(尤其生物醫學領域)中,透過自動化基準測試、專家審查與端到端濕式實驗室(wet-lab)實驗獲得展示。

**自動化與專家評估:** 在 GPQA 基準的艱難「鑽石集(diamond set)」上達到 78.4% 的 top-1 準確率,內部 Elo 評分與結果準確度相符。橫跨 200 多個研究目標的分析顯示,擴展測試時運算能持續提升假說品質(以 Elo 衡量)。在精選的 15 個挑戰性問題上,其表現勝過其他最先進 AI 模型與人類專家的「最佳猜測」。小規模評估中,生物醫學專家認為其輸出更具新穎性與影響力;其針對藥物再利用、依 NIH「特定目標(Specific Aims)」格式呈現的提案,也被六位腫瘤科專家評為高品質。

**端到端實驗驗證:**

- **藥物再利用(Drug Repurposing):** 針對急性骨髓性白血病(AML)提出新穎候選藥物,其中如 KIRA6 在 AML 上並無先前臨床前證據;後續體外實驗證實 KIRA6 等藥物能在臨床相關濃度下抑制多種 AML 細胞株的存活力。
- **新穎標靶發現(Novel Target Discovery):** 辨識出與肝纖維化相關的新穎表觀遺傳標靶,人類肝臟類器官實驗驗證其顯著抗纖維化活性;其中一藥物已獲 FDA 核准用於另一病症,開啟再利用契機。
- **抗生素抗藥性(Antimicrobial Resistance):** 系統獨立重現尚未發表的發現——在兩天內提出 cf-PICIs 會與多樣化噬菌體尾部(phage tail)交互作用以擴展宿主範圍的假說,呼應一個獨立團隊歷時十多年才實驗驗證的結論。

**增益與侷限:** 其設計哲學強調增益人類研究而非完全自動化,研究者在「科學家在迴路中(scientist-in-the-loop)」典範下以自然語言引導 AI、提供回饋。侷限包括:知識受限於開放取用文獻(可能遺漏付費牆後的研究)、對負面實驗結果取用有限,以及繼承底層 LLM 的侷限(如事實錯誤或幻覺)。

**安全性:** 系統納入多重防護:所有研究目標與生成假說皆經安全審查,以防被用於不安全或不合倫理的研究。一項以 1,200 個對抗性目標進行的評估顯示系統能穩健拒絕危險輸入,並透過「信任測試者計畫(Trusted Tester Program)」逐步開放以蒐集真實回饋。

## 動手實作範例

以下以 Agent Laboratory(由 Samuel Schmidgall 以 MIT 授權開發)為例。它是一個自主研究工作流程框架,運用專門化 LLM 自動化科學研究各階段,讓人類研究者更專注於概念建構與批判性分析。框架整合了「AgentRxiv」——一個供自主研究代理存放、檢索與發展研究成果的去中心化儲存庫。

Agent Laboratory 引導研究歷程經過數個階段:

1. **文獻回顧(Literature Review):** LLM 代理自主蒐集並批判性分析相關文獻,運用 arXiv 等資料庫辨識、綜整並分類研究,建立知識基礎。
2. **實驗(Experimentation):** 涵蓋實驗設計、資料準備、執行與結果分析,運用 Python(程式碼生成執行)與 Hugging Face(存取模型)等工具進行迭代式自動化實驗。
3. **報告撰寫(Report Writing):** 自動綜整實驗發現與文獻洞見、依學術慣例建構文件,並整合 LaTeX 等工具排版與生成圖表。
4. **知識分享(Knowledge Sharing):** AgentRxiv 讓代理分享、存取並協作推進發現,在先前成果上累積建構。

其模組化架構確保運算彈性,目標是自動化任務以提升研究生產力,同時維持人類研究者的角色。

**程式碼分析:** 全面分析超出本書範圍,以下提供關鍵洞見,鼓勵你自行深入鑽研。

**評判(Judgment):** 系統採用三方代理評判機制,部署三個分別設定不同觀點的自主代理來評估產出,共同模擬人類評判細膩而多面向的本質,以達成超越單一指標的穩健質性評鑑。

```python
class ReviewersAgent:
    def __init__(self, model="gpt-4o-mini", notes=None,
                 openai_api_key=None):
        if notes is None: self.notes = []
        else: self.notes = notes
        self.model = model
        self.openai_api_key = openai_api_key

    def inference(self, plan, report):
        reviewer_1 = "你是一位嚴格但公正的審查者,期望看到能為研究主題帶來洞見的優良實驗。"
        review_1 = get_score(outlined_plan=plan, latex=report,
            reward_model_llm=self.model, reviewer_type=reviewer_1,
            openai_api_key=self.openai_api_key)

        reviewer_2 = "你是一位嚴格、挑剔但公正的審查者,正在尋找能對該領域產生重大影響的想法。"
        review_2 = get_score(outlined_plan=plan, latex=report,
            reward_model_llm=self.model, reviewer_type=reviewer_2,
            openai_api_key=self.openai_api_key)

        reviewer_3 = "你是一位嚴格但公正、思想開放的審查者,正在尋找前所未有的新穎想法。"
        review_3 = get_score(outlined_plan=plan, latex=report,
            reward_model_llm=self.model, reviewer_type=reviewer_3,
            openai_api_key=self.openai_api_key)

        return f"Reviewer #1:\n{review_1}, \nReviewer #2:\n{review_2}, \nReviewer #3:\n{review_3}"
```

這些評判代理搭配特定提示,模擬人類審查者的認知框架與評估準則(相關性、連貫性、事實準確度與整體品質),藉此逼近人類洞察力的評估精細度。

````python
def get_score(outlined_plan, latex, reward_model_llm,
              reviewer_type=None, attempts=3, openai_api_key=None):
    e = str()
    for _attempt in range(attempts):
        try:
            template_instructions = """
請以下列格式回應:

THOUGHT(思考):
<THOUGHT>

REVIEW JSON(審查 JSON):
```json
<JSON>
```

在 <THOUGHT> 中,先簡要說明你對此次評估的直覺與推理。詳述你的高層次論點、必要的取捨,以及這次審查所期望達成的結果。此處不要做籠統評論,而要針對你眼前這篇論文具體論述。把這當作審查的筆記階段。

在 <JSON> 中,以 JSON 格式依下列順序提供審查內容,欄位如下:
- "Summary":論文內容與其貢獻的摘要。
- "Strengths":論文優點的清單。
- "Weaknesses":論文缺點的清單。
- "Originality":1 到 4 的評分(低、中、高、非常高)。
- "Quality":1 到 4 的評分(低、中、高、非常高)。
- "Clarity":1 到 4 的評分(低、中、高、非常高)。
- "Significance":1 到 4 的評分(低、中、高、非常高)。
- "Questions":一組請論文作者回答的釐清性問題。
- "Limitations":這項研究的侷限以及潛在的負面社會影響清單。
- "Ethical Concerns":一個布林值,表示是否存在倫理疑慮。
- "Soundness":1 到 4 的評分(差、尚可、良好、優秀)。
- "Presentation":1 到 4 的評分(差、尚可、良好、優秀)。
- "Contribution":1 到 4 的評分(差、尚可、良好、優秀)。
- "Overall":1 到 10 的評分(非常強烈拒絕到得獎級別)。
- "Confidence":1 到 5 的評分(低、中、高、非常高、絕對)。
- "Decision":必須是下列其中之一的決定:接受(Accept)、拒絕(Reject)。

在 "Decision" 欄位,不要使用 Weak Accept、Borderline Accept、Borderline Reject 或 Strong Reject,而是只能使用 Accept 或 Reject。這份 JSON 會被自動解析,所以請確保格式精確無誤。
"""
````

系統圍繞各種專門化角色建構研究歷程,模擬典型學術階層以順暢化工作流程並最佳化產出。

**教授代理(Professor Agent):** 扮演主要研究主任,負責建立研究議程、定義問題並委派任務,設定策略方向並確保與專案目標一致。

```python
class ProfessorAgent(BaseAgent):
    def __init__(self, model="gpt4omini", notes=None, max_steps=100,
                 openai_api_key=None):
        super().__init__(model, notes, max_steps, openai_api_key)
        self.phases = ["report writing"]

    def generate_readme(self):
        sys_prompt = f"""你是 {self.role_description()}。\n 以下是已撰寫好的論文 \n{self.report}。任務指示:你的目標是整合提供給你的所有知識、程式碼、報告與筆記,為一個 github 儲存庫生成一份 readme.md。"""
        history_str = "\n".join([_[1] for _ in self.history])
        prompt = (
            f"""歷史紀錄:{history_str}\n{'~' * 10}\n"""
            f"請在下方以 markdown 格式產出 readme:\n")
        model_resp = query_model(model_str=self.model,
            system_prompt=sys_prompt, prompt=prompt,
            openai_api_key=self.openai_api_key)
        return model_resp.replace("```markdown", "")
```

**博士後代理(PostDoc Agent):** 負責執行研究,包括文獻回顧、設計實作實驗,並生成論文等產出。它具備撰寫並執行程式碼的能力,是研究產物(research artifact)的主要生產者。

```python
class PostdocAgent(BaseAgent):
    def __init__(self, model="gpt4omini", notes=None, max_steps=100,
                 openai_api_key=None):
        super().__init__(model, notes, max_steps, openai_api_key)
        self.phases = ["plan formulation", "results interpretation"]

    def context(self, phase):
        sr_str = str()
        if self.second_round:
            # 提供給模型的先前實驗背景資訊
            sr_str = (
                f"以下是先前實驗的結果\n",
                f"先前的實驗程式碼:{self.prev_results_code}\n"
                f"先前的結果:{self.prev_exp_results}\n"
                f"先前對結果的詮釋:{self.prev_interpretation}\n"
                f"先前的報告:{self.prev_report}\n"
                f"{self.reviewer_response}\n\n\n"
            )
        if phase == "plan formulation":
            return (
                sr_str,
                f"目前的文獻回顧:{self.lit_review_sum}",
            )
        elif phase == "results interpretation":
            return (
                sr_str,
                f"目前的文獻回顧:{self.lit_review_sum}\n"
                f"目前的計畫:{self.plan}\n"
                f"目前的資料集程式碼:{self.dataset_code}\n"
                f"目前的實驗程式碼:{self.results_code}\n"
                f"目前的結果:{self.exp_results}"
            )
        return ""
```

**審查代理(Reviewer Agents):** 批判性評估博士後代理的產出,評鑑論文與實驗的品質、效度與科學嚴謹度,模擬學術同儕審查歷程以確保定稿前達到高水準。

**機器學習工程代理(ML Engineering Agents):** 擔任機器學習工程師,與博士生對話協作開發程式碼。核心功能是生成簡明的資料前處理程式碼,並整合文獻回顧與實驗協定的洞見,確保資料妥善格式化並為實驗做好準備。

```
"你是一位機器學習工程師,由一位博士生指導你撰寫程式碼,而你可以透過對話與他們互動。\n"
"你的目標是產出能為所提供之實驗準備資料的程式碼。你應該以簡單的程式碼來準備資料,而非複雜的程式碼。你應該整合所提供的文獻回顧與計畫,並想出能為這項實驗準備資料的程式碼。\n"
```

**軟體工程代理(SWEngineerAgents):** 引導機器學習工程代理,協助其為特定實驗建立直觀的資料準備程式碼。它整合文獻回顧與實驗計畫,確保生成的程式碼簡明且與研究目標直接相關。

```
"你是一位指導機器學習工程師的軟體工程師,由機器學習工程師負責撰寫程式碼,而你可以透過對話與他們互動。\n"
"你的目標是協助這位機器學習工程師產出能為所提供之實驗準備資料的程式碼。你應該以非常簡單的程式碼來準備資料,而非複雜的程式碼。你應該整合所提供的文獻回顧與計畫,並想出能為這項實驗準備資料的程式碼。\n"
```

總而言之,Agent Laboratory 是一個自主科學研究的精密框架,透過自動化關鍵研究階段與促進 AI 驅動的協作式知識生成,在維持人類監督的同時增益研究能力與效率。

## 重點速覽

**是什麼(What):** AI 代理往往在預定義的知識範圍內運作,難以處理新穎情況或開放式問題。在複雜動態環境中,靜態、預寫的資訊不足以促成真正的創新或發現。根本挑戰在於:如何讓代理超越單純最佳化,主動搜尋新資訊並辨識「未知的未知」。這需要從反應式行為轉向能擴展系統自身理解與能力的主動式、代理式探索。

**為什麼(Why):** 標準解法是建構專為自主探索與發現設計的代理式 AI 系統,通常運用多代理框架讓專門化 LLM 協作以模擬科學方法等歷程——例如分別賦予代理生成假說、批判審查與演化最有前景概念的任務。這種結構化協作方法,讓系統得以在浩瀚資訊地景中穿梭、設計並執行實驗、生成嶄新知識,並透過自動化勞力密集的部分大幅加速發現。

**經驗法則(Rule of thumb):** 當你運作於開放式、複雜或快速演變、解空間尚未完全定義的領域時使用本模式。它適合需要生成新穎假說、策略或洞見的任務,如科學研究、市場分析與創意內容生成;當目標是揭露「未知的未知」而不只是最佳化已知流程時,本模式不可或缺。

## 視覺摘要

![圖 2:探索與發現設計模式](assets/21-exploration-and-discovery/fig-2-exploration-and-discovery-pattern.png)

*圖 2:探索與發現設計模式。*

## 結論

探索與發現模式是真正具代理性(agentic)系統的本質,定義了系統超越被動遵循指令、主動探索環境的能力——它不僅執行任務,更會獨立設定子目標以揭露新資訊。這種代理式驅力在多代理框架中得到最強的實現,每個代理在更大的協作歷程中體現特定主動角色。Google 共同科學家能自主生成、辯論並演化假說;Agent Laboratory 則以模擬人類研究團隊的代理式階層,讓系統自我管理整個發現生命週期。

本模式的核心,在於編排湧現的代理式行為,讓系統得以在最少人類介入下追求長期、開放式目標,把 AI 定位為真正的代理式協作者。如此一來,透過自動化文獻回顧、實驗與報告撰寫等運算密集任務,人類的智識與創造力得到大幅增益,創新與問題解決得以加速。發展如此強大的代理式能力,也必然要求對安全與倫理監督做出堅定承諾。歸根究柢,這個模式為打造真正具代理性的 AI 提供了藍圖,把運算工具轉化為追求知識道路上獨立、以目標為導向的夥伴。

## 參考資料

1. Exploration-Exploitation Dilemma: A fundamental problem in reinforcement learning and decision-making under uncertainty.
   <https://en.wikipedia.org/wiki/Exploration%E2%80%93exploitation_dilemma>
2. Google Co-Scientist:
   <https://research.google/blog/accelerating-scientific-breakthroughs-with-an-ai-co-scientist/>
3. Agent Laboratory: Using LLM Agents as Research Assistants:
   <https://github.com/SamuelSchmidgall/AgentLaboratory>
4. AgentRxiv: Towards Collaborative Autonomous Research:
   <https://agentrxiv.github.io/>
