# NestJS PDF RAG Backend

Uses Yarn and Node 20.19+ locally, or Node 22 in Docker. The API listens on port
8000. BullMQ/Valkey queues PDF processing; Ollama Cloud provides chat and vision,
Google Gemini provides text embeddings; Qdrant stores vectors; and Supabase
stores relational data and private PDF files.

## Docker

```bash
cd server
yarn docker:up
```

Set `OLLAMA_API_KEY` and `GOOGLE_API_KEY` in `server/.env` before starting the
API. Ollama Cloud settings default to `https://ollama.com` and `gemma4:31b` for
both chat and vision. Google Gemini is used only for embeddings.

This builds the NestJS image and starts the API, worker, Valkey, and Qdrant.
Chat, image captioning, relevance selection, and index-tree generation use
Ollama Cloud. PDF ingestion and vector retrieval use Google's hosted
`gemini-embedding-2` model at 768 dimensions. Changing embedding providers
requires reindexing existing PDFs because vectors from different models are
incompatible.

API: http://localhost:8000. The frontend in `../client` uses this address.
`yarn docker:up` also starts Prometheus at http://localhost:9090 and Grafana at
http://localhost:3003. Grafana uses `GRAFANA_ADMIN_USER` and
`GRAFANA_ADMIN_PASSWORD` from `.env`; the local fallback is `admin` / `admin`.
Change the Grafana password before exposing this stack beyond localhost. The
API and Prometheus host ports are bound to loopback; the worker metrics endpoint
is internal to Docker. If deploying with externally exposed ports, protect
`/metrics` and Prometheus with an authenticated reverse proxy or network policy.
Prometheus retains 15 days of samples.
The provisioned Grafana dashboard includes GraphQL operation rate, p95 latency,
error rate, and active-request panels. GraphQL metrics distinguish query,
mutation, subscription, and unclassified request types, with errors separated
into request and execution phases. Operation names and request variables are
not used as metric labels.
PDF binaries live in the private Supabase bucket; queue data, vectors, and models
use Docker volumes.

## Backend Structure

- `src/auth`: Clerk request authentication and webhook verification.
- `src/project-service`, `src/document-service`, and `src/conversation-service`: feature controllers, services, and Nest modules.
- `src/chat-service` and `src/database`: RAG orchestration and persistence adapters.
- `src/entities` and `src/enums`: centralized domain entities and enums.
- `src/chat`, `src/config`, `src/database`, and `src/shared`: RAG utilities, integration settings, persistence wiring, and reusable utilities.
- `src/graphql`: schema-first GraphQL SDL and resolvers. The authenticated API is available at `/graphql`; existing REST endpoints remain available for the current frontend and multipart PDF uploads.
- `src/database`: migration and reindex commands.
- `src/worker-node`: background PDF processing; Jest `.spec.js` files live beside the code they cover. `app.module.ts` and `worker-node/worker.module.ts` are the API and worker composition roots.

Package installs use the server-local `.npmrc` registry configuration in both local development and Docker builds.

```bash
yarn docker:logs
docker compose ps
yarn docker:down
```

Stopping the stack preserves its volumes. Do not run `down --volumes` unless
you intend to delete uploads, queues, and indexed documents.
The original root Compose stack is not modified or stopped.

## Local Development

Create `.env` from `.env.example` only if it does not already exist, then run:

```bash
yarn install --frozen-lockfile
yarn dev
```

The local PDF worker requires Poppler's `pdfimages` and `pdftoppm` commands.
On Debian/Ubuntu install them with `sudo apt-get install poppler-utils`; the
production Docker image includes Poppler. Vector indexing checkpoints prepared
text and image captions under `uploads/.vector-index-checkpoints` so BullMQ
retries resume at embedding; successful indexing and document deletion remove
the checkpoint. Keep the uploads directory on persistent storage.

In a separate terminal run `yarn dev:worker`. Both commands start the Valkey and
Qdrant dependency containers. Set valid `OLLAMA_API_KEY` and `GOOGLE_API_KEY`
values for hosted model calls and embeddings. Do not run the local API and Docker API
simultaneously on port 8000.

Local dependency ports are Valkey 6381 and Qdrant 6335. Dockerized processes use
service names on the container network instead. Update existing local
environment files to match `.env.example` if they still point at the original
root Compose services.
Set `OLLAMA_API_KEY` and `GOOGLE_API_KEY` in `server/.env`; never expose them
with a `NEXT_PUBLIC_` variable or commit them. Hosted model usage is subject to
current quotas and terms.

## Project API And Security

Workspace and upload routes require `Authorization: Bearer <Clerk session token>`.
`GET /metrics` is intended for local Prometheus scraping; keep it behind a
trusted network boundary. The worker metrics endpoint is internal to Docker.
Set `CLERK_JWKS_URL`; `CLERK_ISSUER` and `CLERK_AUDIENCE` can further pin claims.
The frontend requests Clerk's default session token, so leave `CLERK_AUDIENCE` blank unless the token is configured to include that exact `aud` claim (for example, through a matching JWT template).
Configure a Clerk webhook pointing to `https://<api-host>/webhooks/clerk`, subscribe it to `user.deleted`, and set its signing secret as `CLERK_WEBHOOK_SIGNING_SECRET`. The verified webhook removes the user's stored PDFs and Qdrant vectors, then deletes their projects; database foreign keys cascade to documents, conversations, and messages. Failed cleanup returns an error so Clerk can retry the event.
Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and
`SUPABASE_STORAGE_BUCKET` in the backend environment only. Never expose the
service-role key to the frontend. Set `DATABASE_URL` to the direct Postgres
connection string for `yarn migrate`; URL-encode special characters in its
password. Run `yarn migrate` before starting the API; it applies the project RAG
and project index-tree migrations, then removes the retired user-experiences
table. Alternatively, run the SQL files in `migrations/` in filename order in
the Supabase SQL Editor. They create the project, document, conversation, and
message tables and a private 25 MB PDF bucket. Projects own documents and
conversations; conversations own ordered messages. Composite foreign keys keep
each child tied to the same owner and project. Names may duplicate within a user.

- `POST/GET /projects`; `GET/PATCH/DELETE /projects/:projectId`
- `POST/GET /projects/:projectId/documents`; `GET/DELETE /projects/:projectId/documents/:documentId`
- `GET /upload/status/:jobId` (owner-scoped)
- `POST/GET /projects/:projectId/conversations`; `GET/PATCH/DELETE /projects/:projectId/conversations/:conversationId`
- `GET/POST /projects/:projectId/conversations/:conversationId/messages`

Upload is multipart field `pdf`; chat message requests use `{ "message": "..." }`.
The worker stores owner, project, and document metadata with each Qdrant chunk;
search applies owner and project filters inside Qdrant. Before storing chunks,
the worker creates keyword payload indexes on `metadata.owner_clerk_id`,
`metadata.project_id`, and `metadata.document_id` for filtered search.
Extracted text is split into lossless chunks of at most 2,800 characters, each
retaining its source page and chunk number. Pages with raster images also
receive separate image-caption chunks.
Pages with embedded raster images are rendered and captioned with the
`OLLAMA_CLOUD_VISION_MODEL` (default `gemma4:31b`); those captions are embedded
with the existing Gemini text embedding model and stored with the page's owner,
project, document, and page metadata. After deploying this indexing change, start the worker and
run `yarn build && yarn reindex` from `server/` to enqueue existing PDFs again.
In Docker, run `docker compose exec api node dist/database/reindex.js` after deploying the
new image while the worker is running. Reindexing replaces each document's old
vectors with its new text chunks and image captions.
Chat ignores retrieval matches below `RAG_MIN_RELEVANCE_SCORE` (default `0.45`, for Qdrant cosine similarity) before its evidence relevance check. It replies that the PDFs do not contain the answer when no relevant chunks are found. Adjust this value in the server environment if relevant chunks are being filtered out.

Page Index Tree retrieval scans authorized passage descendants across all
sections, including unclassified content, then combines lexical ranking with
bounded document-wide candidate exploration before Ollama relevance selection.
Weak lexical matches use a deterministic distributed fallback; selected context
is restored to document reading order, and only incomplete or explicitly split
passages expand to linked neighbors. Answers are grounded in original extracted
passage text and retain page and evidence references. `RAG_TREE_MAX_CANDIDATES_PER_CALL`,
`RAG_TREE_MAX_EVIDENCE`, and `RAG_TREE_MAX_CONTEXT_EXPANSIONS` bound selector
candidates, returned evidence, and adjacent-context expansion. Defaults are 20,
8, and 2 respectively; context expansion can be disabled by setting its limit
to 0. These settings apply only to Page Index Tree chat.

The old `/upload/pdf` endpoint is replaced with project-scoped upload. `GET /chat`
requires both `projectId` and `conversationId`. The frontend must send the Clerk
session token and use the project and conversation routes. Existing local
`uploads/` files are not migrated or deleted: their owner/project associations
must be verified before a manual migration. Back up files and Qdrant before cleanup.

Run `yarn build` and `yarn test` to compile and execute the Jest spec suite.
Live Clerk/Supabase/Storage/Qdrant isolation still requires integration tests
against configured services.