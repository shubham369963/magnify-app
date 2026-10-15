# PDF Workspace Integration

The frontend in `client/` is a Next.js app. The NestJS API and worker live in
`server/`. The browser sends requests to `/api/backend/*`; Next.js forwards them
to `NEST_API_URL` (default `http://localhost:8000`).

## Run Locally

Configure the frontend with Clerk's `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and
`CLERK_SECRET_KEY`. Configure the backend using `server/.env.example` as a
reference. Keep the Supabase service-role key and other backend secrets only in
the server environment; never put them in a `NEXT_PUBLIC_*` variable.

Start the API and worker in separate terminals:

```bash
cd server
yarn install --frozen-lockfile
yarn dev
```

```bash
cd server
yarn dev:worker
```

Then start the frontend:

```bash
cd client
yarn install --frozen-lockfile
yarn dev
```

Open http://localhost:3001. The backend requires the configured Supabase,
Valkey, Qdrant, and Ollama services. See [the backend README](../server/README.md)
for local and Docker setup, migrations, and required server configuration.

## Authentication And Requests

When both Clerk frontend keys are configured, the app requires sign-in. Every
browser API request obtains the current Clerk session token and sends it as
`Authorization: Bearer <token>`. The backend validates that token and scopes
projects, documents, conversations, messages, and vector search to its owner.
Without Clerk keys, the app displays an authentication setup message; it does
not use an unauthenticated backend fallback.

The browser does not call the backend host directly. `NEST_API_URL` is read by
Next.js when it creates the rewrite, so restart the frontend after changing it.
Production deployments must configure this value for the deployed backend.

## Project Workflow And Routes

- `GET/POST /projects` and `GET/PATCH/DELETE /projects/:projectId` manage projects.
- `GET/POST /projects/:projectId/documents` list and upload PDFs; `GET/DELETE /projects/:projectId/documents/:documentId` inspect or remove a document.
- `GET /upload/status/:jobId` reports queued, processing, completed, or failed upload jobs.
- `GET/POST /projects/:projectId/conversations` and `GET/PATCH/DELETE /projects/:projectId/conversations/:conversationId` manage conversations.
- `GET/POST /projects/:projectId/conversations/:conversationId/messages` load history and send a question.

The upload form accepts PDF files and sends each file as a separate multipart
request using the `pdf` field. Successful upload means queued, not indexed. The
client polls job status and refreshes document metadata when processing ends.
Chat requests send `{ "message": "..." }`; retrieved PDF excerpts and saved
source references are displayed with assistant replies. New conversations are
isolated from other projects and conversations.

Run the checks from their respective project directories:

```bash
cd client
yarn lint
yarn build
```

```bash
cd server
yarn build
yarn test
```