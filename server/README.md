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
Chat, image captioning, and relevance selection use Ollama Cloud; index-tree
construction uses source-text heuristics. Vector indexing and retrieval use Google's hosted
`gemini-embedding-2` model at 768 dimensions. Changing embedding providers
requires reindexing existing PDFs because vectors from different models are
incompatible.

API: http://localhost:8000. The frontend in `../client` uses this address.
`yarn docker:up` also starts Prometheus at http://localhost:9090 and Grafana at
http://localhost:3003. Set unique, non-empty `GRAFANA_ADMIN_USER` and
`GRAFANA_ADMIN_PASSWORD` values in `.env` before starting; Compose refuses to
start Grafana if either value is missing. Never commit the configured `.env`.
The API and Prometheus host ports are bound to loopback; the worker metrics endpoint
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

Create `.env` from `.env.example` only if it does not already exist, fill only
the values needed for the services you run, and keep the file untracked. The
example intentionally leaves secret credentials blank. `yarn dev` starts only
Valkey and Qdrant from `docker-compose.infra.yml`; `yarn docker:up` starts the
full stack and requires unique, non-empty Grafana credentials. Then run:

```bash
yarn install --frozen-lockfile
yarn dev
```

The local PDF worker requires Poppler's `pdfimages` and `pdftoppm` commands.
On Debian/Ubuntu install them with `sudo apt-get install poppler-utils`; the
production Docker image includes Poppler. Combined indexing checkpoints prepared
vector chunks, the document's tree node (including shared captions), and each
successful Gemini embedding batch under `uploads/.vector-index-checkpoints`
(overridden by `PDF_INDEX_CHECKPOINT_DIR`). BullMQ retries reuse text, captions,
and saved vectors, requesting embeddings only for inputs that are still missing.
Legacy checkpoints without a tree node are rebuilt once; prepared checkpoints
without embeddings remain usable and acquire embeddings on the next attempt.
Successful indexing and document/project/account deletion remove the checkpoint.
Keep the uploads directory on persistent storage shared by API and worker.
Compose mounts the shared `uploads` volume; the Render blueprint currently has no
persistent disk, so a container replacement/deployment can lose local checkpoints.

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

### PDF processing throughput

Every upload creates **one** `document-index` BullMQ job, regardless of the selected
RAG mode. The job downloads and extracts the PDF once, renders and captions each
eligible page once, and reuses those results to build both Vector chunks and the
document's Index Tree node. It writes the vectors to Qdrant, then atomically merges
the document node into the project tree in Supabase and marks that document
completed. Concurrent uploads merge under a database row lock; they do not replace
each other's document nodes.

The UI strategy selection affects answer retrieval only. Upload status is completed
only after **both** indexes succeed, for either selected mode. Upload controls remain
disabled while any upload in the current batch is uploading, queued, or processing;
they unlock on completion or terminal failure. Successful document deletion also
removes its upload status and saved timing entry immediately, without waiting for
status polling. A deleted/not-found upload response clears restored stale entries;
temporary polling errors leave controls locked while status checks retry.
Active jobs are restored from browser storage on reload.
The `reindex` command also queues combined jobs. Explicit project-tree rebuilds and
document-deletion tree maintenance remain separate jobs and do not change combined
document statuses.

Apply `yarn migrate` before starting the updated API and worker: migration
`20261017_shared_document_indexing.sql` installs the atomic merge/completion and
failure functions. Drain old upload/tree jobs before upgrading to avoid their
already-queued duplicate processing.

Image pages are rendered and captioned concurrently. These limits apply
**per worker process**, shared across uploads:

| Setting | Default | Purpose |
| --- | --- | --- |
| `PDF_WORKER_CONCURRENCY` | `4` | Maximum concurrent BullMQ jobs. |
| `PDF_IMAGE_CONCURRENCY` | `4` | Maximum image pages in flight (rendering plus captioning). |
| `PDF_RENDER_CONCURRENCY` | `2` | Maximum simultaneous Poppler renders, within the image-page limit. |
| `GEMINI_EMBEDDING_BATCH_CONCURRENCY` | `2` | Maximum simultaneous embedding batches per embedding call. Set to `1` for sequential requests. |

All four accept integers from 1 to 32 and default when unset; invalid values
are rejected. Start with these defaults on small Render instances. Raise worker
concurrency only when jobs really wait for a free slot and RAM and provider
quotas permit it. Increasing it does not bypass shared image limits or Gemini
quotas. Multiple worker processes multiply these limits.

**Quota errors stop indexing and remove the upload.** Any provider quota or rate
limit rejection (a Gemini embedding `429`, or an Ollama vision `429`/quota error)
is not retried, either per request or as a BullMQ job retry. The worker:

1. stops starting new caption pages and embedding batches;
2. records the reason in the job progress;
3. removes the document row (`discard_document_indexing`), its stored PDF, any
   partial Qdrant vectors, and its checkpoint, and recomputes the project index
   status from the remaining PDFs.

The upload status API then reports `failed` with a message such as
"Gemini embedding quota exceeded, so PDF indexing was stopped. The PDF was
removed. Wait for the quota to reset or increase it, then upload the PDF again."
The UI shows this message, and the PDF no longer appears in the document list.
Other errors keep the existing retry behavior. For Gemini, only timeouts, `408`,
and `5xx` responses are retried; `Retry-After` is honored up to
`GEMINI_EMBEDDING_MAX_RETRY_AFTER_MS`.

A 429 mentioning `embed_content_free_tier_requests` is a Google project
quota limit, not a Qdrant error. Check the project's active limits in AI Studio;
for a constrained tier, start with `PDF_WORKER_CONCURRENCY=1` and
`GEMINI_EMBEDDING_BATCH_CONCURRENCY=1`. This reduces bursts but cannot increase the
quota. Batching does not guarantee that all inputs count as a single quota unit.
When a worker retries failed indexing, each successfully checkpointed embedding
batch is reused, including when the failure occurred during Qdrant upsert or tree
persistence. The checkpoint is scoped to the source document and validates the
embedding model, dimensions, exact ordered texts, prompt, and finite vector
values. Changed embedding inputs invalidate only the saved embeddings; changing
the batch size or concurrency does not invalidate them.
Embedding time is recorded separately as the `vector/embedding` ingestion stage;
the `qdrant/upsert` dependency now measures the vector write without Gemini calls.

Embedding batches retain `GEMINI_EMBEDDING_BATCH_SIZE` (for example, 100 inputs)
and run with bounded parallelism while preserving vector/input order. Each batch
retains its timeout and retry/backoff policy for transient errors. A failed batch stops new batches and
drains in-flight requests before the job fails. Concurrent document jobs multiply
embedding concurrency; lower it if provider quotas produce 429 responses.
Successful in-flight batches are still saved if another batch fails. Snapshot
writes are atomic and serialized per document so parallel completions do not
overwrite newer results. Checkpoint I/O failures are surfaced rather than
silently triggering fresh embedding calls. If the process dies after Gemini
responds but before that batch is saved, that unsaved batch may be requested again.

For persistent Gemini quota failures:

1. Check the API key's project and active RPM/TPM/RPD limits in
   [AI Studio](https://aistudio.google.com/rate-limit); the number in a truncated
   error alone does not identify the quota's reset window.
2. For sustained ingestion, [enable billing on that project](https://ai.google.dev/gemini-api/docs/billing)
   and verify the paid tier and its active limits. Request a quota increase if
   necessary. Another key in the same project does not provide another quota.
3. Set `GEMINI_EMBEDDING_RATE_LIMIT_PER_MINUTE` to the project's RPM (for example
   `100` embedding requests per minute). Concurrency settings alone only limit bursts; the rate limiter is the
   global guard.
4. A depleted daily quota or billing issue requires a quota reset, billing
   repair, or an approved increase before uploading again.

### Proactive Gemini embedding rate limit

| Variable | Default | Purpose |
| --- | --- | --- |
| `GEMINI_EMBEDDING_RATE_LIMIT_PER_MINUTE` | `0` (off) | Budget per rolling 60 seconds. Templates set `100`. |
| `GEMINI_EMBEDDING_RATE_LIMIT_UNIT` | `request` | `request` charges one unit per HTTP call (a `batchEmbedContents` call of up to 100 texts costs 1). Switch to `input` only if AI Studio shows usage growing by the number of texts per batch; it then charges one unit per text and caps batch size at the limit. |

The API (query embeddings) and the worker (document embeddings) share one
cost-weighted sliding window in Redis/Valkey, keyed by embedding model and using
Redis server time. Every attempt, including retries, is charged before it is
sent to enforce the configured local RPM budget. Other project traffic, daily
quotas, token limits, or per-input accounting can still cause 429 responses,
which stop indexing as described above.
Waits are logged as `dependency.rate_limit_wait`. If Redis is
unreachable, each process falls back to an in-memory window and logs
`dependency.rate_limiter_fallback` (processes may then jointly exceed the limit).

With `input`, the effective batch size is capped at the per-minute limit, so with
`100`/minute, a document with 450 chunks needs about 4.5 minutes of embedding no
matter the batch size or concurrency. While a large upload holds the window,
chat queries can also wait for budget. The default is `request`, matching a
requests-per-minute quota. If AI Studio shows usage growing by the number of
texts in a batch rather than by one, explicitly switch to `input`. Neither mode
increases Google's daily request quota.

Reducing output dimensions (for example, from 768) reduces vector size, not the
number of embedding inputs or the request quota. Selecting Vectorless retrieval
also does not avoid embedding calls: uploads intentionally build both indexes.

Only pages with at least one meaningful embedded image are rendered and captioned.
Text-only pages are never rendered. Soft masks and stencil masks are ignored, and
images are skipped when they look like icons, logos, or company-name banners:

| Setting | Default | Skips an image when |
| --- | --- | --- |
| `PDF_IMAGE_MIN_WIDTH` | `150` | Its intrinsic width is below this many pixels. |
| `PDF_IMAGE_MIN_HEIGHT` | `150` | Its intrinsic height is below this many pixels. |
| `PDF_IMAGE_MIN_DISPLAY_POINTS` | `72` | It is drawn narrower or shorter than this on the page (72 points = 1 inch). |
| `PDF_IMAGE_MAX_REPEAT_PAGES` | `3` | The same image object appears on more pages than this (header/footer logos). |

Set any of these to `0` to disable that check. A page is captioned when any image
on it passes all checks. Each upload logs `document.processing.image_pages_selected`,
and the `image_pages` and `skipped_images` ingestion units use strategy `both` for
shared upload work. Shared stages and worker metrics also use `both`; index-specific
chunking and persistence keep their `vector` / `index_tree` labels.

Rendering overlaps vision requests without changing 1024-pixel PNG resolution,
the vision prompt, or image-page coverage. Results retain page order and source
metadata even when requests finish out of order. PNG files are removed after
reading. On failure, new work stops for that document and in-flight pages finish
before temporary-directory cleanup. Shared checkpoints avoid repeating captioning
when embedding or tree persistence is retried; embedding vectors are not checkpointed.

Focused database concurrency tests can be run against a disposable local Postgres
database named `magnify_ingestion_test` using `MAGNIFY_TEST_DATABASE_URL` and
`yarn test:unit --runTestsByPath src/document-service/shared-index-persistence.spec.js`.
The test creates its own schema fixtures and must not target a development database.

Faster image processing releases worker slots sooner; it cannot eliminate waits
caused by unavailable workers or provider limits. Queue-wait metrics now measure
**first activation only**: BullMQ retains the initial enqueue timestamp on retries,
so subtracting it again incorrectly counted previous processing as queue wait.
Started-job logs distinguish `queueWaitSeconds` (initial activation) from
`jobAgeSeconds` (all attempts). Dependency and image-stage histogram buckets now
extend to one hour; the old 60-second dependency ceiling could hide longer calls.
Compare new-deployment samples, not historical/mixed-version percentiles.

## Project API And Security

Workspace and upload routes require `Authorization: Bearer <Clerk session token>`.
`GET /metrics` is intended for local Prometheus scraping; keep it behind a
trusted network boundary. The worker metrics endpoint is internal to Docker.
Set `CLERK_JWKS_URL`; `CLERK_ISSUER` and `CLERK_AUDIENCE` can further pin claims.
The frontend requests Clerk's default session token, so leave `CLERK_AUDIENCE` blank unless the token is configured to include that exact `aud` claim (for example, through a matching JWT template).
Configure a Clerk webhook pointing to `https://<api-host>/webhooks/clerk`, subscribe it to `user.deleted`, and set its signing secret as `CLERK_WEBHOOK_SIGNING_SECRET`. The verified webhook removes all of the user's data:

- queued and retained BullMQ jobs (before and after cleanup; running jobs detect the missing PDF and stop without retrying);
- every Supabase Storage object under the `<clerk-user-id>/` prefix, including files orphaned by interrupted uploads;
- on-disk indexing checkpoints for the user's documents;
- their projects, which cascade to `documents`, `conversations`, `messages`, and `project_index_trees`;
- their Qdrant vectors.

Failed cleanup returns an error so Clerk can retry the event; every step is idempotent. Application logs may still contain the opaque Clerk user ID until log retention expires; metrics do not include it.
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
retaining its source page and chunk number. Pages with qualifying raster images also
receive separate image-caption chunks.
Pages passing the shared embedded-image filter are rendered and captioned with the
`OLLAMA_CLOUD_VISION_MODEL` (default `gemma4:31b`); those captions are embedded
with the existing Gemini text embedding model and stored with the page's owner,
project, document, and page metadata. After deploying this indexing change, start the worker and
run `yarn build && yarn reindex` from `server/` to enqueue existing PDFs again.
In Docker, run `docker compose exec api node dist/database/reindex.js` after deploying the
new image while the worker is running. Reindexing replaces each document's old
vectors with its new text chunks and image captions and merges its document node
into the project Index Tree using the same extraction and captions.
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