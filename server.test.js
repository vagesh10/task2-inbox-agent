
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "inbox-agent-test-")
);

process.env.INBOX_DB_PATH = path.join(testDirectory, "test.db");
process.env.PORT = "0";

const { app, db } = require("./dist/server");

let server;
let baseUrl;

before(async () => {
  server = app.listen(0, "127.0.0.1");

  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }

  db.close();
  fs.rmSync(testDirectory, { recursive: true, force: true });
});

async function createEmail(subject, body) {
  const response = await fetch(`${baseUrl}/emails`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subject, body }),
  });

  assert.equal(response.status, 201);
  return (await response.json()).email;
}

test("health endpoint reports healthy status", async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);

  const result = await response.json();
  assert.equal(result.status, "ok");
});

test("classifies urgent billing emails", async () => {
  const response = await fetch(`${baseUrl}/classify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      subject: "Urgent invoice issue",
      body: "Please check my billing immediately.",
    }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    category: "billing",
    priority: "high",
  });
});

test("creates an email pending human review", async () => {
  const email = await createEmail(
    "Test email",
    "Please help me with my website."
  );

  assert.ok(email.id > 0);
  assert.equal(email.status, "pending_review");
  assert.equal(email.subject, "Test email");
});

test("saves feedback and updates metrics", async () => {
  const email = await createEmail(
    "Feedback test",
    "Please review this question."
  );

  const feedbackResponse = await fetch(
    `${baseUrl}/emails/${email.id}/feedback`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rating: "positive",
        comment: "Helpful",
      }),
    }
  );

  assert.equal(feedbackResponse.status, 201);

  const metricsResponse = await fetch(`${baseUrl}/metrics`);
  const metrics = await metricsResponse.json();

  assert.equal(metrics.totalEmails, 2);
  assert.equal(metrics.feedback.total, 1);
  assert.equal(metrics.feedback.positive, 1);
});

test("approves a draft without sending an email", async () => {
  const email = await createEmail(
    "Approval test",
    "Please review this draft."
  );

  const response = await fetch(
    `${baseUrl}/emails/${email.id}/approve`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reviewNote: "Approved in test",
      }),
    }
  );

  assert.equal(response.status, 200);

  const result = await response.json();
  assert.equal(result.email.status, "approved");
  assert.match(result.message, /No email was sent/i);
});

test("rejects a draft and saves the review note", async () => {
  const email = await createEmail(
    "Rejection test",
    "Please review this draft."
  );

  const response = await fetch(
    `${baseUrl}/emails/${email.id}/reject`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reviewNote: "Rejected in test",
      }),
    }
  );

  assert.equal(response.status, 200);

  const result = await response.json();
  assert.equal(result.email.status, "rejected");
  assert.equal(result.email.reviewNote, "Rejected in test");
});
