export const CREATE_CONVERSATION_MUTATION = `
  mutation CreateConversation($projectId: ID!) {
    createConversation(projectId: $projectId) { id title updated_at }
  }
`;