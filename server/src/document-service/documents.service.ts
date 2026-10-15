import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../database/supabase.service.js';
import { assertUuid } from '../shared-utils/validation.utils.js';
import { pageSize } from '../shared-utils/pagination.utils.js';
import { ProjectsService } from '../project-service/projects.service.js';
import type { ProjectDocument } from '../entities/project-document.entity.js';

@Injectable()
export class DocumentsService {
  constructor(
    @Inject(SupabaseService) private readonly supabase: SupabaseService,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
  ) {}

  async list(ownerId: string, projectId: string, limit = 50, offset = 0): Promise<ProjectDocument[]> {
    await this.projects.get(ownerId, projectId);
    return this.listInVerifiedProject(ownerId, projectId, limit, offset);
  }

  async listInVerifiedProject(ownerId: string, projectId: string, limit = 50, offset = 0): Promise<ProjectDocument[]> {
    return this.supabase.select<ProjectDocument>('documents', new URLSearchParams({
      project_id: `eq.${projectId}`,
      owner_clerk_id: `eq.${ownerId}`,
      select: '*',
      order: 'created_at.desc',
      limit: String(pageSize(limit)),
      offset: String(Math.max(0, offset)),
    }));
  }

  async get(ownerId: string, projectId: string, documentId: string): Promise<ProjectDocument> {
    await this.projects.get(ownerId, projectId);
    assertUuid(documentId, 'Document ID');
    const rows = await this.supabase.select<ProjectDocument>('documents', new URLSearchParams({
      id: `eq.${documentId}`,
      project_id: `eq.${projectId}`,
      owner_clerk_id: `eq.${ownerId}`,
      select: '*',
      limit: '1',
    }));
    if (!rows[0]) throw new NotFoundException('Document not found.');
    return rows[0];
  }

  async previewUrl(ownerId: string, projectId: string, documentId: string, pageNumber: number): Promise<string> {
    const document = await this.get(ownerId, projectId, documentId);
    const signedUrl = await this.supabase.createSignedObjectUrl(document.storage_path);
    return `${signedUrl}#page=${Math.max(1, Math.floor(pageNumber))}&toolbar=0`;
  }

  async removeRow(ownerId: string, projectId: string, documentId: string): Promise<void> {
    await this.get(ownerId, projectId, documentId);
    await this.supabase.delete('documents', new URLSearchParams({
      id: `eq.${documentId}`,
      project_id: `eq.${projectId}`,
      owner_clerk_id: `eq.${ownerId}`,
    }));
  }
}