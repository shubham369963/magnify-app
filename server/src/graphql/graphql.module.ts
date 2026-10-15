import { join } from 'node:path';
import type { Request } from 'express';
import { Module } from '@nestjs/common';
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { GraphQLModule } from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';
import { ConversationsModule } from '../conversation-service/conversations.module.js';
import { DocumentsModule } from '../document-service/documents.module.js';
import { ProjectsModule } from '../project-service/projects.module.js';
import { WorkspaceResolver } from './workspace.resolver.js';
import { createGraphqlMetricsPlugin } from '../observability/graphql-metrics.plugin.js';

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      typePaths: [join(process.cwd(), 'src/graphql/schema.graphql')],
      resolvers: { JSON: GraphQLJSON },
      context: ({ req }: { req: Request }) => ({ req }),
      plugins: [createGraphqlMetricsPlugin() as NonNullable<ApolloDriverConfig['plugins']>[number]],
      sortSchema: true,
      playground: false,
    }),
    ProjectsModule,
    DocumentsModule,
    ConversationsModule,
  ],
  providers: [WorkspaceResolver],
})
export class WorkspaceGraphQLModule {}