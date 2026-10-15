export const UPDATE_PROJECT_DETAILS_MUTATION = `
  mutation UpdateProject($projectId: ID!, $name: String, $description: String) {
    updateProject(projectId: $projectId, name: $name, description: $description) { id name description created_at updated_at }
  }
`;