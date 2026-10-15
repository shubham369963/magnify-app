import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { ClerkWebhookController } from './auth/clerk-webhook.controller.js';
import { AuthModule } from './auth/auth.module.js';
import { DatabaseModule } from './database/database.module.js';
import { ProjectsModule } from './project-service/projects.module.js';
import { DocumentsModule } from './document-service/documents.module.js';
import { ConversationsModule } from './conversation-service/conversations.module.js';
import { WorkspaceGraphQLModule } from './graphql/graphql.module.js';
import { MetricsController } from './observability/metrics.controller.js';

@Module({
  imports: [AuthModule, DatabaseModule, ProjectsModule, DocumentsModule, ConversationsModule, WorkspaceGraphQLModule],
  controllers: [HealthController, ClerkWebhookController, MetricsController],
})
export class AppModule {}