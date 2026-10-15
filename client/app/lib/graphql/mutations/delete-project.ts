export const DELETE_PROJECT_MUTATION = `
  mutation DeleteProject($projectId: ID!) { deleteProject(projectId: $projectId) }
`;