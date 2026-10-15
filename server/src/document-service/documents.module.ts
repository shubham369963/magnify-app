import { Module } from '@nestjs/common';
import { ProjectsModule } from '../project-service/projects.module.js';
import { PdfProcessingModule } from './pdf-processing.module.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';
import { UploadService } from './upload.service.js';
import { DatabaseModule } from '../database/database.module.js';

@Module({
  imports: [DatabaseModule, ProjectsModule, PdfProcessingModule],
  controllers: [DocumentsController],
  providers: [DocumentsService, UploadService],
  exports: [DocumentsService, UploadService],
})
export class DocumentsModule {}