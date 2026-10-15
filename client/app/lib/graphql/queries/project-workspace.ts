export const PROJECT_WORKSPACE_QUERY = `
  query ProjectWorkspace($projectId: ID!, $limit: Int, $offset: Int) {
    project(projectId: $projectId) { 
    id 
    name 
    description 
    rag_strategy 
    created_at 
    updated_at 
    }
    documents(projectId: $projectId, limit: $limit, offset: $offset) {
      id 
      file_name 
      file_size 
      processing_status 
      processing_error 
      created_at
    }
    conversations(projectId: $projectId, limit: $limit, offset: $offset) { 
      id 
      title 
      updated_at 
    }
    projectIndexTreeStatus(projectId: $projectId) { 
    status 
    progress 
    error_message 
    updated_at 
    }
  }
`;
