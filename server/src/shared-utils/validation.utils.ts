import { BadRequestException } from '@nestjs/common';

export function validateName(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120) {
    throw new BadRequestException(`${field} must be between 1 and 120 characters.`);
  }
  return value.trim();
}

export function assertUuid(value: string, field: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new BadRequestException(`${field} must be a UUID.`);
  }
}