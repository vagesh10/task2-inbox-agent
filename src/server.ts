
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import cors from "cors";
import dotenv from "dotenv";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const KNOWLEDGE_BRAIN_URL =
  process.env.KNOWLEDGE_BRAIN_URL || "http://127.0.0.1:8000";

const REQUIRED_UNCHANGED_DRAFTS = 20;

// Database location remains compatible with the existing project.
const dataDirectory = path.resolve(__dirname, "../data");
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

  CREATE TABLE IF NOT EXISTS category_quality (
    category TEXT PRIMARY KEY,
    consecutive_unchanged INTEGER NOT NULL DEFAULT 0,
    auto_send_eligible INTEGER NOT NULL DEFAULT 0
      CHECK(auto_send_eligible IN (0, 1)),
    total_reviewed INTEGER NOT NULL DEFAULT 0,
    total_positive INTEGER NOT NULL DEFAULT 0,
    total_negative INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
`);

// Safe migration: older databases do not have this column.
const emailColumns = db
  .prepare("PRAGMA table_info(emails)")
  .all() as Array<{ name: string }>;

if (!emailColumns.some((column) => column.name === "original_draft_reply")) {
  db.exec("ALTER TABLE emails ADD COLUMN original_draft_reply TEXT");
}

// Preserve existing records by treating their current draft as the baseline.
db.exec(`
  UPDATE emails
  SET original_draft_reply = draft_reply
  WHERE original_draft_reply IS NULL
`);

app.use(cors());
app.use(express.json({ limit: "1mb" }));

type SupportSource = {
  id: string;
  title: string;
  url: string;
};

type EmailStatus = "pending_review" | "approved" | "rejected";

type EmailRow = {
  id: number;
  subject: string;
  body: string;
  category: string;
  priority: string;
  draft_reply: string;
  original_draft_reply: string | null;
  support_sources: string;
  knowledge_brain_status: string;
  status: EmailStatus;
  review_note: string | null;
  created_at: string;
  updated_at: string;
};

type CategoryQualityRow = {
  category: string;
  consecutive_unchanged: number;
  auto_send_eligible: number;
  total_reviewed: number;
  total_positive: number;
  total_negative: number;
  updated_at: string;
};

function isValidText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseId(value: string | string[]): number | null {
  if (typeof value !== "string") return null;

  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function classifyEmail(subject: string, body: string) {
  const text = `${subject} ${body}`.toLowerCase();

  let category = "general";
  let priority = "normal";

  if (/\burgent\b|\basap\b|\bimmediately\b|\bcritical\b/.test(text)) {
    priority = "high";
  }

  if (/\brefund\b|\bpayment\b|\binvoice\b|\bbilling\b/.test(text)) {
    category = "billing";
  } else if (
    /\bbug\b|\berror\b|\bnot working\b|\bbroken\b|\btechnical\b/.test(text)
  ) {
    category = "technical_support";
  } else if (/\bmeeting\b|\bschedule\b|\bappointment\b/.test(text)) {
    category = "scheduling";
  } else if (/\bcomplaint\b|\bunhappy\b|\bdissatisfied\b/.test(text)) {
    category = "complaint";
  }

  return { category, priority };
}

function normalizeSources(value: unknown): SupportSource[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && !Array.isArray(item),
    )
    .map((item, index) => ({
      id: String(item.id || `S${index + 1}`),
      title: String(item.title || item.name || "Support article"),
      url: String(item.url || item.link || ""),
    }));
}

function createDraft(answer: string, sources: SupportSource[]) {
  if (answer.trim()) {
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

function mapEmail(row: EmailRow | undefined) {
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

function findEmail(id: number) {
  return db.prepare("SELECT * FROM emails WHERE id = ?").get(id) as
    | EmailRow
    | undefined;
}

function getEmailOrRespond(id: number, res: Response) {
  const email = findEmail(id);

  if (!email) {
    res.status(404).json({ error: "Email not found." });
    return null;
  }

  return email;
}

function ensureCategoryQuality(category: string): CategoryQualityRow {
  const now = new Date().toISOString();

  db.prepare(`
    INSERT OR IGNORE INTO category_quality (category, updated_at)
    VALUES (?, ?)
  `).run(category, now);

  return db.prepare(
    "SELECT * FROM category_quality WHERE category = ?",
  ).get(category) as CategoryQualityRow;
}

function recordReview(
  email: EmailRow,
  unchanged: boolean,
  approved: boolean,
) {
  const current = ensureCategoryQuality(email.category);
  const now = new Date().toISOString();

  // A changed or rejected draft breaks the consecutive-unchanged sequence.
  const consecutiveUnchanged =
    approved && unchanged ? current.consecutive_unchanged + 1 : 0;

  const eligible = consecutiveUnchanged >= REQUIRED_UNCHANGED_DRAFTS ? 1 : 0;

  db.prepare(`
    UPDATE category_quality
    SET consecutive_unchanged = ?,
        auto_send_eligible = ?,
        total_reviewed = total_reviewed + 1,
        updated_at = ?
    WHERE category = ?
  `).run(consecutiveUnchanged, eligible, now, email.category);
}

async function askKnowledgeBrain(subject: string, body: string) {
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

    return (await response.json()) as Record<string, unknown>;
  } catch (error) {
    console.error(
      "Knowledge Brain unavailable:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

// Health
app.get("/health", (_req: Request, res: Response) => {
  return res.json({
    status: "ok",
    service: "task2-inbox-agent",
    storage: "sqlite",
  });
});

// Classification
app.post("/classify", (req: Request, res: Response) => {
  const { subject, body } = req.body || {};

  if (!isValidText(subject) || !isValidText(body)) {
    return res.status(400).json({
      error: "Subject and body are required.",
    });
  }

  return res.json(classifyEmail(subject, body));
});

// Create a draft; this endpoint never sends email.
app.post("/emails", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { subject, body } = req.body || {};

    if (!isValidText(subject) || !isValidText(body)) {
      return res.status(400).json({
        error: "Subject and body are required.",
      });
    }

    const classification = classifyEmail(subject, body);
    const result = await askKnowledgeBrain(subject, body);

    const sources = normalizeSources(
      result?.sources || result?.source_articles || result?.results,
    );

    const answer = String(
      result?.answer || result?.response || result?.draft || "",
    );

    const draftReply = createDraft(answer, sources);
    const now = new Date().toISOString();

    const inserted = db.prepare(`
      INSERT INTO emails (
        subject, body, category, priority, draft_reply,
        original_draft_reply, support_sources, knowledge_brain_status,
        status, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', ?, ?)
    `).run(
      subject.trim(),
      body.trim(),
      classification.category,
      classification.priority,
      draftReply,
      draftReply,
      JSON.stringify(sources),
      result ? "connected" : "unavailable",
      now,
      now,
    );

    return res.status(201).json({
      message: "Email saved to SQLite. Human review is required.",
      email: mapEmail(findEmail(Number(inserted.lastInsertRowid))),
    });
  } catch (error) {
    return next(error);
  }
});

// List emails
app.get("/emails", (_req: Request, res: Response) => {
  const rows = db
    .prepare("SELECT * FROM emails ORDER BY id DESC")
    .all() as EmailRow[];

  return res.json({
    total: rows.length,
    emails: rows.map(mapEmail),
  });
});

// Get one email
app.get("/emails/:id", (req: Request, res: Response) => {
  const id = parseId(req.params.id);

  if (!id) {
    return res.status(400).json({ error: "Invalid email ID." });
  }

  const email = getEmailOrRespond(id, res);
  if (!email) return;

  return res.json(mapEmail(email));
});

// Edit a pending draft
app.patch("/emails/:id/draft", (req: Request, res: Response) => {
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

  const email = getEmailOrRespond(id, res);
  if (!email) return;

  if (email.status !== "pending_review") {
    return res.status(409).json({
      error: "Only pending-review drafts can be edited.",
    });
  }

  db.prepare(`
    UPDATE emails SET draft_reply = ?, updated_at = ? WHERE id = ?
  `).run(draftReply.trim(), new Date().toISOString(), id);

  return res.json({
    message: "Draft updated.",
    email: mapEmail(findEmail(id)),
  });
});

// Approve a draft without sending it
app.post("/emails/:id/approve", (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  const { reviewNote } = req.body || {};

  if (!id) {
    return res.status(400).json({ error: "Invalid email ID." });
  }

  if (reviewNote !== undefined && typeof reviewNote !== "string") {
    return res.status(400).json({ error: "reviewNote must be a string." });
  }

  const email = getEmailOrRespond(id, res);
  if (!email) return;

  if (email.status !== "pending_review") {
    return res.status(409).json({
      error: "Only pending-review drafts can be approved.",
    });
  }

  const unchanged =
    email.original_draft_reply !== null &&
    email.draft_reply === email.original_draft_reply;

  const now = new Date().toISOString();

  // Update status and quality counters together.
  const approveTransaction = db.transaction(() => {
    db.prepare(`
      UPDATE emails
      SET status = 'approved', review_note = ?, updated_at = ?
      WHERE id = ?
    `).run(reviewNote?.trim() || null, now, id);

    recordReview(email, unchanged, true);
  });

  approveTransaction();

  return res.json({
    message: "Draft approved. No email was sent.",
    email: mapEmail(findEmail(id)),
    draftUnchanged: unchanged,
    categoryQuality: ensureCategoryQuality(email.category),
  });
});

// Reject a draft; rejection resets the consecutive-unchanged sequence.
app.post("/emails/:id/reject", (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  const { reviewNote } = req.body || {};

  if (!id) {
    return res.status(400).json({ error: "Invalid email ID." });
  }

  if (reviewNote !== undefined && typeof reviewNote !== "string") {
    return res.status(400).json({ error: "reviewNote must be a string." });
  }

  const email = getEmailOrRespond(id, res);
  if (!email) return;

  if (email.status !== "pending_review") {
    return res.status(409).json({
      error: "Only pending-review drafts can be rejected.",
    });
  }

  const now = new Date().toISOString();

  const rejectTransaction = db.transaction(() => {
    db.prepare(`
      UPDATE emails
      SET status = 'rejected', review_note = ?, updated_at = ?
      WHERE id = ?
    `).run(reviewNote?.trim() || null, now, id);

    recordReview(email, false, false);
  });

  rejectTransaction();

  return res.json({
    message: "Draft rejected.",
    email: mapEmail(findEmail(id)),
    categoryQuality: ensureCategoryQuality(email.category),
  });
});

// Save feedback. Negative feedback revokes category eligibility immediately.
app.post("/emails/:id/feedback", (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  const { rating, comment } = req.body || {};

  if (!id) {
    return res.status(400).json({ error: "Invalid email ID." });
  }

  if (rating !== "positive" && rating !== "negative") {
    return res.status(400).json({
      error: "Rating must be 'positive' or 'negative'.",
    });
  }

  if (comment !== undefined && typeof comment !== "string") {
    return res.status(400).json({ error: "Comment must be a string." });
  }

  const email = getEmailOrRespond(id, res);
  if (!email) return;

  const now = new Date().toISOString();

  const feedbackTransaction = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO email_feedback (email_id, rating, comment, created_at)
      VALUES (?, ?, ?, ?)
    `).run(id, rating, comment?.trim() || null, now);

    const quality = ensureCategoryQuality(email.category);

    if (rating === "negative") {
      db.prepare(`
        UPDATE category_quality
        SET total_negative = total_negative + 1,
            consecutive_unchanged = 0,
            auto_send_eligible = 0,
            updated_at = ?
        WHERE category = ?
      `).run(now, email.category);
    } else {
      db.prepare(`
        UPDATE category_quality
        SET total_positive = total_positive + 1,
            updated_at = ?
        WHERE category = ?
      `).run(now, email.category);
    }

    const feedback = db.prepare(`
      SELECT id, email_id, rating, comment, created_at
      FROM email_feedback WHERE id = ?
    `).get(result.lastInsertRowid);

    return {
      feedback,
      categoryQuality: db.prepare(
        "SELECT * FROM category_quality WHERE category = ?",
      ).get(email.category),
    };
  });

  const saved = feedbackTransaction();

  return res.status(201).json({
    message: "Feedback saved.",
    ...saved,
  });
});

// List feedback
app.get("/feedback", (_req: Request, res: Response) => {
  const feedback = db.prepare(`
    SELECT id, email_id, rating, comment, created_at
    FROM email_feedback ORDER BY id DESC
  `).all();

  return res.json({ total: feedback.length, feedback });
});

// Category eligibility and quality tracking
app.get("/categories/eligibility", (_req: Request, res: Response) => {
  const categories = db.prepare(`
    SELECT category,
           consecutive_unchanged AS consecutiveUnchanged,
           auto_send_eligible AS autoSendEligible,
           total_reviewed AS totalReviewed,
           total_positive AS totalPositive,
           total_negative AS totalNegative,
           updated_at AS updatedAt
    FROM category_quality
    ORDER BY category
  `).all();

  return res.json({
    requiredConsecutiveUnchangedDrafts: REQUIRED_UNCHANGED_DRAFTS,
    automaticSendingEnabled: false,
    categories,
  });
});

// Metrics
app.get("/metrics", (_req: Request, res: Response) => {
  const feedback = db.prepare(`
    SELECT
      COUNT(*) AS totalFeedback,
      SUM(CASE WHEN rating = 'positive' THEN 1 ELSE 0 END) AS positiveFeedback,
      SUM(CASE WHEN rating = 'negative' THEN 1 ELSE 0 END) AS negativeFeedback
    FROM email_feedback
  `).get() as {
    totalFeedback: number;
    positiveFeedback: number | null;
    negativeFeedback: number | null;
  };

  const statuses = db.prepare(`
    SELECT status, COUNT(*) AS count FROM emails GROUP BY status
  `).all();

  const totalEmails = (
    db.prepare("SELECT COUNT(*) AS count FROM emails").get() as {
      count: number;
    }
  ).count;

  const totalFeedback = feedback.totalFeedback || 0;
  const positive = feedback.positiveFeedback || 0;

  const categoryQuality = db.prepare(`
    SELECT category,
           consecutive_unchanged AS consecutiveUnchanged,
           auto_send_eligible AS autoSendEligible,
           total_reviewed AS totalReviewed,
           total_positive AS totalPositive,
           total_negative AS totalNegative,
           updated_at AS updatedAt
    FROM category_quality
    ORDER BY category
  `).all();

  return res.json({
    totalEmails,
    feedback: {
      total: totalFeedback,
      positive,
      negative: feedback.negativeFeedback || 0,
      positiveRate:
        totalFeedback > 0
          ? Number(((positive / totalFeedback) * 100).toFixed(2))
          : null,
    },
    emailStatuses: statuses,
    categoryQuality,
    automaticSendingEnabled: false,
  });
});

// Central error handler
app.use(
  (err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("Request error:", err.message);
    if (res.headersSent) return;
    res.status(500).json({ error: "An internal server error occurred." });
  },
);

export { app, db };

if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`Inbox Agent API running at http://localhost:${PORT}`);
    console.log(`SQLite database: ${dbPath}`);
  });

  const shutdown = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
