export const PROJECT_DOCUMENTS_QUERY = `
  query Documents($projectId: ID!, $limit: Int, $offset: Int) {
    documents(projectId: $projectId, limit: $limit, offset: $offset) {
      id file_name file_size processing_status processing_error created_at
    }
  }
`;