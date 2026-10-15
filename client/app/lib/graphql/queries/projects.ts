export const PROJECTS_QUERY = `
  query Projects($limit: Int, $offset: Int) {
    projects(limit: $limit, offset: $offset) { 
    id 
    name 
    description 
    created_at 
    updated_at 
    }
  }
`;

export const PROJECTS_VARIABLES = { limit: 50, offset: 0 };
