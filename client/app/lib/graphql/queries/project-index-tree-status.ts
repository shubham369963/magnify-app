export const PROJECT_INDEX_TREE_STATUS_QUERY = `
  query ProjectIndexTreeStatus($projectId: ID!) {
    projectIndexTreeStatus(projectId: $projectId) { status progress error_message updated_at }
  }
`;