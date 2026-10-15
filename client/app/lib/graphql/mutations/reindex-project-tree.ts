export const REINDEX_PROJECT_TREE_MUTATION = `
  mutation ReindexProjectTree($projectId: ID!) { reindexProjectTree(projectId: $projectId) }
`;