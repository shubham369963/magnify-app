import { Global, Module } from '@nestjs/common';
import { ClerkAuthGuard } from './auth.guard.js';

@Global()
@Module({ providers: [ClerkAuthGuard], exports: [ClerkAuthGuard] })
export class AuthModule {}