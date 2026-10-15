export interface Project {
  id: string;
  owner_clerk_id: string;
  name: string;
  description: string | null;
  rag_strategy: 'vector' | 'index_tree';
  created_at: string;
  updated_at: string;
}