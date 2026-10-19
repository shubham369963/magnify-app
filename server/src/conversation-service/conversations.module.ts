import { Module } from '@nestjs/common';
import { DocumentsModule } from '../document-service/documents.module.js';
import { ProjectsModule } from '../project-service/projects.module.js';
import { ChatController } from '../chat-service/chat.controller.js';
import { ChatService } from '../chat-service/chat.service.js';
import { ConversationsController } from './conversations.controller.js';
import { ConversationsService } from './conversations.service.js';
import { DatabaseModule } from '../database/database.module.js';
import { CohereRerankerService } from '../chat-service/cohere-reranker.service.js';

@Module({
  imports: [DatabaseModule, ProjectsModule, DocumentsModule],
  controllers: [ConversationsController, ChatController],
  providers: [ConversationsService, ChatService, CohereRerankerService],
  exports: [ConversationsService, ChatService],
})
export class ConversationsModule {}