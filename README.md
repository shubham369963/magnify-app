# magnify-app

## Deploy to Render

The root [`render.yaml`](render.yaml) Blueprint defines a Next.js web service,
a NestJS API, a BullMQ background worker, and a private Render Key Value
instance for Redis. The API and worker use the existing Docker image; Qdrant,
Supabase, Clerk, Google, and Ollama remain externally managed services.
The Redis instance is configured for persistent queue data and `noeviction`;
the app services and Redis require paid Render plans for reliable production
operation.

### Initial setup

1. Push this repository to GitHub and connect it to Render.
2. In Render, create a new Blueprint from the repository root and deploy
	`render.yaml`. Keep all services in the same region. During the first sync,
	provide the prompted values for the API, worker, and web service.
3. Set the API and worker secrets to valid `QDRANT_URL`, `QDRANT_API_KEY`,
	`GOOGLE_API_KEY`, `OLLAMA_API_KEY`, `SUPABASE_URL`, and
	`SUPABASE_SERVICE_ROLE_KEY` values. `QDRANT_API_KEY` may be left empty for a
	Qdrant instance that does not require authentication. Set the API's
	`CLERK_JWKS_URL` and `CLERK_WEBHOOK_SIGNING_SECRET`; the optional
	`CLERK_ISSUER` and `CLERK_AUDIENCE` can be configured in the Render
	dashboard. For the web service, set production Clerk values for
	`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`.
4. In Supabase, apply the SQL files in `server/migrations/` in filename order,
	or run the migration from a trusted local environment with the direct
	database URL:

	```bash
	cd server
	DATABASE_URL='postgresql://...' yarn migrate
	```

	Do this before using the app. Keep the database URL and all service-role/API
	keys out of the repository and browser environment.
5. Configure Clerk's production allowed origins/redirect URLs for the web
	service, and point its `user.deleted` webhook to
	`https://<api-host>/webhooks/clerk`.
6. In GitHub repository Actions variables, set `RENDER_API_URL` and
	`RENDER_CLIENT_URL` to the deployed API and web service base URLs, including
	`https://`, and set `RENDER_WORKER_SERVICE_ID` to the Render worker service
	ID. Add a `RENDER_API_KEY` GitHub Actions secret with read access to that
	service. The `CD` workflow uses these for deployment and HTTP health checks.

The Blueprint connects the web service to the API using Render's private
network. Its API route is proxied through the Next.js `/api/backend/*` rewrite;
the API does not need to be called directly by browser code. The API health
check is `GET /` and the worker consumes queued PDF jobs from Redis. PDFs are
stored in the configured private Supabase Storage bucket, not on Render's
ephemeral filesystem.

### Continuous integration and releases

The `CI` workflow checks that real env files are not tracked and that env
templates contain no credentials. It runs client lint/typecheck/markdown tests
and build; server typecheck, GraphQL SDL validation, build, unit and performance
tests; then starts the API and worker against a temporary Valkey service and
checks API, GraphQL, and worker readiness. Render services use
`autoDeployTrigger: checksPass`, so a linked-branch deployment starts only
after CI succeeds. The `CD` workflow checks the deployed API, web app, and
web-to-API rewrite. Push a `v*` tag to run the same CI checks, verify the tag,
and publish a GitHub Release with generated notes.

Update the `main` branch filters in `.github/workflows/cd.yml` and
`render.yaml` if the repository uses a different production branch.

## Environment files

Use `server/.env.example` and `client/.env.example` as key-only templates.
Copy the relevant template to `.env` locally and fill only values needed for
the services you run. Real `.env` files are ignored and must remain untracked;
never paste credentials into source, workflow YAML, or browser-exposed
`NEXT_PUBLIC_` variables. Production secrets belong in Render's environment
settings. The server loads its local file only through its explicit Node
`--env-file=.env` start/migration commands, while Next.js reads its own local
environment at build/runtime.