import { Controller, Get, Header } from '@nestjs/common';
import { metrics } from './metrics.js';

@Controller()
export class MetricsController {
  @Get('metrics')
  @Header('Content-Type', metrics.registry.contentType)
  scrape() {
    return metrics.registry.metrics();
  }
}