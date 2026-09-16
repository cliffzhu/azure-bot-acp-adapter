export type SuggestedQuestion = {
  title: string;
  value: string;
};

export type SuggestedQuestionParseResult = {
  matchedHeading: boolean;
  questions: SuggestedQuestion[];
  ignoredItems: number;
};

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_match, code: string) => String.fromCodePoint(parseInt(code, 16)));
}

function htmlToText(value: string): string {
  return decodeHtmlEntities(value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

/** Extract numbered suggested questions from the response's HTML section. */
export function parseSuggestedQuestionsWithDiagnostics(html: string): SuggestedQuestionParseResult {
  const headingMatch = [...html.matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi)]
    .find((match) => /^Suggested Questions\b/i.test(htmlToText(match[1])));
  if (!headingMatch || headingMatch.index === undefined) {
    return { matchedHeading: false, questions: [], ignoredItems: 0 };
  }

  const afterHeading = html.slice(headingMatch.index + headingMatch[0].length);
  const section = afterHeading.split(/<h[1-6][^>]*>/i, 1)[0];
  const questions: SuggestedQuestion[] = [];
  const numberedItems = new Set<string>();
  let ignoredItems = 0;

  for (const item of section.matchAll(/<(?:p|li)\b[^>]*>([\s\S]*?)<\/(?:p|li)>/gi)) {
    const text = htmlToText(item[1]);
    const questionMatch = text.match(/^\d+[.)]\s*(.+)$/);
    if (!questionMatch) {
      continue;
    }

    numberedItems.add(text);
    if (questionMatch[1].trim().length === 0) {
      ignoredItems++;
      continue;
    }

    const question = questionMatch[1].trim();
    questions.push({ title: question, value: question });
  }

  for (const line of htmlToText(section).split(/\r?\n|(?=\d+[.)]\s)/)) {
    const text = line.trim();
    const questionMatch = text.match(/^\d+[.)]\s*(.+)$/);
    if (!questionMatch || numberedItems.has(text)) {
      continue;
    }

    if (questionMatch[1].trim().length === 0) {
      ignoredItems++;
      continue;
    }

    const question = questionMatch[1].trim();
    questions.push({ title: question, value: question });
  }

  return { matchedHeading: true, questions, ignoredItems };
}

export function parseSuggestedQuestions(html: string): SuggestedQuestion[] {
  return parseSuggestedQuestionsWithDiagnostics(html).questions;
}