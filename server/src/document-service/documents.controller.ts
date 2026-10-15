import {
  Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, Req,
  UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ClerkAuthGuard } from '../auth/auth.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { DocumentsService } from './documents.service.js';
import { UploadService } from './upload.service.js';

@Controller()
@UseGuards(ClerkAuthGuard)
export class DocumentsController {
  constructor(
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(UploadService) private readonly uploads: UploadService,
  ) {}

  @Post('projects/:projectId/documents')
  @HttpCode(202)
  @UseInterceptors(FileInterceptor('pdf', {
    storage: memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  }))
  upload(
    @Req() request: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    return this.uploads.upload(file, request.user.clerkId, projectId);
  }

  @Get('projects/:projectId/documents')
  async list(
    @Req() request: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const documents = await this.documents.list(request.user.clerkId, projectId, Number(limit) || 50, Number(offset) || 0);
    return documents.map(({ storage_path: _storagePath, ...document }) => document);
  }

  @Get('projects/:projectId/documents/:documentId')
  async get(
    @Req() request: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('documentId') documentId: string,
  ) {
    const { storage_path: _storagePath, ...document } = await this.documents.get(request.user.clerkId, projectId, documentId);
    return document;
  }

  @Delete('projects/:projectId/documents/:documentId')
  @HttpCode(204)
  delete(
    @Req() request: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('documentId') documentId: string,
  ) {
    return this.uploads.deleteDocument(request.user.clerkId, projectId, documentId);
  }

  @Get('upload/status/:jobId')
  status(@Req() request: AuthenticatedRequest, @Param('jobId') jobId: string) {
    return this.uploads.getStatus(jobId, request.user.clerkId);
  }
}