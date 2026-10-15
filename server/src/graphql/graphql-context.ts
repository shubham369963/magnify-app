import type { Request } from 'express';

export interface GraphQLContext {
  req: Request & { user?: { clerkId: string } };
  user?: { clerkId: string };
}