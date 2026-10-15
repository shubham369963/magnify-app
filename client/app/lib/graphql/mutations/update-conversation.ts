export const UPDATE_CONVERSATION_MUTATION = `
  mutation UpdateConversation($projectId: ID!, $conversationId: ID!, $title: String!) {
    updateConversation(projectId: $projectId, conversationId: $conversationId, title: $title) { id title updated_at }
  }
`;