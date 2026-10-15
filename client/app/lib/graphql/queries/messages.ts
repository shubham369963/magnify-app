export const MESSAGES_QUERY = `
  query Messages($projectId: ID!, $conversationId: ID!) {
    messages(projectId: $projectId, conversationId: $conversationId) {
      id role content metadata
    }
  }
`;