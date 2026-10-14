import { parseSuggestedQuestionsWithDiagnostics } from "./suggestedQuestionParser";

export type ResponseLayoutAnalysis = {
  conforms: boolean;
  hasHtmlMarkup: boolean;
  hasSuggestedQuestionsHeading: boolean;
  suggestedQuestionCount: number;
  missingSignals: string[];
};

export type ResponseLayoutRequirements = {
  requireHtmlMarkup?: boolean;
  requiredHeading?: string;
  minSuggestedQuestions?: number;
};

export function logRawFallbackResponse(params: {
  conversationKey: string;
  sessionId: string;
  attempt: number;
  maxAttempts: number;
  rawResponse: string;
  layoutConforms: boolean;
  missingSignals: string[];
}): void {
  console.info("[response-layout-guard] raw upstream response", params);
}

/**
 * Detects obvious deviations from the observed HR-agent response contract.
 * This is a layout/instruction-adherence signal, not a factuality check and
 * not proof that the backend used the wrong system prompt.
 */
export function analyzeResponseLayout(
  responseText: string,
  requirements: ResponseLayoutRequirements = {}
): ResponseLayoutAnalysis {
  const requireHtmlMarkup = requirements.requireHtmlMarkup ?? true;
  const requiredHeading = requirements.requiredHeading ?? "Suggested Questions";
  const minSuggestedQuestions = requirements.minSuggestedQuestions ?? 1;
  const suggestions = parseSuggestedQuestionsWithDiagnostics(responseText, requiredHeading);
  const hasHtmlMarkup = /<[a-z][^>]*>/i.test(responseText);
  const missingSignals: string[] = [];

  if (requireHtmlMarkup && !hasHtmlMarkup) {
    missingSignals.push("html_markup");
  }
  if (requiredHeading.trim().length > 0 && !suggestions.matchedHeading) {
    missingSignals.push("suggested_questions_heading");
  }
  if (suggestions.questions.length < minSuggestedQuestions) {
    missingSignals.push("suggested_question_items");
  }

  return {
    conforms: missingSignals.length === 0,
    hasHtmlMarkup,
    hasSuggestedQuestionsHeading: suggestions.matchedHeading,
    suggestedQuestionCount: suggestions.questions.length,
    missingSignals
  };
}

export const RESPONSE_LAYOUT_FALLBACK =
  "I couldn't verify this response against the HR assistant's required answer format. Please contact HR for confirmation.";
