
# AI Inbox Agent

An AI-assisted inbox management API built with Node.js, Express, SQLite, and a Knowledge Brain integration.

## Features

- Email classification by category and priority
- Persistent email storage using SQLite
- Support knowledge retrieval through Task 1 Knowledge Brain
- Draft replies with retrieved support sources
- Human approval and rejection workflows
- Feedback collection and quality metrics
- Automated tests using Node.js's built-in test runner

## Architecture

1. A customer email is submitted to the Inbox Agent API.
2. The API classifies the email by category and priority.
3. The API queries the Knowledge Brain for relevant support information.
4. A draft reply and available support sources are saved to SQLite.
5. A human reviews the draft and approves or rejects it.
6. Feedback and metrics are recorded for quality tracking.

## Requirements

- Node.js with npm
- Task 1 Knowledge Brain API (optional for local fallback behavior)

## Setup

Install dependencies:

```bash
npm install
```

Create a `.env` file if needed:

```env
PORT=3001
KNOWLEDGE_BRAIN_URL=http://127.0.0.1:8000
```

Start the API:

```bash
npm start
```

Development mode:

```bash
npm run dev
```

Syntax check:

```bash
npm run build
```

Run automated tests:

```bash
npm test
```

## API Endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/health` | Health check |
| POST | `/classify` | Classify an email |
| POST | `/emails` | Save an email and generate a draft |
| GET | `/emails` | List emails |
| GET | `/emails/:id` | Get an email |
| PATCH | `/emails/:id/draft` | Edit a pending draft |
| POST | `/emails/:id/approve` | Approve a draft |
| POST | `/emails/:id/reject` | Reject a draft |
| POST | `/emails/:id/feedback` | Submit feedback |
| GET | `/feedback` | List feedback |
| GET | `/metrics` | View quality metrics |

## Human Review and Safety

- New emails are saved with `pending_review` status.
- Approval and rejection update the record's status.
- Approval does not send an email.
- The application does not automatically send customer emails.

## AI Integration Status

The Knowledge Brain connection has been tested successfully.

The current local configuration may return a mock answer rather than a genuine Claude-generated response. Do not interpret a mock response as production AI generation.

## Testing

The automated test suite covers:

- Health endpoint
- Urgent billing classification
- Email creation
- Feedback and metrics
- Approval without sending an email
- Rejection with a review note

Run `npm test` to execute the suite.

## Storage

Email and feedback records are stored in `data/inbox.db` by default. The test suite uses a temporary database.

Do not commit private environment variables or production customer data.
