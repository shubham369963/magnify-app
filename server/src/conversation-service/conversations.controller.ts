import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ClerkAuthGuard } from '../auth/auth.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { ChatService } from '../chat-service/chat.service.js';
import { ConversationsService } from './conversations.service.js';

@Controller('projects/:projectId/conversations')
@UseGuards(ClerkAuthGuard)
export class ConversationsController {
  constructor(
    @Inject(ConversationsService) private readonly conversations: ConversationsService,
    @Inject(ChatService) private readonly chat: ChatService,
  ) {}

  @Post()
  create(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Body() body: Record<string, unknown>) {
    return this.conversations.create(request.user.clerkId, projectId, body.title);
  }

  @Get()
  list(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.conversations.list(request.user.clerkId, projectId, Number(limit) || 50, Number(offset) || 0);
  }

  @Get(':conversationId')
  get(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('conversationId') conversationId: string) {
    return this.conversations.get(request.user.clerkId, projectId, conversationId);
  }

  @Patch(':conversationId')
  update(
    @Req() request: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('conversationId') conversationId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.conversations.update(request.user.clerkId, projectId, conversationId, body.title);
  }

  @Delete(':conversationId')
  @HttpCode(204)
  delete(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('conversationId') conversationId: string) {
    return this.conversations.delete(request.user.clerkId, projectId, conversationId);
  }

  @Get(':conversationId/messages')
  listMessages(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('conversationId') conversationId: string) {
    return this.conversations.listMessages(request.user.clerkId, projectId, conversationId);
  }

  @Post(':conversationId/messages')
  postMessage(
    @Req() request: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('conversationId') conversationId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.chat.chat(typeof body.message === 'string' ? body.message : undefined, request.user.clerkId, projectId, conversationId);
  }

}