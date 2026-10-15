export const UPDATE_PROJECT_STRATEGY_MUTATION = `
  mutation UpdateProject($projectId: ID!, $ragStrategy: String) {
    updateProject(projectId: $projectId, ragStrategy: $ragStrategy) { id name description rag_strategy created_at updated_at }
  }
`;