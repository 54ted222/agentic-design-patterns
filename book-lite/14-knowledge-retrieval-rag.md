# 第 14 章:知識檢索(Knowledge Retrieval, RAG)

LLM 擅長生成擬人化文字,但知識侷限於訓練資料,難以取得即時資訊、特定公司資料或高度專業細節。知識檢索(RAG,檢索增強生成)正是為此而生:讓 LLM 存取並整合外部、最新、具情境特定性的資訊,提升輸出的準確度、相關性與事實依據。

對 AI 代理而言這至關重要,因為它讓代理的行動與回應奠基於即時、可驗證的資料,而非靜態訓練內容。代理因此能準確執行複雜任務,例如查最新公司政策回答問題,或在下單前確認庫存。RAG 把代理從單純的對話者,轉變為資料驅動的高效工具。

## 知識檢索(RAG)模式總覽

RAG 在 LLM 生成回應前,先讓它存取外部知識庫,如同人類翻書或上網搜尋。當使用者提問時,查詢不會直接送往 LLM,而是先在外部知識庫(文件、資料庫或網頁的集合)中搜尋。這並非關鍵字比對,而是「語意搜尋」,能理解使用者意圖與文字背後的意義。搜尋會擷取最切題的片段(「區塊,chunks」),將其「增強(augmented)」進原始提示,構成資訊更充分的查詢,再送往 LLM。有了這份情境,LLM 便能生成流暢且事實上奠基於檢索資料的回應。

RAG 的好處:存取最新資訊以克服靜態訓練資料的限制;把回應奠基於可驗證資料,降低「幻覺」風險;運用內部文件或維基中的專業知識;提供「引用(citations)」精準指出來源,提升可信度與可驗證性。

要理解 RAG,須掌握幾個核心概念(見圖 1):

**嵌入(Embeddings):** 文字(單字、片語或文件)的數值表示,採向量(一串數字)形式,在數學空間中捕捉文字間的語意與關係。意義相近的文字,其嵌入也彼此靠近。例如在 2D 圖上,「cat」可能位於 (2, 3),「kitten」非常靠近於 (2.1, 3.1),而「car」則距離較遠如 (8, 1)。實務上嵌入存在於數百甚至數千維的空間,使系統得以細膩理解語言。

**文字相似度(Text Similarity):** 衡量兩段文字有多相似,可以是表面的字詞重疊(詞彙相似度),也可以是以意義為基礎的深層相似度。在 RAG 中,它對於找出與查詢最相關的資訊至關重要。例如「What is the capital of France?」與「Which city is the capital of France?」措辭不同卻問同一件事,好的模型會給予高相似度分數。這通常透過嵌入來計算。

**語意相似度與距離(Semantic Similarity and Distance):** 語意相似度純粹聚焦於意義與情境,而非所用字詞;語意距離則是其反面(高相似度=低距離)。RAG 的語意搜尋仰賴找出與查詢語意距離最小的文件。例如「a furry feline companion」與「a domestic cat」幾乎沒有共同字詞,但模型會辨識它們指涉同一事物、嵌入彼此靠近。這正是讓 RAG 即使在措辭不符時仍能找到相關資訊的「智慧搜尋」。

![圖 1:RAG 核心概念:區塊化(Chunking)、嵌入(Embeddings)與向量資料庫(Vector Database)。](assets/14-knowledge-retrieval-rag/fig-1-rag-core-concepts.png)

*圖 1:RAG 核心概念:區塊化(Chunking)、嵌入(Embeddings)與向量資料庫(Vector Database)。*

**文件的區塊化(Chunking of Documents):** 把大型文件拆解成較小、易管理的片段(區塊)的過程。RAG 不會把整份龐大文件餵給 LLM,而是處理這些區塊;切分方式對保留情境與意義很重要。例如一份 50 頁手冊可拆成章節或段落,「疑難排解」與「安裝指南」各成獨立區塊。使用者提問時,系統只檢索最相關區塊而非整份手冊,讓檢索更快、資訊更聚焦。

區塊化後,系統須以某種檢索技術找出最相關片段。主要方法是**向量搜尋**,運用嵌入與語意距離找出概念相似的區塊;另一種較老但仍有價值的是 **BM25**,以關鍵字詞頻排序、不理解語意。**混合搜尋(hybrid search)**結合 BM25 的關鍵字精準度與語意搜尋的情境理解,兼顧字面吻合與概念相關,使檢索更穩健準確。

**向量資料庫(Vector databases):** 專為高效儲存與查詢嵌入而設計。傳統關鍵字搜尋擅長找出含確切字詞的文件,卻無法辨識「furry feline companion」其實就是「cat」;向量資料庫則專為語意搜尋打造,以數值向量按概念意義尋找結果。查詢同樣轉為向量後,資料庫以 HNSW(階層式可導航小世界圖)等最佳化演算法,在數百萬向量中快速找出意義「最接近」者。即使措辭與來源文件完全不同,仍能發掘相關情境——當其他技術搜尋字詞時,向量資料庫搜尋的是意義。實作形式眾多:受管理的 Pinecone、Weaviate;開源的 Chroma DB、Milvus、Qdrant;以及為既有資料庫增添向量能力的 Redis、Elasticsearch、Postgres(pgvector)。其核心檢索機制常由 Meta AI 的 FAISS 或 Google Research 的 ScaNN 等函式庫驅動。

**RAG 的挑戰:** 一個主要問題是回答所需資訊散佈在多處(同一文件多段或多份文件),檢索器可能蒐集不全,導致答案不完整或不準確。成效高度仰賴區塊化與檢索品質;檢索到不相關區塊會引入雜訊、混淆 LLM。綜整可能相互矛盾的來源仍是難關。此外,RAG 要求整個知識庫預先處理並存入向量(或圖)資料庫,工程量可觀,且須定期校準調和以保持最新(對公司維基這類演變來源尤其重要)。整個過程也會增加延遲、營運成本與最終提示的 token 數。

小結:RAG 透過把外部知識檢索無縫整合進生成過程,解決了獨立 LLM 的核心侷限。嵌入與語意相似度等基礎概念,結合關鍵字、混合搜尋等技術與策略性區塊化,讓系統智慧找出相關資訊,並由專門的向量資料庫大規模驅動。儘管在零碎或矛盾資訊上仍有挑戰,RAG 賦予 LLM 生成情境恰當且奠基於可驗證事實的能力,提升了信任與實用性。

**Graph RAG:** GraphRAG 運用知識圖譜(而非單純向量資料庫)進行檢索,透過沿著實體(節點)間的明確關係(邊)導航來回答複雜查詢。其關鍵優勢是能從散佈於多份文件的零碎資訊綜整出答案——這正是傳統 RAG 常見的失敗之處——因而提供更準確、細膩的回應。

使用案例包括複雜金融分析、連結公司與市場事件、發掘基因與疾病的關係等。主要缺點是建立並維護高品質知識圖譜的複雜度、成本與專業能力都相當可觀;架構也較缺乏彈性、可能引入更高延遲,且成效完全取決於底層圖譜的品質與完整性。總之,當深入、相互連結的洞察比速度與簡潔更關鍵時,GraphRAG 便能大放異彩,但代價是高出許多的實作與維護成本。

**Agentic RAG:** 這是 RAG 的演進形式(見圖 2),引入推理與決策層以提升擷取可靠性。它讓一個「代理」扮演把關者與知識精煉者:不被動接受檢索結果,而是主動審視其品質、相關性與完整性,如下列情境所示。

第一,**反思與來源驗證**。若問「公司對遠距工作的政策是什麼?」標準 RAG 可能把 2020 年的部落格文章與 2025 年官方政策一起拉出,代理則會分析中繼資料,辨識 2025 年政策才是最權威來源,捨棄過時文章後才送往 LLM。

![圖 2:Agentic RAG 引入了一個推理代理,它會主動地評估、調和並精煉所檢索到的資訊,以確保最終回應更準確、更值得信賴。](assets/14-knowledge-retrieval-rag/fig-2-agentic-rag.png)

*圖 2:Agentic RAG 引入了一個推理代理,它會主動地評估、調和並精煉所檢索到的資訊,以確保最終回應更準確、更值得信賴。*

第二,**調和知識衝突**。若財務分析師問「Project Alpha 第一季預算是多少?」系統檢索到初始提案(€50,000)與定案財報(€65,000),代理會辨識矛盾、優先採用較可靠的財報,並把驗證過的數字提供給 LLM。

第三,**多步推理綜整答案**。若問「我們產品的功能與定價跟競爭對手 X 相比如何?」代理會拆成多個子查詢(自家功能、自家定價、對手功能、對手定價),分別搜尋後綜整成結構化的比較情境,再餵給 LLM,促成簡單檢索無法產生的全面回應。

第四,**辨識知識缺口並運用外部工具**。若問「昨天推出的新產品市場即時反應如何?」代理搜尋每週更新的內部知識庫卻找不到,察覺缺口後便啟動工具(如即時網頁搜尋 API)尋找近期新聞與輿論,提供最新答案,克服靜態內部資料庫的侷限。

**Agentic RAG 的挑戰:** 代理層也帶來複雜度與成本的顯著增加;設計、實作並維護決策邏輯與工具整合需可觀工程投入,並增加運算開銷。反思、工具使用與多步推理的循環也會增加延遲。此外,代理本身可能成為新錯誤來源:有瑕疵的推理可能陷入無用迴圈、誤解任務,或不當捨棄相關資訊,反而降低回應品質。

小結:Agentic RAG 把 RAG 從被動資料管線轉為主動的問題解決框架,透過能評估來源、調和衝突、分解問題並運用工具的推理層,大幅提升答案的可靠性與深度——但須謹慎管理其在複雜度、延遲與成本上的權衡。

## 實務應用與使用案例

RAG 正在改變各行各業運用 LLM 的方式,強化其提供準確、切合情境之回應的能力。應用範圍包括:

- **企業搜尋與問答:** 運用 HR 政策、技術手冊、產品規格等內部文件建立內部聊天機器人,擷取相關段落輔助 LLM 回應員工詢問。
- **客戶支援與服務台:** 存取產品手冊、FAQ 與支援工單,為客戶查詢提供精準一致的回應,減少例行問題對人工介入的需求。
- **個人化內容推薦:** 超越關鍵字比對,檢索在語意上與使用者偏好或互動相關的內容,帶來更切合的推薦。
- **新聞與時事摘要:** 與即時新聞動態整合,被問及當前事件時檢索近期文章,讓 LLM 產出最新摘要。

透過納入外部知識,RAG 把 LLM 從單純溝通延伸為能作為知識處理系統運作。

## 動手實作範例(ADK)

以下三個範例示範 RAG 模式。

第一個範例運用 Google 搜尋進行 RAG,把 LLM 奠基於搜尋結果之上。Google Search 工具正是內建檢索機制的直接範例。

```python
from google.adk.tools import google_search
from google.adk.agents import Agent

search_agent = Agent(
    name="research_assistant",
    model="gemini-2.0-flash-exp",
    instruction="你協助使用者研究各種主題。當被要求時,請使用 Google 搜尋工具。",
    tools=[google_search]
)
```

第二個範例說明如何在 ADK 中運用 Vertex AI 的 RAG 能力。程式碼示範如何初始化 `VertexAiRagMemoryService`,建立通往 Vertex AI RAG Corpus(語料庫)的連線。透過語料庫資源名稱與選用參數設定:`SIMILARITY_TOP_K` 定義要檢索的前幾筆最相似結果數量;`VECTOR_DISTANCE_THRESHOLD` 為檢索結果的語意距離設定上限。這讓代理能從指定 Corpus 執行可擴展、持久的語意檢索,支援奠基於事實資料的回應。

```python
# 匯入 VertexAiRagMemoryService 類別
from google.adk.memory import VertexAiRagMemoryService

RAG_CORPUS_RESOURCE_NAME = "projects/your-gcp-project-id/locations/us-central1/ragCorpora/your-corpus-id"

# 選用參數:要檢索的前幾筆最相似結果數量(控制回傳多少相關區塊)
SIMILARITY_TOP_K = 5

# 選用參數:向量距離門檻值(決定允許的最大語意距離,超過者可能被過濾)
VECTOR_DISTANCE_THRESHOLD = 0.7

# 初始化 VertexAiRagMemoryService 實例,建立通往 Vertex AI RAG Corpus 的連線
# - rag_corpus:RAG Corpus 的唯一識別碼
# - similarity_top_k:擷取的最相似結果數量上限
# - vector_distance_threshold:用於過濾結果的相似度門檻
memory_service = VertexAiRagMemoryService(
    rag_corpus=RAG_CORPUS_RESOURCE_NAME,
    similarity_top_k=SIMILARITY_TOP_K,
    vector_distance_threshold=VECTOR_DISTANCE_THRESHOLD
)
```

## 動手實作範例(LangChain)

第三個範例透過一個使用 LangChain 的完整範例逐步走過整個流程。

```python
import os
import requests
from typing import List, Dict, Any, TypedDict
from langchain_community.document_loaders import TextLoader
from langchain_core.documents import Document
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser
from langchain_community.embeddings import OpenAIEmbeddings
from langchain_community.vectorstores import Weaviate
from langchain_openai import ChatOpenAI
from langchain.text_splitter import CharacterTextSplitter
from langchain.schema.runnable import RunnablePassthrough
from langgraph.graph import StateGraph, END
import weaviate
from weaviate.embedded import EmbeddedOptions
import dotenv

# 載入環境變數(例如 OPENAI_API_KEY)
dotenv.load_dotenv()

# 設定 OpenAI API key(請確認從 .env 載入,或在此處設定)
# os.environ["OPENAI_API_KEY"] = "YOUR_OPENAI_API_KEY"

# --- 1. 資料準備(前處理)---
# 載入資料
url = "https://github.com/langchain-ai/langchain/blob/master/docs/docs/how_to/state_of_the_union.txt"
res = requests.get(url)
with open("state_of_the_union.txt", "w") as f:
    f.write(res.text)

loader = TextLoader('./state_of_the_union.txt')
documents = loader.load()

# 把文件切分成區塊
text_splitter = CharacterTextSplitter(chunk_size=500, chunk_overlap=50)
chunks = text_splitter.split_documents(documents)

# 把區塊嵌入並儲存到 Weaviate
client = weaviate.Client(
    embedded_options = EmbeddedOptions()
)
vectorstore = Weaviate.from_documents(
    client = client,
    documents = chunks,
    embedding = OpenAIEmbeddings(),
    by_text = False
)

# 定義檢索器(retriever)
retriever = vectorstore.as_retriever()

# 初始化 LLM
llm = ChatOpenAI(model_name="gpt-3.5-turbo", temperature=0)

# --- 2. 為 LangGraph 定義狀態(State)---
class RAGGraphState(TypedDict):
    question: str
    documents: List[Document]
    generation: str

# --- 3. 定義節點(函式)---
def retrieve_documents_node(state: RAGGraphState) -> RAGGraphState:
    """根據使用者的問題檢索文件。"""
    question = state["question"]
    documents = retriever.invoke(question)
    return {"documents": documents, "question": question, "generation": ""}

def generate_response_node(state: RAGGraphState) -> RAGGraphState:
    """根據檢索到的文件,使用 LLM 生成回應。"""
    question = state["question"]
    documents = state["documents"]

    # 提示範本
    template = """你是一個負責問答任務的助理。
請使用以下檢索到的情境片段來回答問題。
如果你不知道答案,就直接說你不知道。
最多使用三句話,並讓答案保持簡潔。
問題:{question}
情境:{context}
答案:
"""
    prompt = ChatPromptTemplate.from_template(template)

    # 把文件格式化成情境
    context = "\n\n".join([doc.page_content for doc in documents])

    # 建立 RAG 鏈
    rag_chain = prompt | llm | StrOutputParser()

    # 呼叫此鏈
    generation = rag_chain.invoke({"context": context, "question": question})
    return {"question": question, "documents": documents, "generation": generation}

# --- 4. 建構 LangGraph 圖 ---
workflow = StateGraph(RAGGraphState)

# 加入節點
workflow.add_node("retrieve", retrieve_documents_node)
workflow.add_node("generate", generate_response_node)

# 設定進入點
workflow.set_entry_point("retrieve")

# 加入邊(轉換)
workflow.add_edge("retrieve", "generate")
workflow.add_edge("generate", END)

# 編譯此圖
app = workflow.compile()

# --- 5. 執行 RAG 應用程式 ---
if __name__ == "__main__":
    print("\n--- Running RAG Query ---")
    query = "總統對 Breyer 大法官說了什麼"
    inputs = {"question": query}
    for s in app.stream(inputs):
        print(s)

    print("\n--- Running another RAG Query ---")
    query_2 = "總統對經濟說了什麼?"
    inputs_2 = {"question": query_2}
    for s in app.stream(inputs_2):
        print(s)
```

這段程式碼示範以 LangChain 與 LangGraph 實作的 RAG 管線。先從一份文字文件建立知識庫,切分成區塊並轉成嵌入,儲存到 Weaviate 向量儲存庫。LangGraph 的 `StateGraph` 管理兩個關鍵函式的工作流程:`retrieve_documents_node` 查詢向量儲存庫、辨識相關區塊;`generate_response_node` 運用檢索結果與提示範本,透過 OpenAI LLM 產生回應。`app.stream` 讓查詢在管線中執行,展示系統生成切合情境輸出的能力。

## 重點速覽

**是什麼(What):** LLM 文字生成能力出色,但受限於靜態的訓練資料,不含即時資訊或私有、特定領域的資料。因此回應可能過時、不準確或欠缺專業任務所需情境,限制了它們在需要即時事實性答案之應用上的可靠度。

**為什麼(Why):** RAG 透過把 LLM 連接到外部知識來源提供標準化解法。收到查詢時,系統先從知識庫檢索相關片段,附加到原始提示以即時、特定的情境加以豐富,再送往 LLM 生成準確、可驗證且奠基於外部資料的回應。這把 LLM 從閉卷(closed-book)推理者轉變為開卷(open-book)推理者,大幅提升實用性與可信度。

**經驗法則(Rule of thumb):** 當你需要讓 LLM 根據特定、最新或專有(非原始訓練資料)的資訊回答問題或生成內容時使用。非常適合建構內部文件問答系統、客戶支援機器人,以及需要附帶引用、可驗證、以事實為基礎之回應的應用。

## 視覺摘要

![知識檢索模式:一個 AI 代理向結構化資料庫查詢並檢索資訊。](assets/14-knowledge-retrieval-rag/visual-summary-structured-database.png)

*知識檢索模式:一個 AI 代理向結構化資料庫查詢並檢索資訊。*

![圖 3:知識檢索模式:一個 AI 代理回應使用者查詢,從公開網際網路中尋找並綜整資訊。](assets/14-knowledge-retrieval-rag/fig-3-web-search-retrieval.png)

*圖 3:知識檢索模式:一個 AI 代理回應使用者查詢,從公開網際網路中尋找並綜整資訊。*

## 重點整理

- 知識檢索(RAG)透過讓 LLM 存取外部、最新且特定的資訊來強化 LLM。
- 過程涉及檢索(在知識庫中搜尋相關片段)與增強(把片段加入 LLM 提示)。
- RAG 協助 LLM 克服訓練資料過時等侷限,降低「幻覺」,並使特定領域知識整合成為可能。
- RAG 讓答案得以被歸因,因為回應奠基於所檢索的來源。
- GraphRAG 運用知識圖譜理解資訊片段間的關係,能回答需綜整多來源資料的複雜問題。
- Agentic RAG 運用智慧代理主動對外部知識進行推理、驗證與精煉,確保答案更準確可靠。
- 實務應用橫跨企業搜尋、客戶支援、法律研究與個人化推薦等領域。

## 結論

RAG 透過把 LLM 連接到外部、最新的資料來源,解決了靜態知識這項核心侷限:先檢索相關片段,再增強使用者提示,讓 LLM 生成更準確、更具情境感知的回應。這仰賴嵌入、語意搜尋與向量資料庫等技術,根據意義而非僅僅關鍵字尋找資訊。透過把輸出奠基於可驗證資料,RAG 大幅減少事實性錯誤、使專有資訊運用成為可能,並透過引用提升信任度。

進階演進形式 Agentic RAG 引入推理層,主動驗證、調和並綜整檢索知識以達更高可靠性,能解決矛盾資訊、執行多步查詢並運用外部工具尋找缺失資料;GraphRAG 則運用知識圖譜導航明確的資料關係,針對高度複雜、相互連結的查詢綜整答案。這些方法雖增添複雜度與延遲,卻大幅提升回應的深度與可信度。其實務應用已在改變企業搜尋、客戶支援、個人化內容遞送等各行各業。儘管挑戰仍在,RAG 仍是讓 AI 更博學、可靠、實用的關鍵模式,把 LLM 從閉卷對話者轉變為強大的開卷推理工具。

## 參考資料

1. Lewis, P., et al. (2020). Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks. <https://arxiv.org/abs/2005.11401>
2. Google AI for Developers Documentation. Retrieval Augmented Generation. <https://cloud.google.com/vertex-ai/generative-ai/docs/rag-engine/rag-overview>
3. Retrieval-Augmented Generation with Graphs (GraphRAG). <https://arxiv.org/abs/2501.00309>
4. LangChain and LangGraph: Leonie Monigatti, "Retrieval-Augmented Generation (RAG): From Theory to LangChain Implementation." <https://medium.com/data-science/retrieval-augmented-generation-rag-from-theory-to-langchain-implementation-4e9bd5f6a4f2>
5. Google Cloud Vertex AI RAG Corpus. <https://cloud.google.com/vertex-ai/generative-ai/docs/rag-engine/manage-your-rag-corpus#corpus-management>
