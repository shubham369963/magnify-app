import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from '@jest/globals';
import { UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../dist/app.module.js';
import { ClerkAuthGuard } from '../../dist/auth/auth.guard.js';
import { ProjectsService } from '../../dist/project-service/projects.service.js';

test('Clerk guard rejects requests without a bearer token', async () => {
  const guard = new ClerkAuthGuard();
  const context = {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({ path: '/projects', headers: {} }) }),
  };
  await assert.rejects(guard.canActivate(context), UnauthorizedException);
});

test('Clerk guard rejects unauthenticated GraphQL operations', async () => {
  const guard = new ClerkAuthGuard();
  const context = {
    getType: () => 'graphql',
    getArgs: () => [undefined, undefined, { req: { path: '/graphql', headers: {} } }, undefined],
    getClass: () => Object,
    getHandler: () => () => undefined,
  };
  await assert.rejects(guard.canActivate(context), UnauthorizedException);
});

test('Clerk guard exposes the verified identity on the GraphQL context', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const encodedHeader = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url');
  const encodedClaims = Buffer.from(JSON.stringify({
    sub: 'user_test',
    exp: Math.floor(Date.now() / 1000) + 60,
  })).toString('base64url');
  const signedValue = `${encodedHeader}.${encodedClaims}`;
  const signature = sign('RSA-SHA256', Buffer.from(signedValue), privateKey).toString('base64url');
  const request = {
    path: '/graphql',
    headers: { authorization: `Bearer ${signedValue}.${signature}` },
  };
  const graphQLContext = { req: request };
  const executionContext = {
    getType: () => 'graphql',
    getArgs: () => [undefined, undefined, graphQLContext, undefined],
    getClass: () => Object,
    getHandler: () => () => undefined,
  };
  const previousFetch = globalThis.fetch;
  const previousJwksUrl = process.env.CLERK_JWKS_URL;
  const previousIssuer = process.env.CLERK_ISSUER;
  const previousAudience = process.env.CLERK_AUDIENCE;

  process.env.CLERK_JWKS_URL = 'http://localhost/jwks';
  delete process.env.CLERK_ISSUER;
  delete process.env.CLERK_AUDIENCE;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
  try {
    assert.equal(await new ClerkAuthGuard().canActivate(executionContext), true);
    assert.deepEqual(graphQLContext.user, { clerkId: 'user_test' });
    assert.deepEqual(request.user, { clerkId: 'user_test' });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousJwksUrl === undefined) delete process.env.CLERK_JWKS_URL;
    else process.env.CLERK_JWKS_URL = previousJwksUrl;
    if (previousIssuer === undefined) delete process.env.CLERK_ISSUER;
    else process.env.CLERK_ISSUER = previousIssuer;
    if (previousAudience === undefined) delete process.env.CLERK_AUDIENCE;
    else process.env.CLERK_AUDIENCE = previousAudience;
  }
});

test('authenticated GraphQL project query receives Clerk identity through Nest guards', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'graphql-test-key', alg: 'RS256', use: 'sig' };
  const encodedHeader = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'graphql-test-key' })).toString('base64url');
  const encodedClaims = Buffer.from(JSON.stringify({
    sub: 'user_test',
    exp: Math.floor(Date.now() / 1000) + 60,
  })).toString('base64url');
  const signedValue = `${encodedHeader}.${encodedClaims}`;
  const signature = sign('RSA-SHA256', Buffer.from(signedValue), privateKey).toString('base64url');
  const previousFetch = globalThis.fetch;
  const previousJwksUrl = process.env.CLERK_JWKS_URL;
  const previousIssuer = process.env.CLERK_ISSUER;
  const previousAudience = process.env.CLERK_AUDIENCE;
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ProjectsService)
    .useValue({ list: async (ownerId) => [{ id: 'project-id', name: ownerId }] })
    .compile();
  const app = module.createNestApplication();
  let guardCalls = 0;
  let guardRequestPath;
  let guardedContextUser;

  process.env.CLERK_JWKS_URL = 'http://localhost/jwks';
  delete process.env.CLERK_ISSUER;
  delete process.env.CLERK_AUDIENCE;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
  try {
    await app.init();
    const guard = app.get(ClerkAuthGuard);
    const canActivate = guard.canActivate.bind(guard);
    guard.canActivate = async (context) => {
      guardCalls += 1;
      const graphQLContext = context.getArgs()?.[2];
      guardRequestPath = graphQLContext?.req?.path;
      const allowed = await canActivate(context);
      guardedContextUser = graphQLContext?.user?.clerkId;
      return allowed;
    };
    const response = await request(app.getHttpServer())
      .post('/graphql')
      .set('authorization', `Bearer ${signedValue}.${signature}`)
      .send({ query: '{ projects { id name } }' })
      .expect(200);
    assert.equal(guardCalls, 1, JSON.stringify(response.body));
    assert.deepEqual({ guardRequestPath, guardedContextUser }, {
      guardRequestPath: '/',
      guardedContextUser: 'user_test',
    });
    assert.deepEqual(
      response.body.data?.projects,
      [{ id: 'project-id', name: 'user_test' }],
      JSON.stringify(response.body),
    );
  } finally {
    await app.close();
    globalThis.fetch = previousFetch;
    if (previousJwksUrl === undefined) delete process.env.CLERK_JWKS_URL;
    else process.env.CLERK_JWKS_URL = previousJwksUrl;
    if (previousIssuer === undefined) delete process.env.CLERK_ISSUER;
    else process.env.CLERK_ISSUER = previousIssuer;
    if (previousAudience === undefined) delete process.env.CLERK_AUDIENCE;
    else process.env.CLERK_AUDIENCE = previousAudience;
  }
});