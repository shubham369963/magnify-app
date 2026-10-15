export const DELETE_DOCUMENT_MUTATION = `
  mutation DeleteDocument($projectId: ID!, $documentId: ID!) {
    deleteDocument(projectId: $projectId, documentId: $documentId)
  }
`;
