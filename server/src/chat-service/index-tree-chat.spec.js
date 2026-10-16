import assert from "node:assert/strict";
import { afterEach, beforeEach, jest, test } from "@jest/globals";
import { ChatOllama } from "@langchain/ollama";
import { QdrantVectorStore } from "@langchain/qdrant";
import { ChatService } from "../../dist/chat-service/chat.service.js";
import { GeminiEmbeddings } from "../../dist/config/gemini-embeddings.js";

const geminiEmbeddingSettings = {
  GEMINI_EMBEDDING_MODEL: "gemini-embedding-2",
  GEMINI_EMBEDDING_DIMENSIONS: "768",
  GEMINI_EMBEDDING_BATCH_SIZE: "100",
  GEMINI_EMBEDDING_MAX_ATTEMPTS: "3",
  GEMINI_EMBEDDING_REQUEST_TIMEOUT_MS: "60000",
  GEMINI_EMBEDDING_RETRY_DELAY_MS: "250",
  GEMINI_EMBEDDING_RATE_LIMIT_RETRY_DELAY_MS: "15000",
  GEMINI_EMBEDDING_RATE_LIMIT_MAX_DELAY_MS: "60000",
  GEMINI_EMBEDDING_MAX_RETRY_AFTER_MS: "120000",
};
const previousGeminiEmbeddingSettings = Object.fromEntries(
  Object.keys(geminiEmbeddingSettings).map((key) => [key, process.env[key]]),
);

beforeEach(() => Object.assign(process.env, geminiEmbeddingSettings));
afterEach(() => {
  for (const [key, value] of Object.entries(previousGeminiEmbeddingSettings)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function createChatService(conversations, documents, projects, supabase) {
  conversations.getInVerifiedProject = conversations.get;
  conversations.recentMessagesInVerifiedConversation =
    conversations.recentMessages;
  conversations.saveExchangeInVerifiedConversation = conversations.saveExchange;
  documents.listInVerifiedProject = documents.list;
  return new ChatService(conversations, documents, projects, supabase);
}

test("project index-tree chat answers from authorized leaf passages without vector search", async () => {
  const saved = [];
  const tree = {
    type: "root",
    title: "Research project index",
    children: [
      {
        id: "document-branch",
        type: "document",
        title: "study.pdf",
        document_id: "doc-1",
        children: [
          {
            id: "section-1",
            type: "section",
            title: "Key findings",
            summary: "Study results.",
            start_page: 3,
            end_page: 3,
            children: [
              {
                id: "passage-1",
                type: "passage",
                title: "Page 3",
                document_id: "doc-1",
                page: 3,
                content_type: "image_caption",
                content_reference:
                  "The measured outcome increased by 42 percent.",
              },
            ],
          },
        ],
      },
    ],
  };
  const conversations = {
    get: async () => ({ id: "conversation-1" }),
    recentMessages: async () => [],
    saveExchange: async (...args) => {
      saved.push(args);
    },
  };
  const documents = {
    list: async () => [{ id: "doc-1", file_name: "study.pdf" }],
    previewUrl: async () => "https://example.test/study.pdf#page=3",
  };
  const projects = { get: async () => ({ rag_strategy: "index_tree" }) };
  const supabase = {
    select: async () => [{ status: "completed", tree, error_message: null }],
  };
  let modelCall = 0;
  const modelSpy = jest
    .spyOn(ChatOllama.prototype, "invoke")
    .mockImplementation(async (messages) => {
      modelCall += 1;
      const payload = JSON.parse(messages.at(-1).content);
      return {
        content: Array.isArray(payload.evidence)
          ? JSON.stringify({
              answer: "The measured outcome increased by 42 percent.",
              sources: [
                {
                  id: "Epassage-1",
                  excerpt: "The measured outcome increased by 42 percent.",
                },
              ],
            })
          : '{"relevant_ids":["D1"]}',
      };
    });
  const vectorSpy = jest.spyOn(QdrantVectorStore, "fromExistingCollection");
  const originalApiKey = process.env.OLLAMA_API_KEY;
  process.env.OLLAMA_API_KEY = "test-key";
  try {
    const service = createChatService(
      conversations,
      documents,
      projects,
      supabase,
    );
    const response = await service.chat(
      "What changed?",
      "user-1",
      "project-1",
      "conversation-1",
    );
    assert.equal(response.ragStrategy, "index_tree");
    assert.equal(
      response.message,
      "- The measured outcome increased by 42 percent.",
    );
    assert.equal(response.docs.length, 1);
    assert.equal(
      response.docs[0].pageContent,
      "The measured outcome increased by 42 percent.",
    );
    assert.equal(response.docs[0].metadata.content_type, "image_caption");
    assert.equal(modelCall, 2);
    assert.equal(vectorSpy.mock.calls.length, 0);
    assert.equal(saved.length, 1);
    assert.equal(saved[0][5].sources[0].document_id, "doc-1");
    assert.equal(saved[0][5].sources[0].content_type, "image_caption");
    assert.equal(saved[0][5].rag_strategy, "index_tree");
  } finally {
    modelSpy.mockRestore();
    vectorSpy.mockRestore();
    if (originalApiKey === undefined) delete process.env.OLLAMA_API_KEY;
    else process.env.OLLAMA_API_KEY = originalApiKey;
  }
});

test("tree retrieval includes an exact passage in a late section with no matching heading", async () => {
  const sections = Array.from({ length: 7 }, (_unused, index) => ({
    id: `section-${index + 1}`,
    type: "section",
    title: index === 6 ? "Unclassified" : `Topic ${index + 1}`,
    summary: `General material for topic ${index + 1}.`,
    start_page: index + 1,
    end_page: index + 1,
    children: [
      {
        id: `passage-${index + 1}`,
        type: "passage",
        document_id: "doc-1",
        page: index + 1,
        source_order: index + 1,
        content_reference:
          index === 6
            ? "Measured calibration of alloy Z-17: thermographic coefficient 0.73 W/(m·K)."
            : `Routine observation ${index + 1} describes unrelated conditions.`,
      },
    ].map((passage) =>
      index === 6
        ? {
            id: "subsection-measurements",
            type: "subsection",
            title: "Measurements",
            children: [passage],
          }
        : passage,
    ),
  }));
  const tree = {
    type: "root",
    title: "Project index",
    children: [
      {
        id: "document-branch",
        type: "document",
        title: "technical-report.pdf",
        document_id: "doc-1",
        children: sections,
      },
    ],
  };
  const conversations = {
    get: async () => ({ id: "conversation-1" }),
    recentMessages: async () => [],
    saveExchange: async () => {},
  };
  const documents = {
    list: async () => [{ id: "doc-1", file_name: "technical-report.pdf" }],
  };
  const projects = { get: async () => ({ rag_strategy: "index_tree" }) };
  const supabase = {
    select: async () => [{ status: "completed", tree, error_message: null }],
  };
  let selectedPassageIds = [];
  const modelSpy = jest
    .spyOn(ChatOllama.prototype, "invoke")
    .mockImplementation(async (messages) => {
      const payload = JSON.parse(messages.at(-1).content);
      if (Array.isArray(payload.evidence)) {
        const evidence = payload.evidence[0];
        return {
          content: JSON.stringify({
            answer: "The coefficient is 0.73 W/(m·K).",
            sources: [
              {
                id: evidence.id,
                excerpt: "thermographic coefficient 0.73 W/(m·K)",
              },
            ],
          }),
        };
      }
      selectedPassageIds = payload.candidates.flatMap((candidate) =>
        typeof candidate.content === "string" &&
        candidate.content.includes("thermographic coefficient")
          ? [candidate.evidence_id]
          : [],
      );
      return {
        content: JSON.stringify({
          relevant_ids: selectedPassageIds.length ? ["D1"] : ["D1", "D2", "D3"],
        }),
      };
    });
  const originalApiKey = process.env.OLLAMA_API_KEY;
  process.env.OLLAMA_API_KEY = "test-key";
  try {
    const service = createChatService(
      conversations,
      documents,
      projects,
      supabase,
    );
    const response = await service.chat(
      "What thermographic coefficient is reported for alloy Z-17?",
      "user-1",
      "project-1",
      "conversation-1",
    );
    assert.match(response.message, /0\.73 W\/\(m·K\)/u);
    assert.equal(
      response.docs[0].pageContent,
      "Measured calibration of alloy Z-17: thermographic coefficient 0.73 W/(m·K).",
    );
    assert.equal(
      response.docs[0].metadata.excerpt,
      "thermographic coefficient 0.73 W/(m·K)",
    );
    assert.equal(response.docs[0].metadata.loc.pageNumber, 7);
    assert.equal(
      response.docs[0].metadata.section_title,
      "Unclassified / Measurements",
    );
    assert.deepEqual(selectedPassageIds, ["Epassage-7"]);
  } finally {
    modelSpy.mockRestore();
    if (originalApiKey === undefined) delete process.env.OLLAMA_API_KEY;
    else process.env.OLLAMA_API_KEY = originalApiKey;
  }
});

test("bounded fallback reaches a late passage when semantic relevance has no lexical overlap", async () => {
  const sections = Array.from({ length: 25 }, (_unused, index) => ({
    id: `section-${index + 1}`,
    type: "section",
    title: `Section ${index + 1}`,
    summary: `General notes ${index + 1}.`,
    children: [
      {
        id: `passage-${index + 1}`,
        type: "passage",
        document_id: "doc-1",
        page: index + 1,
        source_order: index + 1,
        content_reference:
          index === 24
            ? "A thermal barrier slows energy transfer by limiting molecular movement."
            : `Routine administrative observation ${index + 1}.`,
      },
    ],
  }));
  const tree = {
    id: "project-1",
    type: "root",
    title: "Project index",
    children: [
      {
        id: "document-branch",
        type: "document",
        title: "manual.pdf",
        document_id: "doc-1",
        children: sections,
      },
    ],
  };
  const conversations = {
    get: async () => ({}),
    recentMessages: async () => [],
    saveExchange: async () => {},
  };
  const documents = {
    list: async () => [{ id: "doc-1", file_name: "manual.pdf" }],
  };
  const projects = { get: async () => ({ rag_strategy: "index_tree" }) };
  const supabase = {
    select: async () => [{ status: "completed", tree, error_message: null }],
  };
  let selectorCandidateCount = 0;
  let selectedEvidenceId;
  const modelSpy = jest
    .spyOn(ChatOllama.prototype, "invoke")
    .mockImplementation(async (messages) => {
      const payload = JSON.parse(messages.at(-1).content);
      if (Array.isArray(payload.evidence)) {
        const evidence = payload.evidence[0];
        return {
          content: JSON.stringify({
            answer: "Insulation reduces heat loss by slowing energy transfer.",
            sources: [
              {
                id: evidence.id,
                excerpt: "slows energy transfer by limiting molecular movement",
              },
            ],
          }),
        };
      }
      selectorCandidateCount = payload.candidates.length;
      const targetIndex = payload.candidates.findIndex((candidate) =>
        candidate.content.includes("thermal barrier"),
      );
      if (targetIndex < 0) return { content: '{"relevant_ids":[]}' };
      selectedEvidenceId = payload.candidates[targetIndex].evidence_id;
      return {
        content: JSON.stringify({ relevant_ids: [`D${targetIndex + 1}`] }),
      };
    });
  const originalApiKey = process.env.OLLAMA_API_KEY;
  process.env.OLLAMA_API_KEY = "test-key";
  try {
    const service = createChatService(
      conversations,
      documents,
      projects,
      supabase,
    );
    const response = await service.chat(
      "How does insulation limit heat loss?",
      "user-1",
      "project-1",
      "conversation-1",
    );
    assert.match(response.message, /slowing energy transfer/u);
    assert.equal(response.docs[0].metadata.loc.pageNumber, 25);
    assert.equal(selectorCandidateCount, 20);
    assert.equal(selectedEvidenceId, "Epassage-25");
  } finally {
    modelSpy.mockRestore();
    if (originalApiKey === undefined) delete process.env.OLLAMA_API_KEY;
    else process.env.OLLAMA_API_KEY = originalApiKey;
  }
});

test("lexical evidence survives selector timeouts and malformed output", async () => {
  const tree = {
    id: "project-1",
    type: "root",
    title: "Project index",
    children: [
      {
        id: "document-branch",
        type: "document",
        title: "records.pdf",
        document_id: "doc-1",
        children: [
          {
            id: "section-records",
            type: "section",
            title: "Records",
            children: [
              {
                id: "passage-record",
                type: "passage",
                document_id: "doc-1",
                page: 4,
                source_order: 1,
                content_reference: "Record AC-12 was issued on 2025-04-03.",
              },
            ],
          },
        ],
      },
    ],
  };
  const conversations = {
    get: async () => ({}),
    recentMessages: async () => [],
    saveExchange: async () => {},
  };
  const documents = {
    list: async () => [{ id: "doc-1", file_name: "records.pdf" }],
  };
  const projects = { get: async () => ({ rag_strategy: "index_tree" }) };
  const supabase = {
    select: async () => [{ status: "completed", tree, error_message: null }],
  };
  let selectorBehavior = "timeout";
  const modelSpy = jest
    .spyOn(ChatOllama.prototype, "invoke")
    .mockImplementation(async (messages) => {
      const payload = JSON.parse(messages.at(-1).content);
      if (Array.isArray(payload.evidence)) {
        const evidence = payload.evidence[0];
        return {
          content: JSON.stringify({
            answer: "Record AC-12 was issued on 2025-04-03.",
            sources: [{ id: evidence.id, excerpt: "2025-04-03" }],
          }),
        };
      }
      if (selectorBehavior === "timeout") throw new Error("selector timed out");
      return { content: "not valid JSON" };
    });
  const originalApiKey = process.env.OLLAMA_API_KEY;
  process.env.OLLAMA_API_KEY = "test-key";
  try {
    const service = createChatService(
      conversations,
      documents,
      projects,
      supabase,
    );
    for (const behavior of ["timeout", "malformed"]) {
      selectorBehavior = behavior;
      const response = await service.chat(
        "When was record AC-12 issued?",
        "user-1",
        "project-1",
        "conversation-1",
      );
      assert.match(response.message, /2025-04-03/u);
      assert.equal(response.docs[0].metadata.loc.pageNumber, 4);
    }
  } finally {
    modelSpy.mockRestore();
    if (originalApiKey === undefined) delete process.env.OLLAMA_API_KEY;
    else process.env.OLLAMA_API_KEY = originalApiKey;
  }
});

test("partially persisted trees with empty and malformed passage nodes fail gracefully", async () => {
  const tree = {
    id: "project-1",
    type: "root",
    title: "Project index",
    children: [
      {
        id: "document-branch",
        type: "document",
        title: "partial.pdf",
        document_id: "doc-1",
        children: [
          null,
          {
            type: "passage",
            document_id: "doc-1",
            page: 3,
            content_reference:
              "This passage has content but no stable identifier.",
          },
          {
            type: "passage",
            document_id: "doc-1",
            page: 3,
            content_reference: "  ",
          },
        ],
      },
    ],
  };
  const conversations = {
    get: async () => ({}),
    recentMessages: async () => [],
    saveExchange: async () => {},
  };
  const documents = {
    list: async () => [{ id: "doc-1", file_name: "partial.pdf" }],
  };
  const projects = { get: async () => ({ rag_strategy: "index_tree" }) };
  const supabase = {
    select: async () => [{ status: "completed", tree, error_message: null }],
  };
  const modelSpy = jest.spyOn(ChatOllama.prototype, "invoke");
  const originalApiKey = process.env.OLLAMA_API_KEY;
  process.env.OLLAMA_API_KEY = "test-key";
  try {
    const service = createChatService(
      conversations,
      documents,
      projects,
      supabase,
    );
    const response = await service.chat(
      "What is recorded?",
      "user-1",
      "project-1",
      "conversation-1",
    );
    assert.equal(
      response.message,
      "The requested information is unavailable in the provided documents.",
    );
    assert.deepEqual(response.docs, []);
    assert.equal(modelSpy.mock.calls.length, 0);
  } finally {
    modelSpy.mockRestore();
    if (originalApiKey === undefined) delete process.env.OLLAMA_API_KEY;
    else process.env.OLLAMA_API_KEY = originalApiKey;
  }
});

test("legacy persisted flat-node trees expose leaf evidence to answer generation", async () => {
  const tree = {
    type: "root",
    title: "Project index",
    children: [
      {
        type: "document",
        title: "records.pdf",
        document_id: "doc-1",
        nodes: [
          {
            id: "root-1",
            parent_node_id: null,
            type: "root",
            title: "Document root",
            depth: 0,
            sort_order: 0,
            start_page: 1,
            end_page: 1,
            metadata: {},
          },
          {
            id: "section-1",
            parent_node_id: "root-1",
            type: "section",
            title: "Academic record",
            summary: "Academic results.",
            depth: 1,
            sort_order: 1,
            start_page: 1,
            end_page: 1,
            metadata: {},
          },
          {
            id: "leaf-1",
            parent_node_id: "section-1",
            type: "leaf",
            title: "Page 1",
            content_reference: "Final grade point average: 8.30/10.",
            depth: 2,
            sort_order: 1,
            start_page: 1,
            end_page: 1,
            metadata: {
              page: 1,
              source_order: 1,
              content_type: "text",
              normalized_content: "  ",
            },
          },
        ],
      },
    ],
  };
  const saved = [];
  const conversations = {
    get: async () => ({ id: "conversation-1" }),
    recentMessages: async () => [],
    saveExchange: async (...args) => {
      saved.push(args);
    },
  };
  const documents = {
    list: async () => [{ id: "doc-1", file_name: "records.pdf" }],
  };
  const projects = { get: async () => ({ rag_strategy: "index_tree" }) };
  const supabase = {
    select: async () => [{ status: "completed", tree, error_message: null }],
  };
  let passageCandidates;
  const modelSpy = jest
    .spyOn(ChatOllama.prototype, "invoke")
    .mockImplementation(async (messages) => {
      const payload = JSON.parse(messages.at(-1).content);
      if (Array.isArray(payload.evidence)) {
        const evidence = payload.evidence[0];
        return {
          content: JSON.stringify({
            answer: "The grade point average is 8.30/10.",
            sources: [{ id: evidence.id, excerpt: "8.30/10" }],
          }),
        };
      }
      if (
        payload.candidates.some(
          (candidate) => typeof candidate.content === "string",
        )
      ) {
        passageCandidates = payload.candidates;
        return { content: '{"relevant_ids":["D1"]}' };
      }
      return { content: '{"relevant_ids":[]}' };
    });
  const originalApiKey = process.env.OLLAMA_API_KEY;
  process.env.OLLAMA_API_KEY = "test-key";
  try {
    const service = createChatService(
      conversations,
      documents,
      projects,
      supabase,
    );
    const response = await service.chat(
      "What is the grade point average?",
      "user-1",
      "project-1",
      "conversation-1",
    );
    assert.match(response.message, /8\.30\/10/u);
    assert.equal(response.docs.length, 1);
    assert.equal(saved[0][5].sources[0].page, 1);
    assert.equal(
      passageCandidates[0].content,
      "Final grade point average: 8.30/10.",
    );
  } finally {
    modelSpy.mockRestore();
    if (originalApiKey === undefined) delete process.env.OLLAMA_API_KEY;
    else process.env.OLLAMA_API_KEY = originalApiKey;
  }
});

test("tree chat returns unavailable when fallback context cannot ground the answer", async () => {
  const saved = [];
  const tree = {
    type: "root",
    title: "Resume index",
    children: [
      {
        id: "document-branch",
        type: "document",
        title: "resume.pdf",
        document_id: "doc-1",
        children: [
          {
            id: "education",
            type: "section",
            title: "Education",
            summary: "Academic history and course details.",
            children: [
              {
                id: "education-passage",
                type: "passage",
                document_id: "doc-1",
                page: 1,
                source_order: 1,
                content_reference:
                  "B.Tech. in Computer Engineering. CGPA: 8.30/10.",
              },
            ],
          },
        ],
      },
    ],
  };
  const conversations = {
    get: async () => ({ id: "conversation-1" }),
    recentMessages: async () => [],
    saveExchange: async (...args) => {
      saved.push(args);
    },
  };
  const documents = {
    list: async () => [{ id: "doc-1", file_name: "resume.pdf" }],
  };
  const projects = { get: async () => ({ rag_strategy: "index_tree" }) };
  const supabase = {
    select: async () => [{ status: "completed", tree, error_message: null }],
  };
  let answerCalls = 0;
  const modelSpy = jest
    .spyOn(ChatOllama.prototype, "invoke")
    .mockImplementation(async (messages) => {
      const payload = JSON.parse(messages.at(-1).content);
      if (Array.isArray(payload.evidence)) {
        answerCalls += 1;
        return { content: '{"answer":"unsupported","sources":[]}' };
      }
      return {
        content: payload.candidates.some(
          (candidate) => typeof candidate.content === "string",
        )
          ? '{"relevant_ids":[]}'
          : '{"relevant_ids":["D1"]}',
      };
    });
  const originalApiKey = process.env.OLLAMA_API_KEY;
  process.env.OLLAMA_API_KEY = "test-key";
  try {
    const service = createChatService(
      conversations,
      documents,
      projects,
      supabase,
    );
    const response = await service.chat(
      "What is the candidate salary?",
      "user-1",
      "project-1",
      "conversation-1",
    );
    assert.equal(
      response.message,
      "The requested information is unavailable in the provided documents.",
    );
    assert.equal(response.docs.length, 0);
    assert.equal(answerCalls, 1);
    assert.deepEqual(saved[0][5].sources, []);
  } finally {
    modelSpy.mockRestore();
    if (originalApiKey === undefined) delete process.env.OLLAMA_API_KEY;
    else process.env.OLLAMA_API_KEY = originalApiKey;
  }
});

test("tree chat covers multiple sections and expands an incomplete cross-page passage", async () => {
  const tree = {
    type: "root",
    title: "Research project index",
    children: [
      {
        id: "document-branch",
        type: "document",
        title: "study.pdf",
        document_id: "doc-1",
        children: [
          {
            id: "section-mechanism",
            type: "section",
            title: "Mechanism",
            summary: "Outcome details.",
            children: [
              {
                id: "passage-1",
                type: "passage",
                document_id: "doc-1",
                page: 5,
                source_order: 1,
                content_reference: "The outcome shifted because...",
                next_evidence_id: "passage-2",
              },
            ],
          },
          {
            id: "section-continuation",
            type: "section",
            title: "Continuation",
            children: [
              {
                id: "passage-2",
                type: "passage",
                document_id: "doc-1",
                page: 6,
                source_order: 2,
                content_reference:
                  "...the remaining units are converted into reserve material.",
                previous_evidence_id: "passage-1",
              },
            ],
          },
          {
            id: "section-costs",
            type: "section",
            title: "Cost impacts",
            summary: "Costs changed.",
            children: [
              {
                id: "passage-3",
                type: "passage",
                document_id: "doc-1",
                page: 7,
                source_order: 3,
                content_reference: "Costs increased by 12 units.",
              },
            ],
          },
          {
            id: "section-background",
            type: "section",
            title: "Background",
            summary: "Additional supporting details.",
            start_page: 8,
            end_page: 15,
            children: Array.from({ length: 8 }, (_value, index) => ({
              id: `passage-background-${index + 1}`,
              type: "passage",
              document_id: "doc-1",
              page: index + 8,
              source_order: index + 4,
              content_reference: `Background detail ${index + 1}.`,
            })),
          },
        ],
      },
    ],
  };
  const conversations = {
    get: async () => ({ id: "conversation-1" }),
    recentMessages: async () => [],
    saveExchange: async () => {},
  };
  const documents = {
    list: async () => [{ id: "doc-1", file_name: "study.pdf" }],
    previewUrl: async () => "https://example.test/study.pdf",
  };
  const projects = { get: async () => ({ rag_strategy: "index_tree" }) };
  const supabase = {
    select: async () => [{ status: "completed", tree, error_message: null }],
  };
  let modelCall = 0;
  let answerPayload;
  const modelSpy = jest
    .spyOn(ChatOllama.prototype, "invoke")
    .mockImplementation(async (messages) => {
      modelCall += 1;
      const payload = JSON.parse(messages.at(-1).content);
      if (!Array.isArray(payload.evidence)) {
        const relevantIds = payload.candidates.flatMap((candidate, index) =>
          /outcome|cost/i.test(JSON.stringify(candidate))
            ? [`D${index + 1}`]
            : [],
        );
        return { content: JSON.stringify({ relevant_ids: relevantIds }) };
      }
      answerPayload = payload;
      return {
        content: JSON.stringify({
          answer: "The outcome shifted, and costs increased.",
          sources: [
            { id: "Epassage-1", excerpt: "The outcome shifted because..." },
            { id: "Epassage-3", excerpt: "Costs increased by 12 units." },
          ],
        }),
      };
    });
  const vectorSpy = jest.spyOn(QdrantVectorStore, "fromExistingCollection");
  const originalApiKey = process.env.OLLAMA_API_KEY;
  process.env.OLLAMA_API_KEY = "test-key";
  try {
    const service = createChatService(
      conversations,
      documents,
      projects,
      supabase,
    );
    const response = await service.chat(
      "Explain the outcome and costs.",
      "user-1",
      "project-1",
      "conversation-1",
    );
    assert.equal(response.ragStrategy, "index_tree");
    assert.equal(
      response.message,
      "- The outcome shifted, and costs increased.",
    );
    assert.deepEqual(
      response.docs.map((doc) => doc.pageContent),
      ["The outcome shifted because...", "Costs increased by 12 units."],
    );
    assert.deepEqual(
      answerPayload.evidence.map((item) => item.id),
      ["Epassage-1", "Epassage-2", "Epassage-3"],
    );
    assert.ok(
      answerPayload.evidence.every(
        (item) => !("page" in item) && !("section_title" in item),
      ),
    );
    assert.equal(modelCall, 2);
    assert.equal(vectorSpy.mock.calls.length, 0);
  } finally {
    modelSpy.mockRestore();
    vectorSpy.mockRestore();
    if (originalApiKey === undefined) delete process.env.OLLAMA_API_KEY;
    else process.env.OLLAMA_API_KEY = originalApiKey;
  }
});

test("tree chat excludes unrelated sections and does not use section metadata as answer evidence", async () => {
  const tree = {
    type: "root",
    title: "Resume index",
    children: [
      {
        id: "document-branch",
        type: "document",
        title: "Shubham_Halade_Resume.pdf",
        document_id: "doc-1",
        children: [
          {
            id: "section-personal",
            type: "section",
            title: "Personal Information",
            summary: "Contact details and professional profiles.",
            start_page: 1,
            end_page: 1,
            children: [
              {
                id: "personal-passage",
                type: "passage",
                document_id: "doc-1",
                page: 1,
                source_order: 1,
                content_reference:
                  "Rajarambapu Institute of Technology. January 2021 to June 2024.",
              },
            ],
          },
          {
            id: "section-education",
            type: "section",
            title: "Education",
            summary:
              "Academic background in Computer Engineering from Rajarambapu Institute of Technology.",
            start_page: 1,
            end_page: 1,
            children: [
              {
                id: "education-passage",
                type: "passage",
                document_id: "doc-1",
                page: 1,
                source_order: 2,
                content_reference:
                  "Computer Engineering. CGPA: 8.30/10. Relevant coursework.",
                previous_evidence_id: "personal-passage",
              },
            ],
          },
          {
            id: "section-institute-details",
            type: "section",
            title: "Institute Details",
            summary: "Institution name and enrollment dates.",
            start_page: 1,
            end_page: 1,
            children: [
              {
                id: "duplicate-college-passage",
                type: "passage",
                document_id: "doc-1",
                page: 1,
                source_order: 1,
                content_reference:
                  "Rajarambapu Institute of Technology. January 2021 to June 2024.",
              },
            ],
          },
          {
            id: "section-awards",
            type: "section",
            title: "Awards",
            summary: "Unrelated recognition details.",
            children: [
              {
                id: "award-passage",
                type: "passage",
                document_id: "doc-1",
                page: 1,
                source_order: 3,
                content_reference:
                  "Received an unrelated award for volunteering.",
              },
            ],
          },
        ],
      },
    ],
  };
  const saved = [];
  const conversations = {
    get: async () => ({ id: "conversation-1" }),
    recentMessages: async () => [],
    saveExchange: async (...args) => {
      saved.push(args);
    },
  };
  const documents = {
    list: async () => [{ id: "doc-1", file_name: "Shubham_Halade_Resume.pdf" }],
    previewUrl: async () => "https://example.test/resume.pdf#page=1",
  };
  const projects = { get: async () => ({ rag_strategy: "index_tree" }) };
  const supabase = {
    select: async () => [{ status: "completed", tree, error_message: null }],
  };
  let answerPayload;
  const modelSpy = jest
    .spyOn(ChatOllama.prototype, "invoke")
    .mockImplementation(async (messages) => {
      const payload = JSON.parse(messages.at(-1).content);
      if (!Array.isArray(payload.evidence)) {
        const relevantIds = payload.candidates.flatMap((candidate, index) =>
          typeof candidate.content === "string" &&
          candidate.content.includes("Rajarambapu")
            ? [`D${index + 1}`]
            : [],
        );
        return { content: JSON.stringify({ relevant_ids: relevantIds }) };
      }
      answerPayload = payload;
      const evidence = payload.evidence.find((item) =>
        item.content.includes("Rajarambapu"),
      );
      return {
        content: JSON.stringify({
          answer: "The college is Rajarambapu Institute of Technology.",
          sources: [
            {
              id: evidence.alternateIds[0],
              excerpt: "Rajarambapu Institute of Technology.",
            },
          ],
        }),
      };
    });
  const originalApiKey = process.env.OLLAMA_API_KEY;
  process.env.OLLAMA_API_KEY = "test-key";
  try {
    const service = createChatService(
      conversations,
      documents,
      projects,
      supabase,
    );
    const response = await service.chat(
      "What is the college name in my resume?",
      "user-1",
      "project-1",
      "conversation-1",
    );
    assert.match(response.message, /Rajarambapu Institute of Technology/);
    assert.equal(
      response.docs[0].pageContent,
      "Rajarambapu Institute of Technology. January 2021 to June 2024.",
    );
    assert.equal(
      response.docs[0].metadata.excerpt,
      "Rajarambapu Institute of Technology.",
    );
    assert.equal(answerPayload.evidence.length, 1);
    assert.match(answerPayload.evidence[0].content, /Rajarambapu/u);
    assert.ok(!JSON.stringify(answerPayload).includes("unrelated award"));
    assert.ok(!("section_title" in answerPayload.evidence[0]));
    assert.equal(saved[0][5].sources[0].section_title, "Personal Information");
    assert.deepEqual(saved[0][5].sources[0].evidence_ids, [
      "Epersonal-passage",
      "Eduplicate-college-passage",
    ]);
  } finally {
    modelSpy.mockRestore();
    if (originalApiKey === undefined) delete process.env.OLLAMA_API_KEY;
    else process.env.OLLAMA_API_KEY = originalApiKey;
  }
});

test("vector chat returns full evidence and its matched excerpt separately", async () => {
  const { Document } = await import("@langchain/core/documents");
  const originalContent =
    "Education: Rajarambapu Institute of Technology. CGPA: 8.30/10.";
  const saved = [];
  const conversations = {
    get: async () => ({ id: "conversation-1" }),
    recentMessages: async () => [],
    saveExchange: async (...args) => {
      saved.push(args);
    },
  };
  const documents = {
    previewUrl: async () => "https://example.test/resume.pdf#page=1",
  };
  const projects = { get: async () => ({ rag_strategy: "vector" }) };
  const supabase = {};
  const qdrantSpy = jest
    .spyOn(QdrantVectorStore, "fromExistingCollection")
    .mockResolvedValue({
      similaritySearchVectorWithScore: async () => [
        [
          new Document({
            pageContent: originalContent,
            metadata: {
              document_id: "doc-1",
              source: "resume.pdf",
              loc: { pageNumber: 1 },
              project_id: "project-1",
            },
          }),
          0.91,
        ],
      ],
    });
  const embeddingSpy = jest
    .spyOn(GeminiEmbeddings.prototype, "embedQuery")
    .mockResolvedValue(Array(768).fill(0));
  const modelSpy = jest
    .spyOn(ChatOllama.prototype, "invoke")
    .mockImplementation(async (messages) => {
      if (messages[0].content.includes("strict evidence relevance filter"))
        return { content: '{"relevant_ids":["D1"]}' };
      return {
        content: JSON.stringify({
          answer: "The college is Rajarambapu Institute of Technology.",
          sources: [
            { id: "D1", excerpt: "Rajarambapu Institute of Technology." },
          ],
        }),
      };
    });
  const originalApiKey = process.env.OLLAMA_API_KEY;
  const originalGoogleApiKey = process.env.GOOGLE_API_KEY;
  process.env.OLLAMA_API_KEY = "test-key";
  process.env.GOOGLE_API_KEY = "test-key";
  try {
    const service = createChatService(
      conversations,
      documents,
      projects,
      supabase,
    );
    const response = await service.chat(
      "What is the college name?",
      "user-1",
      "project-1",
      "conversation-1",
    );
    assert.equal(response.ragStrategy, "vector");
    assert.equal(
      response.message,
      "- The college is Rajarambapu Institute of Technology.",
    );
    assert.deepEqual(
      response.docs.map((doc) => doc.pageContent),
      [originalContent],
    );
    assert.equal(
      response.docs[0].metadata.excerpt,
      "Rajarambapu Institute of Technology.",
    );
    assert.equal(saved[0][5].sources[0].content, originalContent);
    assert.equal(
      saved[0][5].sources[0].excerpt,
      "Rajarambapu Institute of Technology.",
    );
  } finally {
    modelSpy.mockRestore();
    qdrantSpy.mockRestore();
    embeddingSpy.mockRestore();
    if (originalApiKey === undefined) delete process.env.OLLAMA_API_KEY;
    else process.env.OLLAMA_API_KEY = originalApiKey;
    if (originalGoogleApiKey === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = originalGoogleApiKey;
  }
});

test("vector chats reuse the initialized Qdrant collection", async () => {
  const service = createChatService(
    { get: async () => ({}), recentMessages: async () => [], saveExchange: async () => {} },
    { list: async () => [] },
    { get: async () => ({ rag_strategy: "vector" }) },
    {},
  );
  const originalGoogleApiKey = process.env.GOOGLE_API_KEY;
  process.env.GOOGLE_API_KEY = "test-key";
  const qdrantSpy = jest
    .spyOn(QdrantVectorStore, "fromExistingCollection")
    .mockResolvedValue({});
  try {
    await Promise.all([service.getVectorStore(), service.getVectorStore()]);
    assert.equal(qdrantSpy.mock.calls.length, 1);
  } finally {
    qdrantSpy.mockRestore();
    if (originalGoogleApiKey === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = originalGoogleApiKey;
  }
});
