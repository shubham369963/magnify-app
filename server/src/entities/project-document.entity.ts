import type { DocumentProcessingStatus } from '../enums/document-processing-status.enum.js';

export interface ProjectDocument {
  id: string;
  project_id: string;
  owner_clerk_id: string;
  file_name: string;
  storage_path: string;
  mime_type: string;
  file_size: number;
  checksum: string | null;
  processing_status: DocumentProcessingStatus;
  processing_error: string | null;
  created_at: string;
  updated_at: string;
}