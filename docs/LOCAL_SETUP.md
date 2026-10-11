# Local Setup Guide

> Updated for the merged Plan 3 private beta. The app now includes recorded coaching, guided exercises, and real-time scene rehearsal as well as script study.

## What this setup runs

The prototype runs a web process and a worker that share PostgreSQL, private object storage, and OpenAI configuration. During a rehearsal, the browser requests short-lived realtime credentials from the web process; the browser never receives the server's primary OpenAI key.

```text
Browser → Next.js web process → PostgreSQL / private S3-compatible object storage (MinIO for local development)
  │                      ↓
  │               queued background jobs
  │                      ↓
  └── short-lived realtime credentials ← worker → extraction / coaching
```

## Prerequisites

Install Node.js 24, pnpm 11.18, PostgreSQL 17, FFmpeg, Git, Docker (for the recommended local MinIO setup) or another private S3-compatible object store, and an OpenAI API key with access to the configured structured-output, text-to-speech, and realtime models. On macOS, Homebrew is the primary example. The versioned Node and PostgreSQL formulae are keg-only, so add both to `PATH` before using their commands:

```bash
brew install node@24 postgresql@17 ffmpeg
echo 'export PATH="$(brew --prefix node@24)/bin:$(brew --prefix postgresql@17)/bin:$PATH"' >> ~/.zshrc
export PATH="$(brew --prefix node@24)/bin:$(brew --prefix postgresql@17)/bin:$PATH"
corepack enable
corepack prepare pnpm@11.18.0 --activate
node --version
pnpm --version
psql --version
ffmpeg -version
brew services start postgresql@17
```

On Linux, install the same version floors through your distribution, a Node version manager, or the PostgreSQL package repository, and install FFmpeg through the distribution package manager (for example, `sudo apt install ffmpeg`). WSL is unverified.

## 1. Get the source

Clone from GitHub:

```bash
git clone git@github.com:zhen-luo/dramavisor.git
cd dramavisor
```

Or clone from the supplied bundle:

```bash
git clone dramavisor.bundle dramavisor
cd dramavisor
```

## 2. Install dependencies

```bash
pnpm install --frozen-lockfile
```

## 3. Create the PostgreSQL database

```bash
createdb drama_practice
```

## 4. Run private object storage locally with MinIO

Dramavisor uses the S3 API for uploaded scripts and audio; it does **not** require an AWS account or AWS S3. For a single-machine setup, MinIO stores those objects in a Docker volume on your machine while preserving the S3 interface used by the web app and worker.

Start MinIO with a named local volume. Replace the example password before you run the command; it is suitable only for local development.

```bash
docker volume create dramavisor-minio-data
docker run --name dramavisor-minio \
  -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=dramavisor-local \
  -e MINIO_ROOT_PASSWORD=change-this-local-password \
  -e MINIO_DOMAIN=localhost \
  -v dramavisor-minio-data:/data \
  minio/minio server /data --console-address ":9001"
```

Open `http://localhost:9001`, sign in with those MinIO credentials, and create a **private** bucket named `dramavisor-private`. Enable bucket versioning before running Dramavisor. Versioning is mandatory because the application records and permanently purges exact private-object versions during compensation and account deletion.

For a single-machine private-beta setup using MinIO Community Edition without a key-management service, set `S3_SERVER_SIDE_ENCRYPTION=none` below. This preserves private authenticated storage but does **not** encrypt objects at rest; use it only on a locally secured disk. The application rejects this setting in production. For shared, hosted, or production storage, omit that variable and configure provider-managed `AES256` server-side encryption with a key-management service.

To stop the server without deleting your local objects, run `docker stop dramavisor-minio`; restart it later with `docker start dramavisor-minio`. Delete the named volume only when you intentionally want to remove all local private objects.

## 5. Configure the local environment

Create one root `.env.local` file. Every terminal used below must source this file. Never commit `.env.local` or real credentials; rotate any credential that is accidentally exposed.

```dotenv
DATABASE_URL=postgresql://localhost:5432/drama_practice
APP_URL=http://localhost:3000
# Set false only for local HTTP development; keep true or omit it for HTTPS.
SESSION_COOKIE_SECURE=false
OPENAI_API_KEY=replace-with-your-openai-api-key
ANALYSIS_MODEL=replace-with-a-structured-outputs-model-id
# Optional: defaults to ANALYSIS_MODEL. Set only to use another GPT-5.6-family model for coaching.
# COACHING_MODEL=gpt-5.6-terra
# Optional: audio observation model used during take review; defaults to gpt-audio-1.5.
# AUDIO_REVIEW_MODEL=gpt-audio-1.5
# REALTIME_MODEL=gpt-realtime-2.1
# REALTIME_CLIENT_SECRET_TTL_SECONDS=600
# TTS_MODEL=gpt-4o-mini-tts
# OPERATIONAL_EVENT_SALT=replace-with-a-random-private-value
S3_PRIVATE_BUCKET=dramavisor-private
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=dramavisor-local
AWS_SECRET_ACCESS_KEY=change-this-local-password
AWS_ENDPOINT_URL_S3=http://127.0.0.1:9000
# Local MinIO Community Edition on a secured single-user machine only.
# Omit this setting and configure provider-managed AES256 encryption for shared or production storage.
S3_SERVER_SIDE_ENCRYPTION=none
WORKER_POLL_MS=1000
# OCR_ENDPOINT=https://replace-with-your-english-ocr-endpoint
# OCR_API_KEY=replace-with-your-ocr-api-key
```

`SESSION_COOKIE_SECURE` defaults to secure cookies. Because this guide runs the browser at `http://localhost:3000`, set it to `false` for this local-only setup and restart the web process after changing it. For any HTTPS, shared, or production deployment, leave it unset or set it to `true`; the application ignores `false` in production. Never send sign-in cookies over ordinary HTTP outside local development.

The AWS SDK default credential chain is used. The values above target the local MinIO server and use its S3-compatible API; the AWS-named variables do not require AWS. Leave `AWS_ENDPOINT_URL_S3` unset only when using Amazon S3. A configured custom endpoint uses path-style bucket addressing, which works with direct local MinIO. `S3_SERVER_SIDE_ENCRYPTION` defaults to `AES256`; `none` is permitted only outside production for a secured, single-user local MinIO disk. This prototype does not include a local object-store emulator.

`ANALYSIS_MODEL` must support the Responses API `text.format` JSON Schema form of Structured Outputs; parsing, study generation, and tutoring depend on it. `COACHING_MODEL` is optional (the application defaults it to `gpt-5.6`) and, if set, must be a GPT-5.6-family model. `REALTIME_MODEL` and `TTS_MODEL` are optional overrides for `gpt-realtime-2.1` and `gpt-4o-mini-tts`. If set, `REALTIME_CLIENT_SECRET_TTL_SECONDS` must be an integer from 10 through 600. Set `OPERATIONAL_EVENT_SALT` to a private, stable random value outside local development so operational event details are redacted consistently.

The browser requests time-limited realtime credentials only after the actor starts or resumes a rehearsal. Do not put the primary `OPENAI_API_KEY` in client-side configuration or expose it in browser logs.

`OCR_ENDPOINT` and `OCR_API_KEY` can remain unset for pasted scripts, DOCX files, and text-based PDFs. For scanned PDFs, the worker sends each page as an `image/png` body in an HTTP `POST` to `OCR_ENDPOINT`, adding the query parameters `language=eng` and `page=N`. If `OCR_API_KEY` is set, it is sent as a bearer token. The service must reply with JSON shaped as `{ "text": "..." }`.

## 6. Apply database migrations

From the repository root, load the environment and migrate:

```bash
set -a
source .env.local
set +a
pnpm db:migrate
```

## 7. Start the web app and worker

Open two terminals. In each one, change to the repository and source `.env.local` first:

```bash
cd dramavisor
set -a
source .env.local
set +a
```

Terminal 1 starts the web app:

```bash
pnpm dev
```

The development command clears only the generated `apps/web/.next` cache before starting Next.js. This prevents
old development chunks from surviving a server restart while retaining Turbopack's incremental route compilation.
Do not force webpack here: compiling a route on its first navigation can make webpack Fast Refresh perform a full-page reload.

Terminal 2 starts the worker:

```bash
pnpm --filter @drama/worker start
```

Open `http://localhost:3000` in your browser.

## 8. Create the first invitation

In Terminal 3, again change to the repository and source `.env.local`:

```bash
cd dramavisor
set -a
source .env.local
set +a
pnpm create-invite -- --email actor@example.com
```

The invitation lasts seven days, and its printed link uses `APP_URL`. The command refuses an email that already belongs to an account; sign in with that account instead of creating another invitation.

## 9. Verify the installation

```bash
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm lint
pnpm --filter @drama/web exec next build
pnpm smoke:provider fixtures/plays/two-scene-play.txt
pnpm smoke:realtime
```

`smoke:provider` reports `SKIPPED` with exit code zero when `OPENAI_API_KEY` is unset. `smoke:realtime` similarly skips when the key is absent; with a configured key it checks that the server can issue a short-lived realtime credential. A skipped smoke test is not an external-provider measurement, and the planned ten-actor usefulness study is still pending.

## Stop and restart the app

Use `Ctrl+C` to stop either process. Data remains in PostgreSQL and private object storage; restarting the web app and worker resumes eligible queued jobs. Stop an active rehearsal from its in-app control before closing the tab so its microphone and realtime session are released promptly.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `node`, `pnpm`, `psql`, or `createdb` is not found on macOS | Re-run the two `PATH` commands under Prerequisites, then open a new terminal. |
| `spawn ffmpeg ENOENT` or audio normalization fails | Install FFmpeg (`brew install ffmpeg` on macOS), confirm `ffmpeg -version`, then rerun the test or worker. |
| `DATABASE_URL is required` | Source `.env.local` in that terminal. |
| `OPENAI_API_KEY is required` or `ANALYSIS_MODEL is required` | Check the AI variables in the web and worker environments. |
| Realtime Start or Resume cannot obtain credentials | Confirm `OPENAI_API_KEY`, the configured `REALTIME_MODEL`, and that any `REALTIME_CLIENT_SECRET_TTL_SECONDS` is 10–600. Do not add the primary key to the browser. |
| Rehearsal does not hear the actor | Allow microphone access in the browser, then use **Start rehearsal** or **Resume**. Stop the session before retrying after a permission change. |
| MinIO uploads fail with an encryption or versioning error | For local MinIO Community Edition, set `S3_SERVER_SIDE_ENCRYPTION=none`, use `AWS_ENDPOINT_URL_S3=http://127.0.0.1:9000`, and restart the web app and worker. For shared or production storage, omit that setting and configure `AES256` encryption plus bucket versioning. |
| `S3_PRIVATE_BUCKET is required` | Set the bucket and credentials; for local MinIO use `dramavisor-private`, `http://localhost:9000`, and the same credentials used to start the container. |
| Script or coaching remains “processing” | Keep the worker running and inspect its terminal output. |
| Scanned PDF extraction fails | Configure an English `OCR_ENDPOINT` and optional `OCR_API_KEY`. |
| Invite link uses the wrong host | Set `APP_URL`, then create a new invitation. |
| Sign-in immediately returns to the sign-in page with no message | For the local `http://localhost:3000` setup, set `SESSION_COOKIE_SECURE=false`, restart the web process, and retry. For HTTPS, leave it secure. |
| A browser tab reports a stale development `ChunkLoadError` after restarting | Stop every older web process, run `pnpm dev` (which clears the generated `.next` cache), and reload the tab once. |
| A click needs to be repeated after `Fast Refresh had to perform a full reload` | Stop the webpack dev process and restart with the repository `pnpm dev` command. Confirm the server does not say `(webpack)`. |
| `An account already exists for ...` from `create-invite` | The address already has an account. Sign in with it; do not create another invitation. |
| Port 3000 is occupied | Stop the existing process or start Next with a deliberate alternate port and update `APP_URL`. |

## Prototype limitations

This is a local private-beta prototype. It uses S3-compatible private object storage; the guide provides a local MinIO option, but not ordinary filesystem storage or an in-process object-store emulator, and has not been verified on WSL. It is English-only and voice-only; camera analysis, cast voice cloning, mobile-native support, external-provider measurements, and the ten-actor usefulness study remain pending.
