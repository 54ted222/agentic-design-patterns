# 第 14 章:知識檢索(Knowledge Retrieval, RAG)

LLM 擅長生成文字,但知識侷限於訓練資料,難以取得即時、私有或高度專業的資訊。知識檢索(RAG,檢索增強生成)讓 LLM 存取外部、最新、具情境的資料,提升輸出的準確度與事實依據。

這對 AI 代理至關重要:它讓代理的行動奠基於即時、可驗證的資料,而非靜態訓練內容,因而能準確執行複雜任務(查最新政策回答問題、下單前確認庫存),從單純對話者轉為資料驅動的工具。

## 知識檢索(RAG)模式總覽

RAG 在生成前先讓 LLM 存取外部知識庫,如同人類翻書或上網。使用者提問時,查詢不直接送往 LLM,而是先在外部知識庫(文件、資料庫或網頁的集合)中以「語意搜尋」尋找——理解意圖而非比對關鍵字。搜尋擷取最切題的片段(「區塊,chunks」),將其「增強(augmented)」進原始提示後再送往 LLM,使回應流暢且奠基於檢索資料。

RAG 的好處:取得最新資訊以克服靜態訓練的限制;奠基於可驗證資料以降低「幻覺」;運用內部文件等專業知識;提供「引用(citations)」指出來源,提升可信度。

要理解 RAG,須掌握幾個核心概念(見圖 1):

**嵌入(Embeddings):** 文字的數值表示,以向量(一串數字)在數學空間中捕捉語意關係,意義相近者嵌入也相近。例如 2D 圖上「cat」在 (2, 3),「kitten」靠近於 (2.1, 3.1),「car」則遠在 (8, 1)。實務上嵌入存在於數百至數千維空間,得以細膩理解語言。

**文字相似度(Text Similarity):** 衡量兩段文字有多相似,可以是字詞重疊(詞彙相似度),也可以是意義層面的深層相似度。在 RAG 中,它是找出與查詢最相關資訊的關鍵。例如「What is the capital of France?」與「Which city is the capital of France?」措辭不同卻問同一件事,好的模型會給高分。這通常透過嵌入計算。

**語意相似度與距離(Semantic Similarity and Distance):** 語意相似度聚焦意義而非字詞,語意距離則為其反面(高相似度=低距離)。RAG 仰賴找出與查詢語意距離最小的文件。例如「a furry feline companion」與「a domestic cat」幾乎無共同字詞,模型卻能辨識兩者指涉同一事物、嵌入相近——這正是讓 RAG 在措辭不符時仍能命中的「智慧搜尋」。

![圖 1:RAG 核心概念:區塊化(Chunking)、嵌入(Embeddings)與向量資料庫(Vector Database)。](assets/14-knowledge-retrieval-rag/fig-1-rag-core-concepts.png)

*圖 1:RAG 核心概念:區塊化(Chunking)、嵌入(Embeddings)與向量資料庫(Vector Database)。*

**文件的區塊化(Chunking of Documents):** 把大型文件拆成較小、易管理的片段(區塊)。RAG 不把整份文件餵給 LLM,而是處理區塊;切分方式對保留情境很重要。例如 50 頁手冊可依章節拆分,「疑難排解」與「安裝指南」各成一塊。提問時系統只檢索最相關區塊,使檢索更快、更聚焦。

區塊化後須以某種技術找出最相關片段。主要是**向量搜尋**,以嵌入與語意距離找出概念相似的區塊;另有較老的 **BM25**,依關鍵字詞頻排序、不理解語意。**混合搜尋(hybrid search)**結合兩者,兼顧字面吻合與概念相關,更穩健準確。

**向量資料庫(Vector databases):** 專為高效儲存與查詢嵌入而設計。關鍵字搜尋擅長找含確切字詞的文件,卻無法辨識「furry feline companion」就是「cat」;向量資料庫則按概念意義尋找。查詢轉為向量後,以 HNSW(階層式可導航小世界圖)等演算法在數百萬向量中快速找出意義「最接近」者,即使措辭完全不同也能命中——別人搜字詞,它搜意義。實作眾多:受管理的 Pinecone、Weaviate;開源的 Chroma DB、Milvus、Qdrant;以及為既有資料庫增添向量能力的 Redis、Elasticsearch、Postgres(pgvector)。核心機制常由 Meta AI 的 FAISS 或 Google Research 的 ScaNN 等函式庫驅動。

**RAG 的挑戰:** 答案所需資訊常散佈多處(同份文件多段或多份文件),檢索器可能蒐集不全而導致答案殘缺;檢索到不相關區塊則引入雜訊、混淆 LLM;綜整相互矛盾的來源仍是難關。此外,整個知識庫須預先處理並存入向量(或圖)資料庫,工程量可觀,還須定期調和以保持最新(對公司維基這類演變來源尤甚)。整個過程也增加延遲、成本與提示 token 數。

**Graph RAG:** GraphRAG 改用知識圖譜檢索,沿著實體(節點)間的明確關係(邊)導航以回答複雜查詢。關鍵優勢是能從散佈多份文件的零碎資訊綜整出答案——正是傳統 RAG 常見的失敗之處。使用案例包括複雜金融分析、連結公司與市場事件、發掘基因與疾病關係等。主要缺點:建立與維護高品質圖譜的複雜度、成本與專業門檻都高,架構較不彈性、延遲較高,且成效完全取決於圖譜品質。當深入、相互連結的洞察比速度更關鍵時,GraphRAG 便能大放異彩,但代價是高出許多的實作與維護成本。

**Agentic RAG:** RAG 的演進形式(見圖 2),引入推理與決策層以提升可靠性。它讓「代理」扮演把關者與知識精煉者:不被動接受檢索結果,而是主動審視品質、相關性與完整性,如下列情境。

第一,**反思與來源驗證**。問「公司遠距工作政策為何?」時,標準 RAG 可能同時拉出 2020 年部落格與 2025 年官方政策,代理則分析中繼資料,辨識 2025 年政策才最權威,捨棄過時文章後才送往 LLM。

![圖 2:Agentic RAG 引入了一個推理代理,它會主動地評估、調和並精煉所檢索到的資訊,以確保最終回應更準確、更值得信賴。](assets/14-knowledge-retrieval-rag/fig-2-agentic-rag.png)

*圖 2:Agentic RAG 引入了一個推理代理,它會主動地評估、調和並精煉所檢索到的資訊,以確保最終回應更準確、更值得信賴。*

第二,**調和知識衝突**。問「Project Alpha 第一季預算是多少?」時,系統檢索到初始提案(€50,000)與定案財報(€65,000),代理辨識矛盾、優先採用較可靠的財報,把驗證過的數字交給 LLM。

第三,**多步推理綜整答案**。問「我們產品功能與定價跟對手 X 相比如何?」時,代理拆成多個子查詢(自家功能、自家定價、對手功能、對手定價),分別搜尋後綜整成結構化比較情境,促成簡單檢索無法產生的全面回應。

第四,**辨識知識缺口並運用外部工具**。問「昨天推出的新產品市場反應如何?」時,代理搜尋每週更新的內部知識庫卻找不到,察覺缺口後啟動工具(如即時網頁搜尋 API)尋找近期新聞,克服靜態內部資料庫的侷限。

**Agentic RAG 的挑戰:** 代理層顯著增加複雜度與成本——設計與維護決策邏輯及工具整合需可觀投入,反思與多步循環也增加延遲。代理本身還可能成為新錯誤來源:瑕疵推理可能陷入無用迴圈、誤解任務或不當捨棄相關資訊。總之,它把 RAG 從被動管線轉為主動的問題解決框架,大幅提升答案的可靠性與深度,但須謹慎權衡複雜度、延遲與成本。

## 實務應用與使用案例

RAG 正改變各行各業運用 LLM 的方式。應用範圍包括:

- **企業搜尋與問答:** 以 HR 政策、技術手冊等內部文件建立聊天機器人,擷取相關段落回應員工詢問。
- **客戶支援與服務台:** 存取產品手冊、FAQ 與工單,為客戶提供精準一致的回應,減少例行問題的人工介入。
- **個人化內容推薦:** 超越關鍵字比對,檢索語意上與使用者偏好相關的內容。
- **新聞與時事摘要:** 整合即時新聞動態,被問及當前事件時檢索近期文章,產出最新摘要。

## 動手實作範例(ADK)

以下三個範例示範 RAG 模式。

第一個運用 Google 搜尋進行 RAG,把 LLM 奠基於搜尋結果。Google Search 工具正是內建檢索機制的直接範例。

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

第二個示範在 ADK 中運用 Vertex AI 的 RAG 能力:初始化 `VertexAiRagMemoryService`,建立通往 Vertex AI RAG Corpus(語料庫)的連線。`SIMILARITY_TOP_K` 設定檢索前幾筆最相似結果,`VECTOR_DISTANCE_THRESHOLD` 設定語意距離上限。如此即可從指定 Corpus 執行可擴展、持久的語意檢索。

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

第三個以一個完整的 LangChain 範例走過整個流程。

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

這段程式碼以 LangChain 與 LangGraph 實作 RAG 管線:從文字文件建立知識庫,切分區塊、轉成嵌入後存入 Weaviate。LangGraph 的 `StateGraph` 串接兩個節點——`retrieve_documents_node` 查詢向量庫找出相關區塊,`generate_response_node` 結合檢索結果與提示範本經 OpenAI LLM 生成回應;`app.stream` 則執行查詢。

## 重點速覽

**是什麼(What):** LLM 文字生成出色,卻受限於靜態訓練資料,不含即時或私有、特定領域的資訊,回應因而可能過時、不準確或欠缺所需情境,限制了需要即時事實性答案之應用的可靠度。

**為什麼(Why):** RAG 把 LLM 連接到外部知識來源:收到查詢時先檢索相關片段、附加到提示以豐富情境,再送往 LLM 生成準確、可驗證的回應。這把 LLM 從閉卷(closed-book)推理者轉為開卷(open-book)推理者,大幅提升實用性與可信度。

**經驗法則(Rule of thumb):** 當你需要 LLM 根據特定、最新或專有(非訓練資料)的資訊作答時使用。非常適合內部文件問答、客戶支援機器人,以及需附帶引用、可驗證之事實性回應的應用。

## 視覺摘要

![知識檢索模式:一個 AI 代理向結構化資料庫查詢並檢索資訊。](assets/14-knowledge-retrieval-rag/visual-summary-structured-database.png)

*知識檢索模式:一個 AI 代理向結構化資料庫查詢並檢索資訊。*

![圖 3:知識檢索模式:一個 AI 代理回應使用者查詢,從公開網際網路中尋找並綜整資訊。](assets/14-knowledge-retrieval-rag/fig-3-web-search-retrieval.png)

*圖 3:知識檢索模式:一個 AI 代理回應使用者查詢,從公開網際網路中尋找並綜整資訊。*

## 結論

RAG 把 LLM 連接到外部、最新的資料,解決靜態知識的核心侷限:先檢索相關片段、再增強提示,讓 LLM 生成更準確、更具情境感知的回應。其核心是檢索(搜尋片段)與增強(併入提示),仰賴嵌入、語意搜尋與向量資料庫依「意義」而非關鍵字尋找資訊。把輸出奠基於可驗證資料,RAG 大幅減少幻覺、使專有知識整合成為可能,並透過引用讓答案得以被歸因、提升信任。

兩種進階形式各擅勝場:Agentic RAG 引入推理層,主動驗證、調和並綜整檢索知識,能解決矛盾資訊、執行多步查詢、用外部工具補缺;GraphRAG 則以知識圖譜導航明確的資料關係,綜整高度複雜、相互連結的查詢。兩者雖增添複雜度與延遲,卻大幅提升回應的深度與可信度。實務應用已遍及企業搜尋、客戶支援、法律研究與個人化推薦,把 LLM 從閉卷對話者轉變為強大的開卷推理工具。

## 參考資料

1. Lewis, P., et al. (2020). Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks. <https://arxiv.org/abs/2005.11401>
2. Google AI for Developers Documentation. Retrieval Augmented Generation. <https://cloud.google.com/vertex-ai/generative-ai/docs/rag-engine/rag-overview>
3. Retrieval-Augmented Generation with Graphs (GraphRAG). <https://arxiv.org/abs/2501.00309>
4. LangChain and LangGraph: Leonie Monigatti, "Retrieval-Augmented Generation (RAG): From Theory to LangChain Implementation." <https://medium.com/data-science/retrieval-augmented-generation-rag-from-theory-to-langchain-implementation-4e9bd5f6a4f2>
5. Google Cloud Vertex AI RAG Corpus. <https://cloud.google.com/vertex-ai/generative-ai/docs/rag-engine/manage-your-rag-corpus#corpus-management>
