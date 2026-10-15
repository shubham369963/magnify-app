import { Body, Controller, Delete, Get, HttpCode, Inject, Patch, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ClerkAuthGuard } from '../auth/auth.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { ProjectsService } from './projects.service.js';

@Controller('projects')
@UseGuards(ClerkAuthGuard)
export class ProjectsController {
  constructor(@Inject(ProjectsService) private readonly projects: ProjectsService) {}

  @Post()
  create(@Req() request: AuthenticatedRequest, @Body() body: Record<string, unknown>) {
    return this.projects.create(request.user.clerkId, body.name, body.description);
  }

  @Get()
  list(@Req() request: AuthenticatedRequest, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.projects.list(request.user.clerkId, Number(limit) || 50, Number(offset) || 0);
  }

  @Get(':projectId')
  get(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.projects.get(request.user.clerkId, projectId);
  }

  @Patch(':projectId')
  update(
    @Req() request: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.projects.update(request.user.clerkId, projectId, body);
  }

  @Delete(':projectId')
  @HttpCode(204)
  delete(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.projects.delete(request.user.clerkId, projectId);
  }
}