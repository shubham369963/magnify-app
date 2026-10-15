export const SEND_MESSAGE_MUTATION = `
  mutation SendMessage($projectId: ID!, $conversationId: ID!, $message: String!) {
    sendMessage(projectId: $projectId, conversationId: $conversationId, message: $message) {
      message
      ragStrategy
      inputTokens
      outputTokens
      sources { source sourceOrder sectionTitle page contentType content excerpt previewUrl }
    }
  }
`;