# 第 11 章:目標設定與監控(Goal Setting and Monitoring)

AI 代理(AI agent)要有效且具目的性,光會處理資訊或用工具還不夠,還需要清楚的方向感與判斷自己是否有進展的方法。這正是目標設定與監控模式的核心:賦予代理具體目標,並配備追蹤進度、判定達成與否的手段。

## 目標設定與監控模式總覽

如同規劃旅行:先定目的地(目標狀態)、確認出發點(初始狀態)、考量選項(交通、路線、預算),再排出顧及相依與限制的步驟。這種逐步推進,就是代理系統中的「規劃(planning)」。

代理通常接收一個高層次目標,自主或半自主地拆解成一系列子目標(sub-goal),再循序或以更複雜的流程執行,過程中可搭配工具使用、路由或多代理協作。規劃機制可運用搜尋演算法、邏輯推理,或愈來愈常見地由 LLM 生成計畫。

良好的規劃讓代理能處理多步驟請求,並透過重新規劃(replanning)適應變化,把反應式(reactive)系統轉為主動朝目標努力的系統。

## 實務應用與使用案例

此模式對在複雜真實情境中自主、可靠運作的代理至關重要:

- **客戶支援自動化:** 目標如「解決客戶帳單疑問」。代理監控對話、查核資料庫、用工具調整帳單;以「帳單已變更且獲正面回饋」判定成功,未解則升級(escalate)。
- **個人化學習系統:** 目標如「提升學生對代數的理解」。追蹤練習進度、準確率與完成時間,在學生卡關時調整教材與教法。
- **專案管理助理:** 目標如「確保里程碑 X 在 Y 日期前完成」。監控任務狀態、團隊溝通與資源,標示延遲並建議修正。
- **自動化交易機器人:** 目標如「在風險承受度內最大化收益」。持續監控市場資料、投資組合價值與風險指標,符合條件時交易,風險破門檻時調整策略。
- **機器人與自駕車:** 目標如「安全把乘客從 A 運送到 B」。持續監控環境、自身狀態與行進進度,並調整駕駛行為。
- **內容審核:** 目標如「辨識並移除有害內容」。監控傳入內容、套用分類模型、追蹤誤判(false positives/negatives),調整過濾標準或把模稜兩可案例升級給人工。

此模式為智慧化的自我管理提供框架,使代理能可靠達成成果並適應動態條件。

## 動手實作範例

以下用 LangChain 與 OpenAI API 示範。這支 Python 腳本是一個自主 AI 代理,生成並精煉 Python 程式碼,同時確保符合使用者定義的品質基準。它採「創作、自我評估、改善」的迭代循環:由代理以 AI 判斷衡量產出是否滿足目標,最終輸出一個附註解、可立即使用的 Python 檔案。

相依套件:

```bash
pip install langchain_openai openai python-dotenv
```

附帶金鑰 `OPENAI_API_KEY` 的 `.env` 檔案。

可把這支腳本想像成一位被指派專案的自主 AI 程式設計師(見圖 1):你交給它一份詳細的專案說明書,也就是要解決的具體程式設計問題。

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

除了說明書,你還會給一份嚴格的品質檢查清單(quality checklist),代表最終程式碼必須滿足的目標——例如「必須簡單」「功能正確」「能處理邊界情況」。

![圖 1:目標設定與監控範例](assets/11-goal-setting-and-monitoring/fig-1-goal-setting-and-monitor-example.png)

*圖 1:目標設定與監控範例*

這位 AI 程式設計師先產出草稿,但不立即提交,而是對照清單逐項做自我審查(self-review),扮演自己的 QA 檢查員並裁決:全部符合回答「True」,否則「False」。若為「False」,便進入修訂階段重寫程式碼。此「起草、自我審查、精煉」的循環持續到「True」或觸及次數上限,通過後即把程式碼加上註解存成檔案。

**注意事項與考量:** 這是示範,而非可用於正式生產環境(production-ready)的程式碼。真實應用須留意:LLM 可能誤解目標、把表現錯評為成功,即使理解目標仍可能產生幻覺(hallucinate);當同一個 LLM 既寫程式又評判品質時,更難察覺自己走錯方向。你仍須實際執行並測試產出。此外,本範例的「監控」相當基礎,且有「可能永遠跑下去」的風險。

```text
請以一位資深程式碼審查員的身分行事,並深切致力於產出乾淨、正確且簡單的程式碼。你的核心使命,是藉由確保每一項建議都立基於現實與最佳實務,來消除程式碼的「幻覺(hallucinations)」。

當我提供一段程式碼片段給你時,我希望你:
-- 找出並修正錯誤:指出任何邏輯瑕疵、臭蟲(bug)或潛在的執行期錯誤。
-- 簡化與重構:在不犧牲正確性的前提下,提出能讓程式碼更易讀、更有效率、更易維護的修改。
-- 提供清楚的說明:對每一項建議的修改,說明它為何是改進,並援引乾淨程式碼、效能或安全性的原則。
-- 提供修正後的程式碼:展示「修改前」與「修改後」,讓改進之處一目瞭然。

你的回饋應當直接、有建設性,並始終以提升程式碼品質為目標。
```

更穩健的做法,是用一組(crew)代理各司其職,把職責分離。例如以 Gemini 建立的團隊:

- **同儕程式設計師(The Peer Programmer):** 協助撰寫程式碼與腦力激盪。
- **程式碼審查員(The Code Reviewer):** 抓出錯誤並提出改進建議。
- **文件撰寫者(The Documenter):** 生成清晰精簡的文件。
- **測試撰寫者(The Test Writer):** 建立全面的單元測試。
- **提示精煉者(The Prompt Refiner):** 最佳化與 AI 的互動。

由於審查員獨立於程式設計師,客觀評估品質大幅提升;測試撰寫者也自然滿足「為產出程式碼寫單元測試」的需求。更精密的控制機制留給有興趣的讀者完成。

## 重點速覽

**是什麼(What):** AI 代理往往缺乏明確方向,無法在簡單反應式任務之外帶著目的性行動。沒有既定目標,它們無法獨立處理複雜的多步驟問題、協調精密工作流程,也沒有機制判斷自身行動是否導向成功,因而難以在動態真實情境中發揮效用。

**為什麼(Why):** 此模式把目的感與自我評估嵌入代理:明確定義清楚、可衡量的目標,並建立持續對照目標追蹤進度與環境狀態的監控機制。這形成關鍵的回饋迴路(feedback loop),讓代理評估表現、修正方向、偏離時調整計畫,把反應式代理轉為自主、可靠、以目標為導向的主動式系統。

**經驗法則(Rule of thumb):** 當 AI 代理必須自主執行多步驟任務、適應動態條件,並在無持續人工介入下可靠達成某個高層次目標時使用。

## 視覺摘要

![圖 2:目標設計模式](assets/11-goal-setting-and-monitoring/fig-2-goal-design-patterns.png)

*圖 2:目標設計模式*

## 重點整理

- 目標設定與監控為代理配備目的感與追蹤進度的機制。
- 目標應符合 SMART:具體(Specific)、可衡量(Measurable)、可達成(Achievable)、相關(Relevant)、有時限(Time-bound)。
- 清楚定義指標與成功標準,是有效監控的關鍵。
- 監控涉及觀察代理的行動、環境狀態與工具輸出。
- 監控所產生的回饋迴路,讓代理得以適應、修訂計畫或升級處理。
- 在 Google 的 ADK 中,目標透過代理指令(agent instructions)傳達,監控藉由狀態管理(state management)與工具互動達成。

## 結論

目標設定與監控把 AI 代理從反應式系統轉為主動、目標驅動的實體,關鍵在於定義清楚、可衡量的目標,並建立嚴謹的監控程序追蹤進度。程式碼範例展示如何運用代理指令與狀態管理,引導並評估代理對目標的達成。賦予代理制定並監督目標的能力,是邁向真正智慧且可究責(accountable)AI 系統的根本一步。

## 參考資料

1. SMART Goals Framework:
   <https://en.wikipedia.org/wiki/SMART_criteria>
