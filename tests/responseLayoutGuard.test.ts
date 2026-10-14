import test from "node:test";
import assert from "node:assert/strict";
import { analyzeResponseLayout, logRawFallbackResponse, RESPONSE_LAYOUT_FALLBACK } from "../src/responseLayoutGuard";

const knownGoodDressCodeReply = `<p>Beedie does not have a formal office dress code policy. Employees are encouraged to dress professionally and appropriately for the workplace.</p>
<h4>Suggested Questions (reply with the item number only):</h4>
<p>1. Are pets allowed in the office?</p><p>2. What is Beedie's work-from-home policy?</p>`;

const genericOutlierReply =
  "Dress-code requirements depend on your workplace and role. Check your employee handbook or HR portal; if unclear, ask your manager or HR—especially for safety footwear, PPE, client-facing attire, or casual-day rules.";

test("accepts the observed Beedie-specific response layout", () => {
  const result = analyzeResponseLayout(knownGoodDressCodeReply);

  assert.equal(result.conforms, true);
  assert.deepEqual(result.missingSignals, []);
  assert.equal(result.suggestedQuestionCount, 2);
});

test("flags the Oct 8 generic reply as a layout/instruction deviation", () => {
  const result = analyzeResponseLayout(genericOutlierReply);

  assert.equal(result.conforms, false);
  assert.deepEqual(result.missingSignals, [
    "html_markup",
    "suggested_questions_heading",
    "suggested_question_items"
  ]);
});

test("provides an adapter-owned fallback for flagged replies", () => {
  assert.match(RESPONSE_LAYOUT_FALLBACK, /couldn't verify this response/i);
});

test("logs the complete raw upstream response and layout result", () => {
  const originalInfo = console.info;
  const calls: unknown[][] = [];
  console.info = (...args: unknown[]) => { calls.push(args); };

  try {
    logRawFallbackResponse({
      conversationKey: "conversation-1",
      sessionId: "session-1",
      attempt: 1,
      maxAttempts: 2,
      rawResponse: genericOutlierReply,
      layoutConforms: false,
      missingSignals: ["html_markup", "suggested_questions_heading", "suggested_question_items"]
    });
  } finally {
    console.info = originalInfo;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "[response-layout-guard] raw upstream response");
  assert.deepEqual(calls[0][1], {
    conversationKey: "conversation-1",
    sessionId: "session-1",
    attempt: 1,
    maxAttempts: 2,
    rawResponse: genericOutlierReply,
    layoutConforms: false,
    missingSignals: ["html_markup", "suggested_questions_heading", "suggested_question_items"]
  });
});

test("supports a custom required heading and question count", () => {
  const result = analyzeResponseLayout(
    "<p>Answer</p><h4>Follow-up topics</h4><p>1. What next?</p>",
    { requiredHeading: "Follow-up topics", minSuggestedQuestions: 1 }
  );

  assert.equal(result.conforms, true);
  assert.equal(result.hasSuggestedQuestionsHeading, true);
  assert.equal(result.suggestedQuestionCount, 1);
});

test("supports a plain-text response contract with no required heading", () => {
  const result = analyzeResponseLayout("Plain text answer", {
    requireHtmlMarkup: false,
    requiredHeading: "",
    minSuggestedQuestions: 0
  });

  assert.equal(result.conforms, true);
  assert.deepEqual(result.missingSignals, []);
});
