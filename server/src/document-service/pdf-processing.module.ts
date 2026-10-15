import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { PdfService } from './pdf.service.js';

@Module({ imports: [DatabaseModule], providers: [PdfService], exports: [PdfService] })
export class PdfProcessingModule {}