# RAG backend

Node 20+ HTTP API with routes, controllers, and services. No third-party runtime
packages are required. Controllers validate requests before the private agent
client forwards supported fields to Python.

```powershell
cd D:\Projects\RAG\rag-BE
npm start
```

Listens on http://127.0.0.1:5000. Development watch: `npm run dev`. Tests: `npm test`.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Backend and agent connectivity |
| `POST /api/documents/ingest` | Index a local file or folder (`path`) |
| `POST /api/chat` | Generate a cited answer (`question`) |
| `POST /api/search` | Retrieve document excerpts (`question`) |

Optional environment variables: `PORT` (5000), `AGENT_URL`
(`http://127.0.0.1:3000`), and `FRONTEND_ORIGIN` (additional allowed browser
origin). The API accepts localhost:8080 and 127.0.0.1:8080 by default.
Keep this unauthenticated development service bound to localhost.


File attachments: choose the paperclip Attach button in the chat or Attach a file in the library. Supported formats: .txt, .md, and text-based .pdf; maximum 10 MB per file. Files travel through Node to the agent and are retained under rag-agent/data/uploads for citations. Node then publishes a MongoDB dataset snapshot. Scanned PDFs require OCR. Start the agent with .venv\Scripts\python.exe run.py so HOST and PORT in rag-agent/.env are used. Node reads PORT and AGENT_URL from rag-BE/.env. Restart Node after changing its configuration.

## Saved conversations and token usage

POST /api/chat saves questions before calling Python, then saves answers, sources,
status, timestamps and duration in MongoDB conversation_histories. Each document
is one question/answer turn; conversation_code groups turns into a conversation.
Pass conversation_id to continue a chat and a unique request_id per turn. Omitted
IDs are generated. IDs accept 1-80 letters, digits, underscores or hyphens.
Repeating a finished request ID replays its saved result without another agent
call; reusing it with different inputs or while pending returns 409.

GET /api/conversations lists the latest 50 chats. GET /api/conversation?conversation_id=ID
returns the latest 50 turns in chronological order. Pass next_cursor as the before
query parameter to load older turns. Failed and pending turns remain visible.

Node saves the agent's per-call token_usage in provider_usage_logs with model,
operation, input/output/total tokens, request ID and conversation code. Missing
counts stay null; local Ollama costs are not fabricated. Errors after a provider
response retain reported usage. Timeouts or crashes can prevent usage reporting;
a failed or pending turn does not imply zero tokens.

Answer and usage completion uses a MongoDB transaction: Atlas or another replica
set is required. Persistence failures return 503. Process crashes can leave pending
turns; inspect history before submitting again with a new request ID. The app is
one local workspace without login or per-user history isolation. Saved history is
restored for display; prior turns are not yet passed as model context.
