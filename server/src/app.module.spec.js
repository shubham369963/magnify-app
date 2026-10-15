import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from '@jest/globals';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);

for (const mode of ['src', 'dist']) {
  test(`services are injected in ${mode === 'src' ? 'tsx development' : 'compiled production'}`, () => {
    const extension = mode === 'src' ? 'ts' : 'js';
    const moduleUrl = (name) => new URL(`${mode}/${name}.${extension}`, root).href;
    const code = `
      import 'reflect-metadata';
      import assert from 'node:assert/strict';
      import { BadRequestException } from '@nestjs/common';
      import { Test } from '@nestjs/testing';
      import { ProjectsController } from '${moduleUrl('project-service/projects.controller')}';
      import { ProjectsService } from '${moduleUrl('project-service/projects.service')}';
      import { DocumentsController } from '${moduleUrl('document-service/documents.controller')}';
      import { DocumentsService } from '${moduleUrl('document-service/documents.service')}';
      import { UploadService } from '${moduleUrl('document-service/upload.service')}';
      import { ChatController } from '${moduleUrl('chat-service/chat.controller')}';
      import { ChatService } from '${moduleUrl('chat-service/chat.service')}';
      import { PdfService } from '${moduleUrl('document-service/pdf.service')}';
      import { PdfWorker } from '${moduleUrl('worker-node/worker.module')}';
      import { ConversationsService } from '${moduleUrl('conversation-service/conversations.service')}';
      import { WorkspaceResolver } from '${moduleUrl('graphql/workspace.resolver')}';
      import { SupabaseService } from '${moduleUrl('database/supabase.service')}';
      import { AppModule } from '${moduleUrl('app.module')}';
      import { WorkerModule } from '${moduleUrl('worker-node/worker.module')}';

      const chatService = { chat: async (message) => ({ message, docs: [] }) };
      const projectsService = {
        create: async (_owner, name) => ({ id: 'project-id', name }),
        list: async (ownerId, limit, offset) => [{ ownerId, limit, offset }],
      };
      const documentsService = {};
      const uploadService = {
        upload: async (file) => ({ filename: file.originalname }),
        getStatus: async (jobId) => ({ jobId, status: 'completed', progress: { percentage: 100 } }),
      };
      const pdfService = { process: async () => undefined };
      const fakeSupabase = {
        insert: async (table, values) => [{ id: 'project-id', ...values }],
      };
      const module = await Test.createTestingModule({
        controllers: [ProjectsController, DocumentsController, ChatController],
        providers: [
          { provide: ProjectsService, useValue: projectsService },
          { provide: DocumentsService, useValue: documentsService },
          { provide: ChatService, useValue: chatService },
          { provide: UploadService, useValue: uploadService },
          { provide: ConversationsService, useValue: {} },
          { provide: PdfService, useValue: pdfService },
          WorkspaceResolver,
          PdfWorker,
        ],
      }).compile();
      const projectsModule = await Test.createTestingModule({
        providers: [ProjectsService, { provide: SupabaseService, useValue: fakeSupabase }],
      }).compile();
      const applicationGraph = await Test.createTestingModule({ imports: [AppModule] }).compile();
      const workerGraph = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
      try {
        const createdProject = await projectsModule.get(ProjectsService).create('user_test', 'Test project');
        assert.equal(createdProject.name, 'Test project');
        const projectsController = module.get(ProjectsController);
        const documentsController = module.get(DocumentsController);
        const chatController = module.get(ChatController);
        const workspaceResolver = module.get(WorkspaceResolver);
        const request = { user: { clerkId: 'user_test' } };
        assert.deepEqual(
          await workspaceResolver.projects({ user: request.user, req: {} }, 10, 3),
          [{ ownerId: 'user_test', limit: 10, offset: 3 }],
        );
        assert.deepEqual(await projectsController.create(request, { name: 'New project' }), { id: 'project-id', name: 'New project' });
        assert.deepEqual(await chatController.ask(request, 'Question', 'project-1', 'conversation-1'), { message: 'Question', docs: [] });
        assert.deepEqual(await documentsController.upload(request, 'project-1', { originalname: 'test.pdf' }), { filename: 'test.pdf' });
        assert.deepEqual(await documentsController.status(request, 'job-123'), {
          jobId: 'job-123', status: 'completed', progress: { percentage: 100 },
        });
        assert.equal(module.get(PdfWorker).pdfService, pdfService);

        const chat = new ChatService({}, {});
        await assert.rejects(chat.chat(undefined, 'user_test', 'project-1', 'conversation-1'), (error) =>
          error instanceof BadRequestException && error.getStatus() === 400,
        );
        await assert.rejects(chat.chat('  ', 'user_test', 'project-1', 'conversation-1'), (error) =>
          error instanceof BadRequestException && error.getStatus() === 400,
        );
      } finally {
        await workerGraph.close();
        await applicationGraph.close();
        await projectsModule.close();
        await module.close();
      }
    `;
    const flags = mode === 'src' ? ['--import', 'tsx'] : [];
    const result = spawnSync(process.execPath, [...flags, '--input-type=module', '--eval', code], {
      cwd: fileURLToPath(root),
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  });
}