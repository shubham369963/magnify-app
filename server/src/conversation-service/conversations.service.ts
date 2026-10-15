import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { SupabaseService } from "../database/supabase.service.js";
import { ProjectsService } from "../project-service/projects.service.js";
import { DocumentsService } from "../document-service/documents.service.js";
import { assertUuid, validateName } from "../shared-utils/validation.utils.js";
import { pageSize } from "../shared-utils/pagination.utils.js";
import type { Conversation } from "../entities/conversation.entity.js";
import type { ChatMessage } from "../entities/chat-message.entity.js";
import { withOperationLog } from "../shared-utils/operation-logger.js";

@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);

  constructor(
    @Inject(SupabaseService) private readonly supabase: SupabaseService,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
  ) {}

  async create(
    ownerId: string,
    projectId: string,
    title?: unknown,
  ): Promise<Conversation> {
    return withOperationLog(
      this.logger,
      "conversation.create",
      { ownerId, projectId },
      async () => {
        await this.projects.get(ownerId, projectId);
        const cleanTitle =
          title === undefined
            ? "New conversation"
            : validateName(title, "Conversation title");
        const rows = await this.supabase.insert<Conversation>("conversations", {
          owner_clerk_id: ownerId,
          project_id: projectId,
          title: cleanTitle,
        });
        return rows[0];
      },
      (conversation) => ({ conversationId: conversation.id }),
    );
  }

  async list(
    ownerId: string,
    projectId: string,
    limit = 50,
    offset = 0,
  ): Promise<Conversation[]> {
    await this.projects.get(ownerId, projectId);
    return this.supabase.select<Conversation>(
      "conversations",
      new URLSearchParams({
        project_id: `eq.${projectId}`,
        owner_clerk_id: `eq.${ownerId}`,
        select: "*",
        order: "updated_at.desc",
        limit: String(pageSize(limit)),
        offset: String(Math.max(0, offset)),
      }),
    );
  }

  async get(
    ownerId: string,
    projectId: string,
    conversationId: string,
  ): Promise<Conversation> {
    await this.projects.get(ownerId, projectId);
    return this.getInVerifiedProject(ownerId, projectId, conversationId);
  }

  async getInVerifiedProject(
    ownerId: string,
    projectId: string,
    conversationId: string,
  ): Promise<Conversation> {
    assertUuid(conversationId, "Conversation ID");
    const rows = await this.supabase.select<Conversation>(
      "conversations",
      new URLSearchParams({
        id: `eq.${conversationId}`,
        project_id: `eq.${projectId}`,
        owner_clerk_id: `eq.${ownerId}`,
        select: "*",
        limit: "1",
      }),
    );
    if (!rows[0]) throw new NotFoundException("Conversation not found.");
    return rows[0];
  }

  async update(
    ownerId: string,
    projectId: string,
    conversationId: string,
    title: unknown,
  ): Promise<Conversation> {
    return withOperationLog(
      this.logger,
      "conversation.update",
      { ownerId, projectId, conversationId },
      async () => {
        await this.get(ownerId, projectId, conversationId);
        const rows = await this.supabase.update<Conversation>(
          "conversations",
          new URLSearchParams({
            id: `eq.${conversationId}`,
            project_id: `eq.${projectId}`,
            owner_clerk_id: `eq.${ownerId}`,
          }),
          {
            title: validateName(title, "Conversation title"),
            updated_at: new Date().toISOString(),
          },
        );
        if (!rows[0]) throw new NotFoundException("Conversation not found.");
        return rows[0];
      },
    );
  }

  async delete(
    ownerId: string,
    projectId: string,
    conversationId: string,
  ): Promise<void> {
    return withOperationLog(
      this.logger,
      "conversation.delete",
      { ownerId, projectId, conversationId },
      async () => {
        await this.get(ownerId, projectId, conversationId);
        await this.supabase.delete(
          "conversations",
          new URLSearchParams({
            id: `eq.${conversationId}`,
            project_id: `eq.${projectId}`,
            owner_clerk_id: `eq.${ownerId}`,
          }),
        );
      },
    );
  }

  async listMessages(
    ownerId: string,
    projectId: string,
    conversationId: string,
  ): Promise<ChatMessage[]> {
    await this.get(ownerId, projectId, conversationId);
    const messages = await this.supabase.select<ChatMessage>(
      "messages",
      new URLSearchParams({
        conversation_id: `eq.${conversationId}`,
        select: "*",
        order: "sequence_number.asc",
      }),
    );
    return Promise.all(
      messages.map(async (message) => {
        const sources = Array.isArray(message.metadata.sources)
          ? message.metadata.sources
          : [];
        const resolvedSources = await Promise.all(
          sources.map(async (source) => {
            if (typeof source !== "object" || source === null) return source;
            const item = source as Record<string, unknown>;
            if (
              typeof item.document_id !== "string" ||
              typeof item.page !== "number"
            ) {
              return source;
            }
            try {
              return {
                ...item,
                preview_url: await this.documents.previewUrl(
                  ownerId,
                  projectId,
                  item.document_id,
                  item.page,
                ),
              };
            } catch {
              return source;
            }
          }),
        );
        return {
          ...message,
          metadata: { ...message.metadata, sources: resolvedSources },
        };
      }),
    );
  }

  async recentMessages(
    ownerId: string,
    projectId: string,
    conversationId: string,
    limit = 20,
  ): Promise<ChatMessage[]> {
    await this.get(ownerId, projectId, conversationId);
    return this.readRecentMessages(conversationId, limit);
  }

  async recentMessagesInVerifiedConversation(
    conversationId: string,
    limit = 20,
  ): Promise<ChatMessage[]> {
    return this.readRecentMessages(conversationId, limit);
  }

  private async readRecentMessages(
    conversationId: string,
    limit: number,
  ): Promise<ChatMessage[]> {
    const rows = await this.supabase.select<ChatMessage>(
      "messages",
      new URLSearchParams({
        conversation_id: `eq.${conversationId}`,
        select: "*",
        order: "sequence_number.desc",
        limit: String(Math.min(Math.max(Math.floor(limit), 1), 50)),
      }),
    );
    return rows.reverse();
  }

  async saveExchange(
    ownerId: string,
    projectId: string,
    conversationId: string,
    question: string,
    answer: string,
    metadata: Record<string, unknown>,
  ): Promise<ChatMessage[]> {
    return withOperationLog(
      this.logger,
      "conversation.exchange.save",
      {
        ownerId,
        projectId,
        conversationId,
        ragStrategy:
          typeof metadata.rag_strategy === "string"
            ? metadata.rag_strategy
            : "unknown",
      },
      async () => {
        await this.get(ownerId, projectId, conversationId);
        return this.persistExchange(
          ownerId,
          projectId,
          conversationId,
          question,
          answer,
          metadata,
        );
      },
    );
  }

  async saveExchangeInVerifiedConversation(
    ownerId: string,
    projectId: string,
    conversationId: string,
    question: string,
    answer: string,
    metadata: Record<string, unknown>,
  ): Promise<ChatMessage[]> {
    return withOperationLog(
      this.logger,
      "conversation.exchange.save",
      {
        ownerId,
        projectId,
        conversationId,
        ragStrategy:
          typeof metadata.rag_strategy === "string"
            ? metadata.rag_strategy
            : "unknown",
      },
      () =>
        this.persistExchange(
          ownerId,
          projectId,
          conversationId,
          question,
          answer,
          metadata,
        ),
    );
  }

  private async persistExchange(
    ownerId: string,
    projectId: string,
    conversationId: string,
    question: string,
    answer: string,
    metadata: Record<string, unknown>,
  ): Promise<ChatMessage[]> {
    return this.supabase.rpc<ChatMessage[]>("save_chat_exchange", {
      p_owner_clerk_id: ownerId,
      p_project_id: projectId,
      p_conversation_id: conversationId,
      p_question: question,
      p_answer: answer,
      p_metadata: metadata,
    });
  }
}
