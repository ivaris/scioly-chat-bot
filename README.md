# Full-stack Chatbot (Express + Vite/React)

Quick scaffolded full-stack chatbot. Backend proxies to OpenAI if `OPENAI_API_KEY` is provided, otherwise falls back to an echo responder.

Setup

1. Install server deps and run server:

```bash
cd server
npm install
# create .env from .env.example and set OPENAI_API_KEY if you have one
npm run start
```

The server runs on port 3000 by default.

2. Install client deps and run client:

```bash
cd client
npm install
npm run dev
```

The Vite dev server runs on port 5173. The client app calls http://localhost:3000/api/chat by default.

Notes

- To enable real LLM responses set `OPENAI_API_KEY` in `server/.env`.
- This scaffold is minimal — consider adding authentication, rate limits, and streaming for production.

New endpoints

- `GET /api/topics` - returns available topics (includes `forensics` and `designer genes`).
- `POST /api/chat` - body `{ messages: [{role,content}], provider: 'openai'|'google', topic?: string }` - queries docs for context and proxies to selected LLM provider.

Notes on providers

- `OPENAI_API_KEY` enables OpenAI chat and embeddings. Set this in `server/.env` to enable high-quality retrieval and model responses.
- `GOOGLE_API_KEY` (optional) enables a basic call to Google Generative Language (PaLM) if provided.

-Embedding management

- Embeddings are computed when files are added to the project folders (e.g. `local_docs/`) or imported via local imports if `OPENAI_API_KEY` is set.
- If you add `OPENAI_API_KEY` after importing files, run `POST /api/docs/recompute` to compute embeddings for documents that lack them (or pass `{ "force": true }` to recompute all embeddings).

Provider-aware embeddings

- You can select which LLM provider to use for embeddings and chat: `openai` or `google` (Gemini). The server will use the corresponding API key: `OPENAI_API_KEY` or `GOOGLE_API_KEY`.
- When uploading or importing files you may pass `provider` (body/form field) to choose which provider to use for embedding creation. The stored document will include `embedding_provider` so retrieval uses matching embeddings.
- `POST /api/docs/recompute` accepts `{ "provider": "openai" }` or `{ "provider": "google" }` to recompute embeddings using the selected provider.
- Preprocessing at startup prefers OpenAI if `OPENAI_API_KEY` is present, otherwise uses `GOOGLE_API_KEY` if available. You can also manually call `/api/preprocess` and include `{ "provider": "google" }` or `{ "provider": "openai" }` in the request body to force provider selection.

Example to recompute embeddings:

```bash
curl -X POST http://localhost:3000/api/docs/recompute -H 'Content-Type: application/json' -d '{}' 
```

Preprocessing at startup

- On server start the uploads folder is scanned and any new files are added to the document store. If `OPENAI_API_KEY` is configured, embeddings will be computed during this preprocessing step.
- You can also trigger preprocessing on-demand via `POST /api/preprocess` which will scan `uploads/` and import any files not yet present in `docs.json`.

Example to trigger preprocessing manually:

```bash
curl -X POST http://localhost:3000/api/preprocess -H 'Content-Type: application/json' -d '{}' 
```

Local directory import

- You can configure `LOCAL_DOCS_DIR` in `server/.env` to point to a server-local folder containing PDFs/DOCX/TXT to be indexed.
 - By default the server uses a project-local `local_docs/` folder. Set `LOCAL_DOCS_DIR` in `server/.env` to a different path if needed (relative paths resolve inside the project). The server will create the folder if it doesn't exist.
- Endpoints:
	- `GET /api/local/list` — list files in the configured local docs directory.
	- `POST /api/local/import` — import a single file by filename. Body: `{ "filename": "report.pdf", "topic": "forensics", "provider": "openai" }`.
	- `POST /api/local/import-all` — import all files from the directory. Body may include `{ "provider": "google" }` to choose embedding provider.

Examples:

```bash
# list files
curl http://localhost:3000/api/local/list

# import single file using OpenAI embeddings
curl -X POST http://localhost:3000/api/local/import -H 'Content-Type: application/json' -d '{"filename":"report.pdf","provider":"openai","topic":"forensics"}'

# import all files using Gemini (Google) embeddings
curl -X POST http://localhost:3000/api/local/import-all -H 'Content-Type: application/json' -d '{"provider":"google"}'
```

Amplify Gen2 S3 document ingestion

- The backend reads from S3 bucket `scioly-content` under prefix `local_docs/`.
- Upload files to `local_docs/<topic_slug>/...` (example: `local_docs/scioly_results/2026-02-14_jordan_invitational_c.csv`).
- `documentsImportTopic(topic)` and `documentsPreprocess()` ingest from both local `local_docs/` and S3 `local_docs/` prefix.
- In deployed environments, S3 is the recommended source because Lambda cannot read your laptop filesystem.
