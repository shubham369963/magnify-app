import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { createPublicKey, type JsonWebKey, verify } from 'node:crypto';
import type { Request } from 'express';

interface ClerkClaims {
  sub?: string;
  exp?: number;
  nbf?: number;
  iss?: string;
  aud?: string | string[];
}

interface AuthenticatedRequest extends Request {
  user?: { clerkId: string };
}

interface AuthenticatedGraphQLContext {
  req: AuthenticatedRequest;
  user?: { clerkId: string };
}

interface JwksResponse {
  keys?: Array<JsonWebKey & { kid?: string; alg?: string; use?: string }>;
}

@Injectable()
export class ClerkAuthGuard implements CanActivate {
  private keys: NonNullable<JwksResponse['keys']> = [];
  private keysFetchedAt = 0;

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const graphQLContext = context.getType<string>() === 'graphql'
      ? GqlExecutionContext.create(context).getContext<AuthenticatedGraphQLContext>()
      : undefined;
    const request = graphQLContext
      ? graphQLContext.req
      : context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) throw new UnauthorizedException('A Clerk bearer token is required.');

    const jwksUrl = process.env.CLERK_JWKS_URL;
    if (!jwksUrl) throw new ServiceUnavailableException('Clerk token verification is not configured.');

    const parts = token.split('.');
    if (parts.length !== 3) throw new UnauthorizedException('Invalid bearer token.');
    const [encodedHeader, encodedClaims, encodedSignature] = parts;
    if (!encodedHeader || !encodedClaims || !encodedSignature) {
      throw new UnauthorizedException('Invalid bearer token.');
    }

    let header: { alg?: string; kid?: string };
    let claims: ClerkClaims;
    try {
      header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(encodedClaims, 'base64url').toString('utf8'));
    } catch {
      throw new UnauthorizedException('Invalid bearer token.');
    }
    if (header.alg !== 'RS256' || !header.kid || typeof claims.sub !== 'string') {
      throw new UnauthorizedException('Unsupported or invalid bearer token.');
    }

    const key = await this.getKey(jwksUrl, header.kid);
    const validSignature = verify(
      'RSA-SHA256',
      Buffer.from(`${encodedHeader}.${encodedClaims}`),
      createPublicKey({ key, format: 'jwk' }),
      Buffer.from(encodedSignature, 'base64url'),
    );
    const now = Math.floor(Date.now() / 1000);
    const expectedIssuer = process.env.CLERK_ISSUER?.trim();
    const expectedAudience = process.env.CLERK_AUDIENCE?.trim();
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!validSignature) {
      throw new UnauthorizedException('Invalid bearer token signature. Check that CLERK_JWKS_URL belongs to the Clerk instance that issued the token.');
    }
    if (typeof claims.exp !== 'number' || claims.exp <= now || (typeof claims.nbf === 'number' && claims.nbf > now)) {
      throw new UnauthorizedException('Bearer token is expired or not yet valid. Refresh the Clerk session and check server clock synchronization.');
    }
    if (expectedIssuer && claims.iss !== expectedIssuer) {
      throw new UnauthorizedException('Bearer token issuer does not match CLERK_ISSUER.');
    }
    if (expectedAudience && !audiences.includes(expectedAudience)) {
      throw new UnauthorizedException('Bearer token audience does not match CLERK_AUDIENCE. The frontend requests the default Clerk session token; clear CLERK_AUDIENCE unless a configured JWT template emits that audience.');
    }

    const user = { clerkId: claims.sub };
    request.user = user;
    if (graphQLContext) graphQLContext.user = user;
    return true;
  }

  private async getKey(jwksUrl: string, kid: string): Promise<JsonWebKey> {
    if (!this.keys.length || Date.now() - this.keysFetchedAt > 60 * 60 * 1000) {
      await this.refreshKeys(jwksUrl);
    }
    let key = this.keys.find((candidate) => candidate.kid === kid && candidate.alg === 'RS256');
    if (!key) {
      await this.refreshKeys(jwksUrl);
      key = this.keys.find((candidate) => candidate.kid === kid && candidate.alg === 'RS256');
    }
    if (!key) throw new UnauthorizedException('Bearer token signing key is unknown.');
    return key;
  }

  private async refreshKeys(jwksUrl: string): Promise<void> {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(jwksUrl);
    } catch {
      throw new ServiceUnavailableException('Clerk JWKS URL is invalid.');
    }
    if (parsedUrl.protocol !== 'https:' && parsedUrl.hostname !== 'localhost') {
      throw new ServiceUnavailableException('Clerk JWKS URL must use HTTPS.');
    }
    try {
      const response = await fetch(parsedUrl, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`JWKS request failed (${response.status}).`);
      const jwks = await response.json() as JwksResponse;
      this.keys = jwks.keys ?? [];
      this.keysFetchedAt = Date.now();
    } catch {
      throw new ServiceUnavailableException('Unable to load Clerk verification keys.');
    }
  }
}