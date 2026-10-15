import { Controller, Get, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { ClerkAuthGuard } from '../auth/auth.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { ChatService } from './chat.service.js';

@Controller('chat')
@UseGuards(ClerkAuthGuard)
export class ChatController {
  constructor(@Inject(ChatService) private readonly chat: ChatService) {}

  @Get()
  ask(
    @Req() request: AuthenticatedRequest,
    @Query('message') message: string | undefined,
    @Query('projectId') projectId: string,
    @Query('conversationId') conversationId: string,
  ) {
    return this.chat.chat(message, request.user.clerkId, projectId, conversationId);
  }
}