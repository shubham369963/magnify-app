export const CREATE_PROJECT_MUTATION = `
  mutation CreateProject($name: String!, $description: String) {
    createProject(name: $name, description: $description) { id name description created_at updated_at }
  }
`;