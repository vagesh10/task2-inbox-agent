
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const Database = require("better-sqlite3");
const fs = require("node:fs");
const path = require("node:path");

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const KNOWLEDGE_BRAIN_URL =
  process.env.KNOWLEDGE_BRAIN_URL || "http://127.0.0.1:8000";

// ==================================================
// 1. DATABASE SETUP
// ==================================================

const dataDirectory = path.join(__dirname, "data");

const dbPath =
  process.env.INBOX_DB_PATH || path.join(dataDirectory, "inbox.db");

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    category TEXT NOT NULL,
    priority TEXT NOT NULL,
    draft_reply TEXT NOT NULL,
    support_sources TEXT NOT NULL DEFAULT '[]',
    knowledge_brain_status TEXT NOT NULL DEFAULT 'unavailable',
    status TEXT NOT NULL DEFAULT 'pending_review'
      CHECK(status IN ('pending_review', 'approved', 'rejected')),
    review_note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS email_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email_id INTEGER NOT NULL,
    rating TEXT NOT NULL CHECK(rating IN ('positive', 'negative')),
    comment TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (email_id) REFERENCES emails(id)
  );
`);

// ==================================================
// 2. MIDDLEWARE
// ==================================================

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ==================================================
// 3. HELPERS
// ==================================================

function isValidText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function parseId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function classifyEmail(subject, body) {
  const text = `${subject} ${body}`.toLowerCase();

  let category = "general";
  let priority = "normal";

  if (/urgent|asap|immediately|critical/.test(text)) {
    priority = "high";
  }

  if (/refund|payment|invoice|billing/.test(text)) {
    category = "billing";
  } else if (/bug|error|not working|broken|technical/.test(text)) {
    category = "technical_support";
  } else if (/meeting|schedule|appointment/.test(text)) {
    category = "scheduling";
  } else if (/complaint|unhappy|dissatisfied/.test(text)) {
    category = "complaint";
  }

  return { category, priority };
}

function createDraft(answer, sources) {
  if (isValidText(answer)) {
    return (
      "Thank you for contacting us.\n\n" +
      answer.trim() +
      "\n\nWe will review your request before sending a response."
    );
  }

  const sourceNote = sources.length
    ? ` Retrieved support source: [${sources[0].id}].`
    : "";

  return (
    "Thank you for contacting us.\n\n" +
    "We have received your message and will review it before responding " +
    "with the appropriate information." +
    sourceNote
  );
}

function normalizeSources(rawSources) {
  if (!Array.isArray(rawSources)) return [];

  return rawSources.map((source, index) => ({
    id: source.id || `S${index + 1}`,
    title: source.title || source.name || "Support article",
    url: source.url || source.link || "",
  }));
}

function mapEmail(row) {
  if (!row) return null;

  return {
    id: row.id,
    subject: row.subject,
    body: row.body,
    category: row.category,
    priority: row.priority,
    draftReply: row.draft_reply,
    supportSources: JSON.parse(row.support_sources || "[]"),
    knowledgeBrainStatus: row.knowledge_brain_status,
    status: row.status,
    reviewNote: row.review_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function findEmail(id) {
  return db.prepare("SELECT * FROM emails WHERE id = ?").get(id);
}

function getEmailOrRespond(id, res) {
  const email = findEmail(id);

  if (!email) {
    res.status(404).json({ error: "Email not found." });
    return null;
  }

  return email;
}

// ==================================================
// 4. KNOWLEDGE BRAIN INTEGRATION
// ==================================================

async function askKnowledgeBrain(subject, body) {
  try {
    const response = await fetch(`${KNOWLEDGE_BRAIN_URL}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question:
          "Help answer this customer email using the support knowledge base.\n\n" +
          `Subject: ${subject}\n\nCustomer message:\n${body}`,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      console.error("Knowledge Brain returned HTTP", response.status);
      return null;
    }

    return await response.json();
  } catch (error) {
    console.error("Knowledge Brain unavailable:", error.message);
    return null;
  }
}

// ==================================================
// 5. HEALTH CHECK
// ==================================================

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "task2-inbox-agent",
    storage: "sqlite",
  });
});

// ==================================================
// 6. CLASSIFY EMAIL
// ==================================================

app.post("/classify", (req, res) => {
  const { subject, body } = req.body || {};

  if (!isValidText(subject) || !isValidText(body)) {
    return res.status(400).json({
      error: "Subject and body are required.",
    });
  }

  res.json(classifyEmail(subject, body));
});

// ==================================================
// 7. CREATE EMAIL AND GENERATE DRAFT
// ==================================================

app.post("/emails", async (req, res, next) => {
  try {
    const { subject, body } = req.body || {};

    if (!isValidText(subject) || !isValidText(body)) {
      return res.status(400).json({
        error: "Subject and body are required.",
      });
    }

    const classification = classifyEmail(subject, body);
    const knowledgeResult = await askKnowledgeBrain(subject, body);

    const rawSources =
      knowledgeResult?.sources ||
      knowledgeResult?.source_articles ||
      knowledgeResult?.results ||
      [];

    const sources = normalizeSources(rawSources);

    const answer =
      knowledgeResult?.answer ||
      knowledgeResult?.response ||
      knowledgeResult?.draft ||
      "";

    const knowledgeBrainStatus = knowledgeResult
      ? "connected"
      : "unavailable";

    const draftReply = createDraft(answer, sources);
    const now = new Date().toISOString();

    const insert = db.prepare(`
      INSERT INTO emails (
        subject,
        body,
        category,
        priority,
        draft_reply,
        support_sources,
        knowledge_brain_status,
        status,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_review', ?, ?)
    `);

    const result = insert.run(
      subject.trim(),
      body.trim(),
      classification.category,
      classification.priority,
      draftReply,
      JSON.stringify(sources),
      knowledgeBrainStatus,
      now,
      now
    );

    const email = mapEmail(findEmail(result.lastInsertRowid));

    res.status(201).json({
      message: "Email saved to SQLite. Human review is required.",
      email,
    });
  } catch (error) {
    next(error);
  }
});

// ==================================================
// 8. LIST EMAILS
// ==================================================

app.get("/emails", (_req, res) => {
  const rows = db
    .prepare("SELECT * FROM emails ORDER BY id DESC")
    .all();

  res.json({
    total: rows.length,
    emails: rows.map(mapEmail),
  });
});

// ==================================================
// 9. GET ONE EMAIL
// ==================================================

app.get("/emails/:id", (req, res) => {
  const id = parseId(req.params.id);

  if (!id) {
    return res.status(400).json({ error: "Invalid email ID." });
  }

  const row = getEmailOrRespond(id, res);
  if (!row) return;

  res.json(mapEmail(row));
});

// ==================================================
// 10. UPDATE DRAFT
// ==================================================

app.patch("/emails/:id/draft", (req, res) => {
  const id = parseId(req.params.id);
  const { draftReply } = req.body || {};

  if (!id) {
    return res.status(400).json({ error: "Invalid email ID." });
  }

  if (!isValidText(draftReply)) {
    return res.status(400).json({
      error: "A non-empty draftReply is required.",
    });
  }

  const row = getEmailOrRespond(id, res);
  if (!row) return;

  if (row.status !== "pending_review") {
    return res.status(409).json({
      error: "Only pending-review drafts can be edited.",
    });
  }

  db.prepare(`
    UPDATE emails
    SET draft_reply = ?, updated_at = ?
    WHERE id = ?
  `).run(draftReply.trim(), new Date().toISOString(), id);

  res.json({
    message: "Draft updated.",
    email: mapEmail(findEmail(id)),
  });
});

// ==================================================
// 11. APPROVE DRAFT
// Approval does NOT send an email.
// ==================================================

app.post("/emails/:id/approve", (req, res) => {
  const id = parseId(req.params.id);
  const { reviewNote } = req.body || {};

  if (!id) {
    return res.status(400).json({ error: "Invalid email ID." });
  }

  if (reviewNote !== undefined && typeof reviewNote !== "string") {
    return res.status(400).json({
      error: "reviewNote must be a string.",
    });
  }

  const row = getEmailOrRespond(id, res);
  if (!row) return;

  if (row.status !== "pending_review") {
    return res.status(409).json({
      error: "Only pending-review drafts can be approved.",
    });
  }

  db.prepare(`
    UPDATE emails
    SET status = 'approved', review_note = ?, updated_at = ?
    WHERE id = ?
  `).run(
    reviewNote?.trim() || null,
    new Date().toISOString(),
    id
  );

  res.json({
    message: "Draft approved. No email was sent.",
    email: mapEmail(findEmail(id)),
  });
});

// ==================================================
// 12. REJECT DRAFT
// ==================================================

app.post("/emails/:id/reject", (req, res) => {
  const id = parseId(req.params.id);
  const { reviewNote } = req.body || {};

  if (!id) {
    return res.status(400).json({ error: "Invalid email ID." });
  }

  if (reviewNote !== undefined && typeof reviewNote !== "string") {
    return res.status(400).json({
      error: "reviewNote must be a string.",
    });
  }

  const row = getEmailOrRespond(id, res);
  if (!row) return;

  if (row.status !== "pending_review") {
    return res.status(409).json({
      error: "Only pending-review drafts can be rejected.",
    });
  }

  db.prepare(`
    UPDATE emails
    SET status = 'rejected', review_note = ?, updated_at = ?
    WHERE id = ?
  `).run(
    reviewNote?.trim() || null,
    new Date().toISOString(),
    id
  );

  res.json({
    message: "Draft rejected.",
    email: mapEmail(findEmail(id)),
  });
});

// ==================================================
// 13. SAVE FEEDBACK
// ==================================================

app.post("/emails/:id/feedback", (req, res) => {
  const id = parseId(req.params.id);
  const { rating, comment } = req.body || {};

  if (!id) {
    return res.status(400).json({ error: "Invalid email ID." });
  }

  if (!["positive", "negative"].includes(rating)) {
    return res.status(400).json({
      error: "Rating must be 'positive' or 'negative'.",
    });
  }

  if (comment !== undefined && typeof comment !== "string") {
    return res.status(400).json({
      error: "Comment must be a string.",
    });
  }

  const email = getEmailOrRespond(id, res);
  if (!email) return;

  const result = db.prepare(`
    INSERT INTO email_feedback (email_id, rating, comment, created_at)
    VALUES (?, ?, ?, ?)
  `).run(
    id,
    rating,
    comment?.trim() || null,
    new Date().toISOString()
  );

  const feedback = db.prepare(`
    SELECT id, email_id, rating, comment, created_at
    FROM email_feedback
    WHERE id = ?
  `).get(result.lastInsertRowid);

  res.status(201).json({
    message: "Feedback saved.",
    feedback,
  });
});

// ==================================================
// 14. LIST FEEDBACK
// ==================================================

app.get("/feedback", (_req, res) => {
  const rows = db.prepare(`
    SELECT id, email_id, rating, comment, created_at
    FROM email_feedback
    ORDER BY id DESC
  `).all();

  res.json({
    total: rows.length,
    feedback: rows,
  });
});

// ==================================================
// 15. QUALITY METRICS
// ==================================================

app.get("/metrics", (_req, res) => {
  const feedback = db.prepare(`
    SELECT
      COUNT(*) AS totalFeedback,
      SUM(CASE WHEN rating = 'positive' THEN 1 ELSE 0 END)
        AS positiveFeedback,
      SUM(CASE WHEN rating = 'negative' THEN 1 ELSE 0 END)
        AS negativeFeedback
    FROM email_feedback
  `).get();

  const statuses = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM emails
    GROUP BY status
  `).all();

  const totalFeedback = feedback.totalFeedback || 0;
  const positiveFeedback = feedback.positiveFeedback || 0;

  const totalEmails = db.prepare(`
    SELECT COUNT(*) AS count FROM emails
  `).get().count;

  res.json({
    totalEmails,
    feedback: {
      total: totalFeedback,
      positive: positiveFeedback,
      negative: feedback.negativeFeedback || 0,
      positiveRate: totalFeedback > 0
        ? Number(
            (positiveFeedback / totalFeedback * 100).toFixed(2)
          )
        : null,
    },
    emailStatuses: statuses,
  });
});

// ==================================================
// 16. ERROR HANDLER
// ==================================================

app.use((err, _req, res, _next) => {
  console.error("Request error:", err.message);

  if (res.headersSent) return;

  res.status(500).json({
    error: "An internal server error occurred.",
  });
});

// ==================================================
// 17. START SERVER OR EXPORT FOR TESTS
// ==================================================

if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`Inbox Agent API running at http://localhost:${PORT}`);
    console.log(`SQLite database: ${dbPath}`);
  });

  function shutdown() {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} else {
  module.exports = { app, db };
}
