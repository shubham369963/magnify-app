import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { deleteDocumentVectors, deleteUserVectors } from '../config/settings.js';
import { deleteVectorIndexCheckpoint } from '../document-service/vector-index-checkpoint.js';
import { SupabaseService } from '../database/supabase.service.js';
import type { Project } from '../entities/project.entity.js';
import type { ProjectDocument } from '../entities/project-document.entity.js';
import { assertUuid, validateName } from '../shared-utils/validation.utils.js';
import { pageSize } from '../shared-utils/pagination.utils.js';
import { withOperationLog } from '../shared-utils/operation-logger.js';

@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

  constructor(@Inject(SupabaseService) private readonly supabase: SupabaseService) {}

  async list(ownerId: string, limit = 50, offset = 0): Promise<Project[]> {
    return this.supabase.select<Project>('projects', new URLSearchParams({
      owner_clerk_id: `eq.${ownerId}`,
      select: '*',
      order: 'updated_at.desc',
      limit: String(pageSize(limit)),
      offset: String(Math.max(0, offset)),
    }));
  }

  async create(ownerId: string, name: unknown, description?: unknown): Promise<Project> {
    return withOperationLog(this.logger, 'project.create', { ownerId }, async () => {
      const cleanName = validateName(name, 'Project name');
      if (description !== undefined && description !== null && typeof description !== 'string') {
        throw new BadRequestException('Project description must be a string.');
      }
      const rows = await this.supabase.insert<Project>('projects', {
        owner_clerk_id: ownerId,
        name: cleanName,
        description: typeof description === 'string' && description.trim() ? description.trim() : null,
      });
      return rows[0];
    }, (project) => ({ projectId: project.id }));
  }

  async get(ownerId: string, projectId: string): Promise<Project> {
    assertUuid(projectId, 'Project ID');
    const rows = await this.supabase.select<Project>('projects', new URLSearchParams({
      id: `eq.${projectId}`,
      owner_clerk_id: `eq.${ownerId}`,
      select: '*',
      limit: '1',
    }));
    if (!rows[0]) throw new NotFoundException('Project not found.');
    return rows[0];
  }

  async update(ownerId: string, projectId: string, values: Record<string, unknown>): Promise<Project> {
    return withOperationLog(this.logger, 'project.update', {
      ownerId,
      projectId,
      fields: ['name', 'description', 'ragStrategy'].filter((field) => field in values).join(','),
    }, async () => {
      await this.get(ownerId, projectId);
      const update: Record<string, unknown> = {};
      if ('name' in values) update.name = validateName(values.name, 'Project name');
      if ('description' in values) {
        if (values.description !== null && typeof values.description !== 'string') {
          throw new BadRequestException('Project description must be a string or null.');
        }
        update.description = typeof values.description === 'string' && values.description.trim()
          ? values.description.trim()
          : null;
      }
      if ('ragStrategy' in values) {
        if (values.ragStrategy !== 'vector' && values.ragStrategy !== 'index_tree') {
          throw new BadRequestException('RAG strategy must be vector or index_tree.');
        }
        update.rag_strategy = values.ragStrategy;
      }
      if (!Object.keys(update).length) throw new BadRequestException('Provide a project name or description.');
      update.updated_at = new Date().toISOString();
      const rows = await this.supabase.update<Project>('projects', new URLSearchParams({
        id: `eq.${projectId}`,
        owner_clerk_id: `eq.${ownerId}`,
      }), update);
      if (!rows[0]) throw new NotFoundException('Project not found.');
      return rows[0];
    });
  }

  async delete(ownerId: string, projectId: string): Promise<void> {
    return withOperationLog(this.logger, 'project.delete', { ownerId, projectId }, async () => {
      await this.get(ownerId, projectId);
      const documents = await this.supabase.select<Pick<ProjectDocument, 'id' | 'storage_path'>>(
        'documents',
        new URLSearchParams({ project_id: `eq.${projectId}`, owner_clerk_id: `eq.${ownerId}`, select: 'id,storage_path' }),
      );
      for (const document of documents) {
        await deleteDocumentVectors(document.id);
        await this.supabase.deleteObject(document.storage_path);
        await deleteVectorIndexCheckpoint(document.id);
      }
      await this.supabase.delete('projects', new URLSearchParams({ id: `eq.${projectId}`, owner_clerk_id: `eq.${ownerId}` }));
    });
  }

  async deleteUserData(ownerId: string): Promise<void> {
    // The owner id becomes a storage prefix; reject anything that could widen it to other users.
    if (!/^[A-Za-z0-9_-]+$/.test(ownerId)) throw new BadRequestException('Clerk user ID is invalid.');
    return withOperationLog(this.logger, 'user_data.delete', { ownerId }, async () => {
      const pageLimit = 500;
      const storagePaths = new Set<string>();
      let lastId: string | undefined;
      for (;;) {
        const query = new URLSearchParams({
          owner_clerk_id: `eq.${ownerId}`,
          select: 'id,storage_path',
          order: 'id.asc',
          limit: String(pageLimit),
        });
        if (lastId) query.set('id', `gt.${lastId}`);
        const documents = await this.supabase.select<Pick<ProjectDocument, 'id' | 'storage_path'>>('documents', query);
        for (const document of documents) {
          storagePaths.add(document.storage_path);
          await deleteVectorIndexCheckpoint(document.id);
        }
        if (documents.length < pageLimit) break;
        lastId = documents.at(-1)!.id;
      }
      // Also remove objects left behind by interrupted uploads or deletions.
      for (const path of await this.supabase.listObjectPaths(ownerId)) storagePaths.add(path);
      await this.supabase.deleteObjects([...storagePaths]);
      // Cascades to documents, conversations, messages, and every index-tree table.
      await this.supabase.delete('projects', new URLSearchParams({ owner_clerk_id: `eq.${ownerId}` }));
      await deleteUserVectors(ownerId);
    });
  }
}