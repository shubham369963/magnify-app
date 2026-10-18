import { Args, Context, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { BadRequestException, Inject, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ClerkAuthGuard } from '../auth/auth.guard.js';
import { ChatService } from '../chat-service/chat.service.js';
import { ConversationsService } from '../conversation-service/conversations.service.js';
import { DocumentsService } from '../document-service/documents.service.js';
import { ProjectsService } from '../project-service/projects.service.js';
import { UploadService } from '../document-service/upload.service.js';
import type { GraphQLContext } from './graphql-context.js';

@Resolver()
@UseGuards(ClerkAuthGuard)
export class WorkspaceResolver {
  constructor(
    @Inject(ProjectsService) private readonly projectsService: ProjectsService,
    @Inject(DocumentsService) private readonly documentsService: DocumentsService,
    @Inject(ConversationsService) private readonly conversationsService: ConversationsService,
    @Inject(ChatService) private readonly chatService: ChatService,
    @Inject(UploadService) private readonly uploadService: UploadService,
  ) {}

  @Query('projects')
  projects(
    @Context() context: GraphQLContext,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
    @Args('offset', { type: () => Int, nullable: true }) offset?: number,
  ) {
    return this.projectsService.list(this.ownerId(context), limit, offset);
  }

  @Query('project')
  project(@Context() context: GraphQLContext, @Args('projectId', { type: () => ID }) projectId: string) {
    return this.projectsService.get(this.ownerId(context), projectId);
  }

  @Query('documents')
  documents(
    @Context() context: GraphQLContext,
    @Args('projectId', { type: () => ID }) projectId: string,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
    @Args('offset', { type: () => Int, nullable: true }) offset?: number,
  ) {
    return this.documentsService.list(this.ownerId(context), projectId, limit, offset);
  }

  @Query('conversations')
  conversations(
    @Context() context: GraphQLContext,
    @Args('projectId', { type: () => ID }) projectId: string,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
    @Args('offset', { type: () => Int, nullable: true }) offset?: number,
  ) {
    return this.conversationsService.list(this.ownerId(context), projectId, limit, offset);
  }

  @Query('conversation')
  conversation(
    @Context() context: GraphQLContext,
    @Args('projectId', { type: () => ID }) projectId: string,
    @Args('conversationId', { type: () => ID }) conversationId: string,
  ) {
    return this.conversationsService.get(this.ownerId(context), projectId, conversationId);
  }

  @Query('messages')
  messages(
    @Context() context: GraphQLContext,
    @Args('projectId', { type: () => ID }) projectId: string,
    @Args('conversationId', { type: () => ID }) conversationId: string,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
    @Args('offset', { type: () => Int, nullable: true }) offset?: number,
  ) {
    return this.conversationsService.listMessages(this.ownerId(context), projectId, conversationId, limit, offset);
  }

  @Query('uploadStatus')
  uploadStatus(@Context() context: GraphQLContext, @Args('jobId', { type: () => ID }) jobId: string) {
    return this.uploadService.getStatus(jobId, this.ownerId(context));
  }

  @Query('projectIndexTreeStatus')
  async projectIndexTreeStatus(@Context() context: GraphQLContext, @Args('projectId', { type: () => ID }) projectId: string) {
    const status = await this.uploadService.getProjectTreeStatus(this.ownerId(context), projectId);
    return status ? { ...status, progress: status.metadata?.percentage ?? null } : null;
  }

  @Mutation('createProject')
  createProject(
    @Context() context: GraphQLContext,
    @Args('name') name: string,
    @Args('description', { nullable: true }) description?: string,
  ) {
    return this.projectsService.create(this.ownerId(context), name, description);
  }

  @Mutation('updateProject')
  updateProject(
    @Context() context: GraphQLContext,
    @Args('projectId', { type: () => ID }) projectId: string,
    @Args('name', { nullable: true }) name?: string,
    @Args('description', { nullable: true }) description?: string | null,
    @Args('ragStrategy', { nullable: true }) ragStrategy?: string,
  ) {
    const values: Record<string, unknown> = {};
    if (name !== undefined) values.name = name;
    if (description !== undefined) values.description = description;
    if (ragStrategy !== undefined) {
      if (ragStrategy !== 'vector' && ragStrategy !== 'index_tree') {
        throw new BadRequestException('RAG strategy must be vector or index_tree.');
      }
      return this.uploadService.updateStrategy(this.ownerId(context), projectId, ragStrategy, values);
    }
    return this.projectsService.update(this.ownerId(context), projectId, values);
  }

  @Mutation('reindexProjectTree')
  async reindexProjectTree(@Context() context: GraphQLContext, @Args('projectId', { type: () => ID }) projectId: string) {
    await this.uploadService.reindexProjectTree(this.ownerId(context), projectId);
    return true;
  }

  @Mutation('deleteProject')
  async deleteProject(@Context() context: GraphQLContext, @Args('projectId', { type: () => ID }) projectId: string) {
    await this.projectsService.delete(this.ownerId(context), projectId);
    return true;
  }

  @Mutation('deleteDocument')
  async deleteDocument(
    @Context() context: GraphQLContext,
    @Args('projectId', { type: () => ID }) projectId: string,
    @Args('documentId', { type: () => ID }) documentId: string,
  ) {
    await this.uploadService.deleteDocument(this.ownerId(context), projectId, documentId);
    return true;
  }

  @Mutation('createConversation')
  createConversation(
    @Context() context: GraphQLContext,
    @Args('projectId', { type: () => ID }) projectId: string,
    @Args('title', { nullable: true }) title?: string,
  ) {
    return this.conversationsService.create(this.ownerId(context), projectId, title);
  }

  @Mutation('updateConversation')
  updateConversation(
    @Context() context: GraphQLContext,
    @Args('projectId', { type: () => ID }) projectId: string,
    @Args('conversationId', { type: () => ID }) conversationId: string,
    @Args('title') title: string,
  ) {
    return this.conversationsService.update(this.ownerId(context), projectId, conversationId, title);
  }

  @Mutation('deleteConversation')
  async deleteConversation(
    @Context() context: GraphQLContext,
    @Args('projectId', { type: () => ID }) projectId: string,
    @Args('conversationId', { type: () => ID }) conversationId: string,
  ) {
    await this.conversationsService.delete(this.ownerId(context), projectId, conversationId);
    return true;
  }

  @Mutation('sendMessage')
  async sendMessage(
    @Context() context: GraphQLContext,
    @Args('projectId', { type: () => ID }) projectId: string,
    @Args('conversationId', { type: () => ID }) conversationId: string,
    @Args('message') message: string,
  ) {
    const result = await this.chatService.chat(message, this.ownerId(context), projectId, conversationId);
    return {
      message: typeof result.message === 'string' ? result.message : JSON.stringify(result.message),
      ragStrategy: result.ragStrategy,
      inputTokens: result.tokenUsage?.inputTokens,
      outputTokens: result.tokenUsage?.outputTokens,
      sources: result.docs.map((document) => ({
        documentId: document.metadata.document_id,
        source: document.metadata.source,
        page: document.metadata.loc?.pageNumber,
        sourceOrder: document.metadata.source_order,
        sectionTitle: document.metadata.section_title,
        contentType: document.metadata.content_type,
        content: document.metadata.original_content ?? document.pageContent,
        excerpt: document.metadata.excerpt,
        previewUrl: document.metadata.preview_url,
      })),
    };
  }

  private ownerId(context: GraphQLContext): string {
    const ownerId = context.user?.clerkId ?? context.req.user?.clerkId;
    if (!ownerId) throw new UnauthorizedException('Authenticated Clerk identity is missing.');
    return ownerId;
  }
}