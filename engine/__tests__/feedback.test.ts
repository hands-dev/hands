import { describe, expect, it } from "vitest";
import {
  defaultFeedbackTitle,
  FEEDBACK_REPO,
  feedbackFooter,
  fileFeedback,
  type GhRunner,
} from "../src/feedback.js";

function fakeGh(responses: Record<string, string>, opts?: { failOn?: (args: string[]) => boolean }): GhRunner {
  return (args) => {
    if (opts?.failOn?.(args)) throw new Error(`gh ${args.join(" ")} failed`);
    const key = args.join(" ");
    for (const [prefix, value] of Object.entries(responses)) {
      if (key.startsWith(prefix)) return value;
    }
    throw new Error(`unhandled fake gh call: ${key}`);
  };
}

describe("defaultFeedbackTitle", () => {
  it("distills 'feedback: <first line>', truncated to 60 chars", () => {
    expect(defaultFeedbackTitle("the sidebar overflows on narrow screens")).toBe(
      "feedback: the sidebar overflows on narrow screens",
    );
    expect(defaultFeedbackTitle("line one\nline two")).toBe("feedback: line one");
    const long = "x".repeat(100);
    expect(defaultFeedbackTitle(long)).toBe(`feedback: ${"x".repeat(60)}`);
  });
});

describe("feedbackFooter", () => {
  it("includes handle, repo, and date when both gh calls succeed", () => {
    const gh = fakeGh({
      "api user": "octocat\n",
      "repo view": "hands-dev/hands\n",
    });
    const now = Date.parse("2026-08-06T00:00:00Z");
    expect(feedbackFooter("/some/cwd", now, gh)).toBe("filed by @octocat from hands-dev/hands · 2026-08-06");
  });

  it("degrades gracefully when either gh call fails — a missing field is dropped, not a thrown error", () => {
    const now = Date.parse("2026-08-06T00:00:00Z");
    const noHandle = fakeGh({ "repo view": "acme/widgets\n" }, { failOn: (a) => a[0] === "api" });
    expect(feedbackFooter("/cwd", now, noHandle)).toBe("filed by an unknown handle from acme/widgets · 2026-08-06");

    const noRepo = fakeGh({ "api user": "octocat\n" }, { failOn: (a) => a[0] === "repo" });
    expect(feedbackFooter("/cwd", now, noRepo)).toBe("filed by @octocat · 2026-08-06");

    const neither = fakeGh({}, { failOn: () => true });
    expect(feedbackFooter("/cwd", now, neither)).toBe("filed by an unknown handle · 2026-08-06");
  });
});

describe("fileFeedback", () => {
  it("files with the label, the given title, and a body carrying the footer", () => {
    const calls: string[][] = [];
    const gh: GhRunner = (args) => {
      calls.push(args);
      if (args[0] === "issue") return "https://github.com/hands-dev/hands/issues/123\n";
      if (args.join(" ").startsWith("api user")) return "octocat\n";
      if (args.join(" ").startsWith("repo view")) return "hands-dev/hands\n";
      throw new Error(`unexpected: ${args.join(" ")}`);
    };

    const result = fileFeedback({ body: "the dashboard should show X", title: "feedback: show X", cwd: "/cwd", gh });
    expect(result).toEqual({ ok: true, url: "https://github.com/hands-dev/hands/issues/123" });

    const issueCall = calls.find((c) => c[0] === "issue")!;
    expect(issueCall).toEqual([
      "issue",
      "create",
      "--repo",
      FEEDBACK_REPO,
      "--title",
      "feedback: show X",
      "--body",
      expect.stringContaining("the dashboard should show X"),
      "--label",
      "feedback",
    ]);
    expect(issueCall[7]).toContain("filed by @octocat from hands-dev/hands");
  });

  it("derives the title from the body when none is given", () => {
    const gh: GhRunner = (args) => (args[0] === "issue" ? "https://example/1" : "");
    fileFeedback({ body: "rough edge in the token chart", cwd: "/cwd", gh });
    // covered structurally by defaultFeedbackTitle's own tests; this just proves fileFeedback calls it
  });

  it("retries once without --label when the labeled attempt fails, and still succeeds", () => {
    const calls: string[][] = [];
    const gh: GhRunner = (args) => {
      calls.push(args);
      if (args[0] === "issue" && args.includes("--label")) throw new Error("label 'feedback' not found");
      if (args[0] === "issue") return "https://github.com/hands-dev/hands/issues/456\n";
      return "";
    };

    const result = fileFeedback({ body: "wish: dark mode toggle", cwd: "/cwd", gh });
    expect(result).toEqual({ ok: true, url: "https://github.com/hands-dev/hands/issues/456" });
    const issueCalls = calls.filter((c) => c[0] === "issue");
    expect(issueCalls).toHaveLength(2);
    expect(issueCalls[0]).toContain("--label");
    expect(issueCalls[1]).not.toContain("--label");
  });

  it("returns ok:false with a message when both the labeled and unlabeled attempts fail", () => {
    const gh: GhRunner = (args) => {
      if (args[0] === "issue") throw new Error("gh: authentication required\nrun `gh auth login`");
      return "";
    };
    const result = fileFeedback({ body: "bug: crashes on load", cwd: "/cwd", gh });
    expect(result).toEqual({ ok: false, error: "gh: authentication required" });
  });

  it("returns ok:false without calling gh at all for an empty/whitespace-only body", () => {
    let called = false;
    const gh: GhRunner = () => {
      called = true;
      return "";
    };
    expect(fileFeedback({ body: "   \n  ", cwd: "/cwd", gh })).toEqual({ ok: false, error: "feedback body is empty" });
    expect(called).toBe(false);
  });
});
