export const DELETE_CONVERSATION_MUTATION = `
  mutation DeleteConversation($projectId: ID!, $conversationId: ID!) {
    deleteConversation(projectId: $projectId, conversationId: $conversationId)
  }
`;