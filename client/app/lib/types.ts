export interface Project {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceProject extends Project {
  rag_strategy: "vector" | "index_tree";
}

export interface ProjectIndexTreeStatus {
  status: "pending" | "processing" | "completed" | "failed";
  progress: number | null;
  error_message: string | null;
  updated_at: string;
}

export interface ProjectDocument {
  id: string;
  file_name: string;
  file_size: number;
  processing_status: "pending" | "processing" | "completed" | "failed";
  processing_error: string | null;
  created_at: string;
}

export interface Conversation {
  id: string;
  title: string;
  updated_at: string;
}

export interface ProjectWorkspace {
  project: WorkspaceProject;
  documents: ProjectDocument[];
  conversations: Conversation[];
  projectIndexTreeStatus: ProjectIndexTreeStatus | null;
}

export interface StoredSource {
  source?: string;
  section_title?: string;
  page?: number;
  source_order?: number;
  preview_url?: string;
  content?: string;
  excerpt?: string;
}

export interface StoredMessage {
  id: string;
  role: "assistant" | "user";
  content: string;
  metadata?: {
    rag_strategy?: "vector" | "index_tree";
    sources?: StoredSource[];
  };
}

