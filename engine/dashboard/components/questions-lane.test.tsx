import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NeedsYou, OpenQuestions } from "./questions-lane.js";
import type { SnapshotQuestion } from "../../src/snapshot.js";

function question(over: Partial<SnapshotQuestion> = {}): SnapshotQuestion {
  return {
    id: 1,
    asker: "expo",
    question: "which approach?",
    state: "needs_human",
    answer: null,
    resolvedBy: null,
    answeredVia: null,
    recommendation: null,
    priority: null,
    outcome: null,
    outcomeNote: null,
    outcomeAt: null,
    options: null,
    multiSelect: false,
    at: 1000,
    ...over,
  };
}

/**
 * hands#209: AnswerOptions returned null before reaching its own free-text fallback whenever a
 * question had no structured `options` — an open-ended escalation rendered with no way to answer
 * it at all. This is the regression the fix targets: the free-text form must render regardless of
 * whether options exist.
 */
describe("AnswerOptions (via OpenQuestions/NeedsYou) — free-text stays reachable (hands#209)", () => {
  it("an option-less needs_human question still renders an answerable free-text form", () => {
    const html = renderToStaticMarkup(
      <OpenQuestions questions={[question({ options: null })]} now={2000} />,
    );
    expect(html).toContain("something else…"); // the free-text input's placeholder
    expect(html).toContain("Answer"); // the free-text submit button
  });

  it("NeedsYou (the alert strip) renders the same free-text form for an option-less escalation", () => {
    const html = renderToStaticMarkup(
      <NeedsYou questions={[question({ options: null })]} principal="Michael" now={2000} />,
    );
    expect(html).toContain("something else…");
    expect(html).toContain("Answer");
  });

  it("a structured question still gets its option buttons AND the free-text fallback", () => {
    const html = renderToStaticMarkup(
      <OpenQuestions
        questions={[
          question({
            options: [
              { label: "A", description: "do A" },
              { label: "B", description: "do B", recommended: true },
            ],
          }),
        ]}
        now={2000}
      />,
    );
    expect(html).toContain(">A<");
    expect(html).toContain(">B<");
    expect(html).toContain("something else…"); // never lost just because options exist
  });

  it("a question not in needs_human state renders no answer UI at all", () => {
    const html = renderToStaticMarkup(
      <OpenQuestions questions={[question({ state: "open", options: null })]} now={2000} />,
    );
    expect(html).not.toContain("something else…");
  });
});
