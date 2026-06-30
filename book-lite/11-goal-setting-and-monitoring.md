# 第 11 章:目標設定與監控(Goal Setting and Monitoring)

要讓 AI 代理(AI agent)真正有效且具目的性,光有處理資訊或使用工具的能力還不夠,它們還需要清楚的方向感,以及能知道自己是否真正有所進展的方法。這正是目標設定與監控模式的核心:賦予代理具體目標,並配備追蹤進度、判定目標是否達成的手段。

## 目標設定與監控模式總覽

想像規劃一趟旅行:你會先決定目的地(目標狀態)、確認出發點(初始狀態)、考量選項(交通、路線、預算),再排出一連串步驟。這種顧及相依關係與限制的逐步推進,本質上就是代理系統中的「規劃(planning)」。

在 AI 代理中,規劃通常是代理接收一個高層次目標,自主或半自主地生成一系列中間步驟或子目標(sub-goal),再循序或以更複雜的流程執行,過程中可能搭配工具使用、路由或多代理協作等模式。規劃機制可能運用搜尋演算法、邏輯推理,或愈來愈常見地借助 LLM 生成合理而有效的計畫。

良好的規劃讓代理得以處理多步驟、多面向的請求,並透過重新規劃(replanning)適應變化的情境,協調複雜的工作流程。這是一種基礎模式,能把單純的反應式(reactive)系統,轉變為主動朝既定目標努力的系統。

## 實務應用與使用案例

此模式對於在複雜真實情境中自主、可靠運作的代理至關重要:

- **客戶支援自動化:** 目標如「解決客戶帳單疑問」。代理監控對話、查核資料庫、運用工具調整帳單;以「帳單已變更且獲客戶正面回饋」判定成功,問題未解則升級處理(escalate)。
- **個人化學習系統:** 目標如「提升學生對代數的理解」。代理追蹤練習進度、準確率與完成時間,在學生遇到困難時調整教材與教學方式。
- **專案管理助理:** 目標如「確保里程碑 X 在 Y 日期前完成」。代理監控任務狀態、團隊溝通與資源,標示延遲並建議修正措施。
- **自動化交易機器人:** 目標如「在風險承受度內最大化投資組合收益」。代理持續監控市場資料、投資組合價值與風險指標,符合條件時執行交易,風險突破門檻時調整策略。
- **機器人與自駕車:** 目標如「安全把乘客從 A 運送到 B」。車輛持續監控環境(車輛、行人、號誌)、自身狀態(車速、油量)與行進進度,並調整駕駛行為。
- **內容審核:** 目標如「辨識並移除有害內容」。代理監控傳入內容、套用分類模型、追蹤誤判(false positives/negatives),調整過濾標準或把模稜兩可案例升級給人工審核。

此模式為智慧化的自我管理提供了必要框架,使代理能可靠達成特定成果並適應動態條件。

## 動手實作範例

以下用 LangChain 與 OpenAI API 示範此模式。這支 Python 腳本勾勒出一個自主 AI 代理,專門生成並精煉 Python 程式碼,在產出解決方案的同時確保符合使用者定義的品質基準。

它採用「創作、自我評估、改善」的迭代循環:不只生成一次程式碼,而是由代理以 AI 驅動的判斷,衡量所生成的程式碼是否滿足最初目標。最終輸出是一個經潤飾、附註解、可立即使用的 Python 檔案。

相依套件:

```bash
pip install langchain_openai openai python-dotenv
```

附帶金鑰 `OPENAI_API_KEY` 的 `.env` 檔案。

可以把這支腳本想像成一位被指派專案的自主 AI 程式設計師(見圖 1):過程始於你交給它一份詳細的專案說明書,也就是要解決的具體程式設計問題。

```python
# MIT License
# Copyright (c) 2025 Mahtab Syed
# https://www.linkedin.com/in/mahtabsyed/

"""
動手實作範例 - 第 2 次迭代
- 以 LangChain 與 OpenAI API 示範「目標設定與監控」模式。

目標:打造一個能依指定目標,為特定使用案例撰寫程式碼的 AI 代理:
- 在程式碼中或以輸入方式接收一個程式設計問題(使用案例)。
- 在程式碼中或以輸入方式接收一份目標清單(例如「簡單」「已測試」「處理邊界情況」)。
- 使用 LLM(如 GPT-4o)生成並精煉 Python 程式碼,直到目標達成(此處最多 5 次迭代,也可改成依設定目標決定)。
- 為了判斷是否達成目標,請 LLM 評判並只回答 True 或 False,方便停止迭代。
- 把最終程式碼存成 .py 檔,含乾淨的檔名與標頭註解。
"""

import os
import random
import re
from pathlib import Path
from langchain_openai import ChatOpenAI
from dotenv import load_dotenv, find_dotenv

# 🔐 載入環境變數
_ = load_dotenv(find_dotenv())
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
if not OPENAI_API_KEY:
    raise EnvironmentError("❌ 請設定 OPENAI_API_KEY 環境變數。")

# 📡 初始化 OpenAI 模型
print("✅ 正在初始化 OpenAI LLM (gpt-4o)...")
llm = ChatOpenAI(
    model="gpt-4o",  # 若無 gpt-4o 權限,可改用其他 OpenAI LLM
    temperature=0.3,
    openai_api_key=OPENAI_API_KEY,
)


# --- 工具函式 ---
def generate_prompt(
    use_case: str, goals: list[str], previous_code: str = "", feedback: str = ""
) -> str:
    print("📝 正在組裝程式碼生成的提示詞...")
    base_prompt = f"""
你是一個 AI 程式設計代理。你的工作是根據以下使用案例撰寫 Python 程式碼:

使用案例:{use_case}

你的目標是:
{chr(10).join(f"- {g.strip()}" for g in goals)}
"""
    if previous_code:
        print("🔄 加入先前的程式碼以供精煉。")
        base_prompt += f"\n先前產生的程式碼:\n{previous_code}"
    if feedback:
        print("📋 納入回饋以供修訂。")
        base_prompt += f"\n對前一版本的回饋:\n{feedback}\n"

    base_prompt += "\n請只回傳修訂後的 Python 程式碼。不要在程式碼之外加入註解或說明。"
    return base_prompt


def get_code_feedback(code: str, goals: list[str]) -> str:
    print("🔍 正在對照目標評估程式碼...")
    feedback_prompt = f"""
你是一位 Python 程式碼審查員。下方顯示一段程式碼片段。
根據以下目標:
{chr(10).join(f"- {g.strip()}" for g in goals)}

請評論這段程式碼,並指出這些目標是否已達成。
說明是否需要在清晰度、簡潔性、正確性、邊界情況處理或測試覆蓋率方面加以改進。

程式碼:
{code}
"""
    return llm.invoke(feedback_prompt)


def goals_met(feedback_text: str, goals: list[str]) -> bool:
    """
    依據回饋文字,使用 LLM 評估目標是否已達成。
    回傳 True 或 False(自 LLM 輸出解析而來)。
    """
    review_prompt = f"""
你是一位 AI 審查員。

以下是目標:
{chr(10).join(f"- {g.strip()}" for g in goals)}

以下是針對程式碼的回饋:
\"\"\"
{feedback_text}
\"\"\"

根據上述回饋,這些目標是否已達成?
只用一個詞回答:True 或 False。
"""
    response = llm.invoke(review_prompt).content.strip().lower()
    return response == "true"


def clean_code_block(code: str) -> str:
    lines = code.strip().splitlines()
    if lines and lines[0].strip().startswith("```"):
        lines = lines[1:]
    if lines and lines[-1].strip() == "```":
        lines = lines[:-1]
    return "\n".join(lines).strip()


def add_comment_header(code: str, use_case: str) -> str:
    comment = f"# 本 Python 程式實作以下使用案例:\n# {use_case.strip()}\n"
    return comment + "\n" + code


def to_snake_case(text: str) -> str:
    text = re.sub(r"[^a-zA-Z0-9 ]", "", text)
    return re.sub(r"\s+", "_", text.strip().lower())


def save_code_to_file(code: str, use_case: str) -> str:
    print("💾 正在儲存最終程式碼到檔案...")
    # 請 LLM 把使用案例摘要成適合做 Python 檔名的短字串
    summary_prompt = (
        f"請把以下使用案例摘要成一個全小寫的單字或片語,"
        f"不超過 10 個字元,適合做為 Python 檔名:\n\n{use_case}"
    )
    raw_summary = llm.invoke(summary_prompt).content.strip()
    short_name = re.sub(r"[^a-zA-Z0-9_]", "", raw_summary.replace(" ", "_").lower())[:10]
    random_suffix = str(random.randint(1000, 9999))
    filename = f"{short_name}_{random_suffix}.py"
    filepath = Path.cwd() / filename
    with open(filepath, "w") as f:
        f.write(code)

    print(f"✅ 程式碼已儲存至:{filepath}")
    return str(filepath)


# --- 主代理函式 ---
def run_code_agent(use_case: str, goals_input: str, max_iterations: int = 5) -> str:
    goals = [g.strip() for g in goals_input.split(",")]

    print(f"\n🎯 使用案例:{use_case}")
    print("🎯 目標:")
    for g in goals:
        print(f" - {g}")

    previous_code = ""
    feedback = ""

    for i in range(max_iterations):
        print(f"\n=== 🔁 第 {i + 1} 次 / 共 {max_iterations} 次迭代 ===")
        prompt = generate_prompt(
            use_case, goals, previous_code,
            feedback if isinstance(feedback, str) else feedback.content
        )

        print("🚧 正在生成程式碼...")
        code_response = llm.invoke(prompt)
        raw_code = code_response.content.strip()
        code = clean_code_block(raw_code)
        print("\n🧾 生成的程式碼:\n" + "-" * 50 + f"\n{code}\n" + "-" * 50)

        print("\n📤 提交程式碼進行回饋審查...")
        feedback = get_code_feedback(code, goals)
        feedback_text = feedback.content.strip()
        print("\n📥 收到回饋:\n" + "-" * 50 + f"\n{feedback_text}\n" + "-" * 50)

        if goals_met(feedback_text, goals):
            print("✅ LLM 確認目標已達成,停止迭代。")
            break

        print("🛠️ 目標尚未完全達成,準備下一次迭代...")
        previous_code = code

    final_code = add_comment_header(code, use_case)
    return save_code_to_file(final_code, use_case)


# --- CLI 測試執行 ---
if __name__ == "__main__":
    print("\n🧠 歡迎使用 AI 程式碼生成代理")

    # 範例 1
    use_case_input = "Write code to find BinaryGap of a given positive integer"
    goals_input = "Code simple to understand, Functionally correct, Handles comprehensive edge cases, Takes positive integer input only, prints the results with few examples"
    run_code_agent(use_case_input, goals_input)

    # 範例 2
    # use_case_input = "Write code to count the number of files in current directory and all its nested sub directories, and print the total count"
    # goals_input = (
    #     "Code simple to understand, Functionally correct, Handles comprehensive edge cases, Ignore recommendations for performance, Ignore recommendations for test suite use like unittest or pytest"
    # )
    # run_code_agent(use_case_input, goals_input)

    # 範例 3
    # use_case_input = "Write code which takes a command line input of a word doc or docx file and opens it and counts the number of words, and characters in it and prints all"
    # goals_input = "Code simple to understand, Functionally correct, Handles edge cases"
    # run_code_agent(use_case_input, goals_input)
```

除了說明書,你還會提供一份嚴格的品質檢查清單(quality checklist),代表最終程式碼必須滿足的目標——例如「必須簡單」「功能正確」「能處理意料之外的邊界情況」等。

![圖 1:目標設定與監控範例](assets/11-goal-setting-and-monitoring/fig-1-goal-setting-and-monitor-example.png)

*圖 1:目標設定與監控範例*

這位 AI 程式設計師會先產出第一版草稿,但不立即提交,而是執行嚴謹的自我審查(self-review):對照清單上每個項目,扮演自己的品質保證(QA)檢查員,並做出簡單裁決——全部符合就回答「True」,有所不足就回答「False」。

若裁決為「False」,它會進入修訂階段,依自我批判找出弱點並重寫程式碼。這個「起草、自我審查、精煉」的循環持續進行,直到達成「True」,或觸及預先定義的嘗試次數上限。一旦通過最終檢查,腳本便把解決方案加上註解,存成乾淨、可用的 Python 檔案。

**注意事項與考量:** 這是示範性說明,而非可用於正式生產環境(production-ready)的程式碼。真實應用須留意:LLM 可能誤解目標意涵、錯誤地把表現評為成功,即使理解目標也仍可能產生幻覺(hallucinate);當同一個 LLM 同時撰寫程式碼又評判品質時,更難察覺自己走錯方向。歸根究柢,你仍須實際執行並測試產出的程式碼。此外,本範例的「監控」相當基礎,且帶有「可能永遠跑下去」的潛在風險。

```text
Act as an expert code reviewer with a deep commitment to producing
clean, correct, and simple code. Your core mission is to eliminate
code "hallucinations" by ensuring every suggestion is grounded in
reality and best practices.

When I provide you with a code snippet, I want you to:
-- Identify and Correct Errors: Point out any logical flaws, bugs, or
potential runtime errors.
-- Simplify and Refactor: Suggest changes that make the code more
readable, efficient, and maintainable without sacrificing
correctness.
-- Provide Clear Explanations: For every suggested change, explain
why it is an improvement, referencing principles of clean code,
performance, or security.
-- Offer Corrected Code: Show the "before" and "after" of your
suggested changes so the improvement is clear.

Your feedback should be direct, constructive, and always aimed at
improving the quality of the code.
```

**提示詞中譯:**

> 請以一位資深程式碼審查員的身分行事,並深切致力於產出乾淨、正確且簡單的程式碼。你的核心使命,是藉由確保每一項建議都立基於現實與最佳實務,來消除程式碼的「幻覺(hallucinations)」。
>
> 當我提供一段程式碼片段給你時,我希望你:
> -- 找出並修正錯誤:指出任何邏輯瑕疵、臭蟲(bug)或潛在的執行期錯誤。
> -- 簡化與重構:在不犧牲正確性的前提下,提出能讓程式碼更易讀、更有效率、更易維護的修改。
> -- 提供清楚的說明:對每一項建議的修改,說明它為何是改進,並援引乾淨程式碼、效能或安全性的原則。
> -- 提供修正後的程式碼:展示「修改前」與「修改後」,讓改進之處一目瞭然。
>
> 你的回饋應當直接、有建設性,並始終以提升程式碼品質為目標。

更穩健的做法,是賦予一組(crew)代理各自特定角色,把不同職責分離開來。例如以 Gemini 建立的 AI 代理團隊,每個角色各司其職:

- **同儕程式設計師(The Peer Programmer):** 協助撰寫程式碼與腦力激盪。
- **程式碼審查員(The Code Reviewer):** 抓出錯誤並提出改進建議。
- **文件撰寫者(The Documenter):** 生成清晰精簡的文件。
- **測試撰寫者(The Test Writer):** 建立全面的單元測試。
- **提示精煉者(The Prompt Refiner):** 最佳化與 AI 的互動。

在這個多代理系統中,程式碼審查員是獨立於程式設計師的另一實體,使客觀評估品質大幅提升;測試撰寫者也能自然滿足「為產出程式碼撰寫單元測試」的需求。把這些更精密控制機制、讓程式碼更接近正式生產環境的工作,留給有興趣的讀者完成。

## 重點速覽

**是什麼(What):** AI 代理往往缺乏明確方向,無法在簡單反應式任務之外帶著目的性行動。沒有既定目標,它們無法獨立處理複雜的多步驟問題、協調精密工作流程,也沒有內建機制判斷自身行動是否導向成功結果。這限制了它們的自主性,使其難以在「單純執行任務並不足夠」的動態真實情境中發揮效用。

**為什麼(Why):** 此模式提供標準化解法,把目的感與自我評估能力嵌入代理:明確定義清楚、可衡量的目標,並建立持續對照目標追蹤進度與環境狀態的監控機制。這形成關鍵的回饋迴路(feedback loop),讓代理得以評估表現、修正方向、在偏離成功路徑時調整計畫,從而把反應式代理轉變為自主、可靠、以目標為導向的主動式系統。

**經驗法則(Rule of thumb):** 當 AI 代理必須自主執行多步驟任務、適應動態條件,並在沒有持續人工介入下可靠達成某個高層次目標時,使用此模式。

## 視覺摘要

![圖 2:目標設計模式](assets/11-goal-setting-and-monitoring/fig-2-goal-design-patterns.png)

*圖 2:目標設計模式*

## 重點整理

- 目標設定與監控為代理配備目的感,以及追蹤進度的機制。
- 目標應符合 SMART:具體(Specific)、可衡量(Measurable)、可達成(Achievable)、相關(Relevant)、有時限(Time-bound)。
- 清楚定義指標與成功標準,對有效監控至關重要。
- 監控涉及觀察代理的行動、環境狀態與工具輸出。
- 監控所產生的回饋迴路,讓代理得以適應、修訂計畫或把問題升級處理。
- 在 Google 的 ADK 中,目標通常透過代理指令(agent instructions)傳達,監控則藉由狀態管理(state management)與工具互動達成。

## 結論

目標設定與監控把 AI 代理從反應式系統轉變為主動、目標驅動的實體。其關鍵在於定義清楚、可衡量的目標,並建立嚴謹的監控程序追蹤進度。如各領域應用所示,這項範式支撐起可靠的自主運作;概念性程式碼範例則展示如何在結構化框架中運用代理指令與狀態管理,引導並評估代理對目標的達成。賦予代理制定並監督目標的能力,是邁向真正智慧且可究責(accountable)AI 系統的根本一步。

## 參考資料

1. SMART Goals Framework:
   <https://en.wikipedia.org/wiki/SMART_criteria>
