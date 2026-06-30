# 第 9 章:學習與適應(Learning and Adaptation)

學習與適應讓 AI 代理(agent)得以超越預設參數,透過經驗與環境互動持續精進,在無須持續人工介入下因應全新情境並最佳化表現。本章探討支撐代理學習與適應的原理與機制。

## 宏觀圖像

代理會依新經驗與資料調整其思考、行動或知識,從單純遵循指令演化為日益聰明的系統。主要學習方式包括:

- **強化學習(Reinforcement Learning):** 透過嘗試行動、正向獲獎勵、負向受懲罰來學會最佳行為,適用於控制機器人或玩遊戲的代理。
- **監督式學習(Supervised Learning):** 從有標記範例學習輸入與輸出的對應,適合分類郵件或預測趨勢。
- **非監督式學習(Unsupervised Learning):** 在無標記資料中發掘隱藏模式與關聯,適用於無特定引導下探索資料。
- **少樣本／零樣本學習(Few-Shot/Zero-Shot):** LLM 代理以極少範例或清楚指令即可快速適應新任務。
- **線上學習(Online Learning):** 持續以新資料更新知識,對動態環境與連續資料流的即時反應至關重要。
- **以記憶為基礎的學習(Memory-Based):** 回想過往經驗以調整相似情境下的當前行動,強化情境感知與決策。

代理藉由改變策略、理解或目標來適應,這對身處不可預測或全新環境的代理尤為關鍵。

近端策略最佳化(Proximal Policy Optimization,PPO)是用於連續動作環境(如控制機器人關節或遊戲角色)的強化學習演算法,目標是穩定可靠地改進代理的決策策略(policy)。其核心理念是對策略進行小幅、謹慎的更新,避免劇烈變動導致表現崩潰:

1. **蒐集資料:** 代理以當前策略與環境互動,蒐集一批經驗(狀態、動作、獎勵)。
2. **評估「替代」目標:** PPO 計算潛在更新對預期獎勵的影響,但並非單純最大化,而是使用特殊的「裁剪(clipped)」目標函式。
3. **「裁剪」機制:** 這是 PPO 穩定的關鍵。它在當前策略周圍建立「信賴區域(trust region)」,禁止差異過大的更新,像一道安全煞車,避免抹煞學習成果的高風險步伐。

簡言之,PPO 在「改善表現」與「貼近已知可行策略」間取得平衡,避免訓練中的災難性失敗。

直接偏好最佳化(Direct Preference Optimization,DPO)是較新的方法,專為將 LLM 與人類偏好對齊而設計,比 PPO 更簡單直接。傳統以 PPO 為基礎的對齊是兩步驟流程:

1. **訓練獎勵模型(Reward Model):** 蒐集人類對不同回應的評分或比較(如「A 比 B 好」),用以訓練一個能預測人類評分的獨立模型。
2. **以 PPO 微調(Fine-Tune):** 讓 LLM 生成能從獎勵模型獲得最高分的回應,獎勵模型則扮演「裁判」。

這個流程複雜且不穩定——LLM 可能學會「駭入(hack)」獎勵模型,讓糟糕回應反而拿高分。

DPO 則完全跳過獎勵模型,直接運用偏好資料更新 LLM 策略。它利用一種把偏好資料直接連結到最佳策略的數學關係,本質上是教模型「提高生成偏好回應的機率、降低生成不被青睞回應的機率」。如此簡化了對齊過程,避免獨立獎勵模型帶來的複雜與不穩定,使對齊更有效率也更穩健。

## 實務應用與使用案例

適應型代理透過經驗資料驅動的迭代更新,在多變環境中展現更佳表現:

- **個人化助理代理**透過長期分析個別使用者行為精煉互動協定。
- **交易機器人代理**依即時市場資料動態調整模型參數,最大化報酬並降低風險。
- **應用程式代理**依觀察到的使用者行為動態修改介面與功能,提升參與度。
- **機器人與自動駕駛車輛代理**整合感測器資料與歷史行動分析,強化導航與反應能力。
- **詐欺偵測代理**以新發現的詐欺模式精煉模型,改進異常偵測。
- **推薦代理**運用偏好學習演算法提升內容選取的精準度與情境相關性。
- **遊戲 AI 代理**動態調整策略演算法,提升玩家參與度與遊戲挑戰性。
- **知識庫學習代理(Knowledge Base Learning Agents):** 運用檢索增強生成(RAG)維護由問題描述與已驗證解法構成的動態知識庫(參見第 14 章),透過套用先前成功模式或避開已知陷阱來適應新情境。

## 案例研究:自我改進的程式設計代理(SICA)

自我改進的程式設計代理(Self-Improving Coding Agent,SICA)由 Maxime Robeyns、Laurence Aitchison 與 Martin Szummer 開發,展現代理修改自身原始碼的能力。它既是修改者也是被修改者,迭代精煉自己的程式碼庫以提升程式設計表現,有別於傳統「由一個代理訓練另一個代理」的做法。

SICA 透過迭代循環運作(參見圖 1):先檢視由過往版本及其基準表現構成的封存檔(archive),依綜合成功率、耗時與運算成本的加權公式選出最高分版本;該版本分析封存檔找出改進處,直接更動自己的程式碼庫;修改後接受基準測試,結果再記錄回封存檔。如此重複,讓 SICA 在不需傳統訓練範式下直接從過往表現演進能力。

![圖 1:SICA 的自我改進——依據其過往版本進行學習與適應。](assets/09-learning-and-adaptation/fig-1-sica-self-improvement.png)

*圖 1:SICA 的自我改進——依據其過往版本進行學習與適應。*

SICA 在程式碼編輯與導覽上有顯著進展。編輯方面,從最初的「檔案覆寫」做法,演進為更具情境感知的「智慧編輯器(Smart Editor)」,再到納入差異比對(diff)的「差異增強智慧編輯器(Diff-Enhanced Smart Editor)」,以及降低處理需求的「快速覆寫工具(Quick Overwrite Tool)」;並實作「最小差異輸出最佳化」與「情境敏感差異最小化」,運用抽象語法樹(AST)解析提升效率,還新增「智慧編輯器輸入正規化器」。導覽方面,SICA 自主建立運用 AST 結構地圖辨識定義的「AST 符號定位器」,後續發展出結合快速搜尋與 AST 檢查的「混合式符號定位器」,並透過最佳化 AST 解析聚焦相關程式碼區段以加速搜尋(參見圖 2)。

![圖 2:歷次迭代的表現。關鍵的改進都標註了其對應的工具或代理修改。](assets/09-learning-and-adaptation/fig-2-performance-across-iterations.png)

*圖 2:歷次迭代的表現。關鍵的改進都標註了其對應的工具或代理修改。(圖片由 Maxime Robeyns、Martin Szummer、Laurence Aitchison 提供)*

SICA 的架構包含用於檔案操作、指令執行與算術計算的基礎工具組,以及提交結果與呼叫專門子代理(sub-agent,涵蓋程式設計、問題解決與推理)的機制。這些子代理分解複雜任務並管理 LLM 的情境長度(context length),在漫長改進循環中尤為重要。

一個非同步的監督者(overseer,另一個 LLM)會監控 SICA 行為,辨識迴圈或停滯等問題,必要時介入中止執行。它會收到包含呼叫圖(callgraph)與訊息、工具行動紀錄的詳細報告,以辨識模式與低效之處。

SICA 的 LLM 在情境視窗(短期記憶)中以結構化方式組織資訊,這對其運作至關重要,包含:定義目標、工具與子代理文件及系統指令的「系統提示(System Prompt)」;包含問題陳述、開啟檔案內容與目錄地圖的「核心提示(Core Prompt)」;以及記錄逐步推理、工具與子代理呼叫結果及監督者通訊的「助理訊息(Assistant Messages)」。檔案變更最初以差異(diff)形式記錄並定期彙整,促進高效資訊流動、降低處理時間與成本。

**SICA:程式碼一瞥(A Look at the Code):** SICA 採用模組化架構,納入程式設計、問題解決與推理等子代理,由主代理像工具呼叫般呼叫,以分解複雜任務並管理情境長度。專案正積極開發,目標是為對 LLM 工具使用後訓練(post-training)有興趣者提供穩健框架,完整程式碼見 <https://github.com/MaximeRobeyns/self_improving_coding_agent/>。

幾項關鍵設計值得注意:為安全起見,代理在專屬 Docker 容器中執行,提供與主機的隔離,降低代理執行 shell 指令時竄改檔案系統等風險;系統具備穩健可觀測性,透過互動式網頁視覺化事件匯流排與呼叫圖,讓使用者檢視個別事件、閱讀監督者訊息並摺疊子代理軌跡;框架支援整合不同供應商的 LLM,便於為特定任務挑選最契合的模型;而非同步監督者則平行運作,定期評估行為是否出現病態偏差(pathological deviation)或停滯,可發送通知甚至取消執行。

SICA 最初的一項挑戰是:如何促使 LLM 代理在每次迭代中自主提出新穎、可行且引人入勝的修改。在 LLM 代理身上培養開放式學習(open-ended learning)與真正的創造力,至今仍是當前研究的關鍵領域。

## AlphaEvolve 與 OpenEvolve

AlphaEvolve 是 Google 開發、旨在發掘與最佳化演算法的 AI 代理,結合 LLM(Gemini 的 Flash 與 Pro)、自動化評估系統與演化演算法(evolutionary algorithm)框架,目標是同時推進理論數學與實務運算應用。它以 Gemini 模型集成(ensemble)運作:Flash 生成廣泛的初步提案,Pro 提供深入分析與精煉;所提演算法依預定標準自動評估評分,回饋再迭代改進解法。

實務上,AlphaEvolve 已部署於 Google 基礎設施:改進資料中心排程使全球運算使用量減少 0.7%;為即將推出的張量處理單元(TPU)建議 Verilog 程式碼最佳化;讓 Gemini 某關鍵核心(kernel)提速 23%,並為 FlashAttention 最佳化多達 32.5% 的低階 GPU 指令。基礎研究上,它發掘出針對 4×4 複數值矩陣僅用 48 次純量乘法的矩陣乘法演算法,超越先前解法;並在 75% 的案例中重新發掘 50 多個開放問題的最先進解法、在 20% 的案例中改進現有解法(如親吻數問題的進展)。

OpenEvolve 是運用 LLM 迭代最佳化程式碼的演化式程式設計代理(參見圖 3),編排「程式碼生成、評估與選取」管線。其關鍵特點是能演化整個程式碼檔案而非僅單一函式;它為通用性而設計,支援多種語言、相容任何 LLM 的 OpenAI 相容 API,並納入多目標最佳化、彈性提示工程與分散式評估。

![圖 3:OpenEvolve 的內部架構由一個控制器(controller)所管理。](assets/09-learning-and-adaptation/fig-3-openevolve-architecture.png)

*圖 3:OpenEvolve 的內部架構由一個控制器(controller)所管理。此控制器編排了數個關鍵元件:程式取樣器(program sampler)、程式資料庫(Program Database)、評估器池(Evaluator Pool)與 LLM 集成(LLM Ensembles)。其主要功能是促進它們的學習與適應歷程,以提升程式碼品質。*

以下程式碼以 OpenEvolve 函式庫對程式進行演化式最佳化:用初始程式、評估檔與設定檔的路徑初始化系統,`evolve.run(iterations=1000)` 啟動 1000 次迭代的演化,最後印出最佳程式各項指標(格式化至小數點後四位)。

```python
from openevolve import OpenEvolve

# 初始化系統
evolve = OpenEvolve(
    initial_program_path="path/to/initial_program.py",
    evaluation_file="path/to/evaluator.py",
    config_path="path/to/config.yaml"
)

# 執行演化
best_program = await evolve.run(iterations=1000)

print(f"Best program metrics:")
for name, value in best_program.metrics.items():
    print(f"  {name}: {value:.4f}")
```

## 重點速覽

**是什麼(What):** AI 代理常在動態、不可預測的環境中運作,寫死的邏輯並不足夠。面對設計時未曾預料的全新情境時,代理表現可能退化;若缺乏從經驗中學習的能力,便無法隨時間最佳化策略或個人化互動,這種僵化限制了其效用與自主性。

**為什麼(Why):** 標準解法是整合學習與適應機制,把靜態代理轉變為動態演進的系統,使其能依新資料與互動自主精煉知識與行為。方法多樣,從強化學習,到如 SICA 的自我修改(self-modification),再到如 Google AlphaEvolve 運用 LLM 與演化演算法為複雜問題發掘全新解法。透過持續學習,代理能精通新任務、提升表現,並在無須重新編程下適應變動條件。

**經驗法則(Rule of thumb):** 當建構必須在動態、不確定或不斷演進環境中運作的代理時使用此模式。它對需要個人化、持續提升表現,以及能自主因應全新情境的應用至關重要。

## 視覺摘要

![圖 4:學習與適應模式。](assets/09-learning-and-adaptation/fig-4-learning-and-adapting-pattern.png)

*圖 4:學習與適應模式。*

## 重點整理

- 學習與適應的重點在於代理運用經驗把工作做得愈來愈好,並因應新情境;「適應」即源自學習的、可見的行為或知識改變。
- SICA 透過依過往表現修改自身程式碼進行自我改進,催生了智慧編輯器與 AST 符號定位器等工具。專門「子代理」與「監督者」有助於管理龐大任務並維持正軌。
- LLM「情境視窗」的設定方式(系統提示、核心提示、助理訊息)對代理運作效率極為重要。
- 此模式對需在不斷變動、不確定或需個人化觸感之環境中運作的代理至關重要;建構會學習的代理往往需連接機器學習工具並管理資料流動。
- 配備基本程式設計工具的代理系統能自主編輯自己以提升基準表現。
- AlphaEvolve 是 Google 的 AI 代理,運用 LLM 與演化框架自主發掘與最佳化演算法,大幅推進基礎研究與實務運算應用。

## 結論

本章探討學習與適應在 AI 中的關鍵角色:代理透過持續取得資料與經驗提升表現,SICA 即透過程式碼修改自主改進的典範。

回顧代理式 AI 的各項基礎元件(架構、應用、規劃、多代理協作、記憶管理與學習適應),學習原理對多代理系統的協調改進尤其重要——為此,調校資料(tuning data)必須準確反映完整互動軌跡,捕捉每個代理的個別輸入與輸出。這些元素共同促成了如 Google AlphaEvolve 的重大進展:透過 LLM、自動化評估與演化方法自主發掘與精煉演算法。這類模式可相互結合以建構精密的 AI 系統,證明由 AI 代理進行自主演算法發掘與最佳化是可實現的。

## 參考資料

1. Sutton, R. S., & Barto, A. G. (2018). Reinforcement Learning: An Introduction. MIT Press.
2. Goodfellow, I., Bengio, Y., & Courville, A. (2016). Deep Learning. MIT Press.
3. Mitchell, T. M. (1997). Machine Learning. McGraw-Hill.
4. Proximal Policy Optimization Algorithms, by John Schulman, Filip Wolski, Prafulla Dhariwal, Alec Radford, and Oleg Klimov. arXiv: <https://arxiv.org/abs/1707.06347>
5. Robeyns, M., Aitchison, L., & Szummer, M. (2025). A Self-Improving Coding Agent. arXiv:2504.15228v2. <https://arxiv.org/pdf/2504.15228> ; <https://github.com/MaximeRobeyns/self_improving_coding_agent>
6. AlphaEvolve blog: <https://deepmind.google/discover/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/>
7. OpenEvolve: <https://github.com/codelion/openevolve>
