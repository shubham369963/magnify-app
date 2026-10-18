import assert from "node:assert/strict";
import { test } from "@jest/globals";
import { ConversationsService } from "../../dist/conversation-service/conversations.service.js";

const ownerId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000002";
const conversationId = "00000000-0000-4000-8000-000000000003";

function createService(messageRows) {
  const selections = [];
  const service = new ConversationsService(
    {
      async select(table, query) {
        selections.push({ table, query: new URLSearchParams(query) });
        if (table === "conversations") return [{ id: conversationId }];
        return messageRows;
      },
    },
    { async get() { return { id: projectId }; } },
    {},
  );
  return { service, selections };
}

test("paginated message history fetches newest-first pages and returns them chronological", async () => {
  const messageRows = [5, 4, 3].map((sequence_number) => ({
    id: `message-${sequence_number}`,
    sequence_number,
    metadata: { sources: [] },
  }));
  const { service, selections } = createService(messageRows);

  const messages = await service.listMessages(ownerId, projectId, conversationId, 20, 20);
  const request = selections.find(({ table }) => table === "messages");

  assert.equal(request.query.get("order"), "sequence_number.desc");
  assert.equal(request.query.get("limit"), "20");
  assert.equal(request.query.get("offset"), "20");
  assert.deepEqual(messages.map(({ sequence_number }) => sequence_number), [3, 4, 5]);
});

test("unpaginated message history keeps its existing ascending order", async () => {
  const messageRows = [1, 2].map((sequence_number) => ({
    id: `message-${sequence_number}`,
    sequence_number,
    metadata: { sources: [] },
  }));
  const { service, selections } = createService(messageRows);

  const messages = await service.listMessages(ownerId, projectId, conversationId);
  const request = selections.find(({ table }) => table === "messages");

  assert.equal(request.query.get("order"), "sequence_number.asc");
  assert.equal(request.query.has("limit"), false);
  assert.deepEqual(messages.map(({ sequence_number }) => sequence_number), [1, 2]);
});
