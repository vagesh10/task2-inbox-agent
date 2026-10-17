
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const KNOWLEDGE_BRAIN_URL =
  process.env.KNOWLEDGE_BRAIN_URL || "http://127.0.0.1:8000";

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const emails = [];
let nextId = 1;

function isValidText(value) {
  return typeof value === "string" && value.trim().length > 0;
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

function createDraft() {
  return "Thank you for contacting us. We have received your message and will review it before responding with the appropriate information.";
}

async function askKnowledgeBrain(subject, body) {
  try {
    const response = await fetch(`${KNOWLEDGE_BRAIN_URL}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question:
          `Help answer this customer email using the support knowledge base.\n\n` +
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

function findEmail(id) {
  return emails.find((email) => email.id === id);
}

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "task2-inbox-agent",
  });
});

// Classify without saving.
app.post("/classify", (req, res) => {
  const { subject, body } = req.body || {};

  if (!isValidText(subject) || !isValidText(body)) {
    return res.status(400).json({
      error: "Both subject and body are required.",
    });
  }

  const { category, priority } = classifyEmail(subject, body);

  res.json({
    subject,
    category,
    priority,
    draftReply: createDraft(),
    mode: "mock",
    requiresHumanReview: true,
  });
});

// Save email and prepare a draft using available support information.
app.post("/emails", async (req, res) => {
  const { subject, body } = req.body || {};

  if (!isValidText(subject) || !isValidText(body)) {
    return res.status(400).json({
      error: "Both subject and body are required.",
    });
  }

  const { category, priority } = classifyEmail(subject, body);
  const knowledge = await askKnowledgeBrain(subject.trim(), body.trim());

  const knowledgeBrainStatus = !knowledge
    ? "unavailable"
    : knowledge.abstained
      ? "abstained"
      : "connected";

  const supportSources =
    knowledgeBrainStatus === "connected" &&
    Array.isArray(knowledge.sources)
      ? knowledge.sources
      : [];

  const draftReply =
    knowledgeBrainStatus === "connected" &&
    typeof knowledge.answer === "string" &&
    knowledge.answer.trim()
      ? `Thank you for contacting us.\n\n${knowledge.answer}\n\nWe will review your request and follow up as needed.`
      : createDraft();

  const now = new Date().toISOString();

  const email = {
    id: nextId++,
    subject: subject.trim(),
    body: body.trim(),
    category,
    priority,
    draftReply,
    supportSources,
    knowledgeBrainStatus,
    status: "pending_review",
    createdAt: now,
    updatedAt: now,
  };

  emails.push(email);

  res.status(201).json({
    message: "Email saved. Human review is required.",
    email,
  });
});

// List saved emails.
app.get("/emails", (_req, res) => {
  res.json({ total: emails.length, emails });
});

// Get a single email.
app.get("/emails/:id", (req, res) => {
  const id = parseId(req.params.id);

  if (!id) {
    return res.status(400).json({ error: "Invalid email ID." });
  }

  const email = findEmail(id);

  if (!email) {
    return res.status(404).json({ error: "Email not found." });
  }

  res.json(email);
});

// Edit a draft before review is finalized.
app.patch("/emails/:id/draft", (req, res) => {
  const id = parseId(req.params.id);

  if (!id) {
    return res.status(400).json({ error: "Invalid email ID." });
  }

  const email = findEmail(id);

  if (!email) {
    return res.status(404).json({ error: "Email not found." });
  }

  if (email.status !== "pending_review") {
    return res.status(409).json({
      error: "Only drafts pending review can be edited.",
    });
  }

  const { draftReply } = req.body || {};

  if (!isValidText(draftReply)) {
    return res.status(400).json({
      error: "A non-empty draftReply is required.",
    });
  }

  email.draftReply = draftReply.trim();
  email.updatedAt = new Date().toISOString();

  res.json({ message: "Draft updated successfully.", email });
});

// Approve the draft. This does not send an email.
app.post("/emails/:id/approve", (req, res) => {
  const id = parseId(req.params.id);

  if (!id) {
    return res.status(400).json({ error: "Invalid email ID." });
  }

  const email = findEmail(id);

  if (!email) {
    return res.status(404).json({ error: "Email not found." });
  }

  if (email.status !== "pending_review") {
    return res.status(409).json({
      error: "Only emails pending review can be approved.",
    });
  }

  email.status = "approved";
  email.updatedAt = new Date().toISOString();

  res.json({
    message: "Draft approved. No email was sent.",
    email,
  });
});

// Reject the draft.
app.post("/emails/:id/reject", (req, res) => {
  const id = parseId(req.params.id);

  if (!id) {
    return res.status(400).json({ error: "Invalid email ID." });
  }

  const email = findEmail(id);

  if (!email) {
    return res.status(404).json({ error: "Email not found." });
  }

  if (email.status !== "pending_review") {
    return res.status(409).json({
      error: "Only emails pending review can be rejected.",
    });
  }

  const { reviewNote } = req.body || {};

  if (reviewNote !== undefined && typeof reviewNote !== "string") {
    return res.status(400).json({
      error: "reviewNote must be a string.",
    });
  }

  email.status = "rejected";
  email.reviewNote = reviewNote?.trim() || "No reason provided.";
  email.updatedAt = new Date().toISOString();

  res.json({ message: "Draft rejected.", email });
});

app.listen(PORT, () => {
  console.log(`Inbox Agent API running at http://localhost:${PORT}`);
});
