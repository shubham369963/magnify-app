export const MESSAGES_QUERY = `
  query Messages($projectId: ID!, $conversationId: ID!, $limit: Int, $offset: Int) {
    messages(projectId: $projectId, conversationId: $conversationId, limit: $limit, offset: $offset) {
      id role content metadata
    }
  }
`;