/**
 * A drafted summary is markdown with a "**Next steps:**" numbered list. The server stores each
 * step as its own row, and the page shows the text around the list as it is, so both split it here.
 */
export interface SummaryParts {
  /** Up to and including the "Next steps" heading; the whole summary when it has no steps. */
  before: string;
  steps: string[];
  after: string;
}

const HEADING = /^\s*(?:#+\s*)?(?:\*\*)?\s*next steps\s*:?\s*(?:\*\*)?\s*:?\s*$/i;
const ITEM = /^\s*(?:\d+[.)]|[-*•])\s+/;
/** A new bold label ("**Blockers:**") or heading ends the list. */
const SECTION = /^\s*(?:\*\*[^*]+:?\*\*|#+\s)/;

export function splitSummary(summary: string): SummaryParts {
  const lines = summary.replace(/\r/g, "").split("\n");
  const head = lines.findIndex((l) => HEADING.test(l));
  if (head < 0) return { before: summary, steps: [], after: "" };

  const steps: string[] = [];
  let i = head + 1;
  while (i < lines.length && !lines[i].trim()) i++;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (ITEM.test(line)) steps.push(line.replace(ITEM, "").trim());
    else if (!line.trim() || SECTION.test(line) || steps.length === 0) break;
    // An indented or wrapped line continues the step above it.
    else steps[steps.length - 1] += ` ${line.trim()}`;
  }
  if (steps.length === 0) return { before: summary, steps: [], after: "" };
  return { before: lines.slice(0, head + 1).join("\n"), steps, after: lines.slice(i).join("\n").trim() };
}
