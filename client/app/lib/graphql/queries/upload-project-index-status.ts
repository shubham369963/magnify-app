export const UPLOAD_PROJECT_INDEX_STATUS_QUERY = `
  query ProjectIndexTreeStatus($projectId: ID!) {
    projectIndexTreeStatus(projectId: $projectId) { status error_message }
  }
`;