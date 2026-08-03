import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { DIGEST_VERSION, regenerateDigests, renderDigest, renderIndex } from "../src/digest.js";
import { type JournalEvent, openJournal, syncPull, syncPush } from "../src/remote.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-digest-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const DAY = "2026-08-03";
const T0 = Date.parse(`${DAY}T09:00:00Z`);

function ev(
  type: string,
  data: Record<string, unknown>,
  offsetMin = 0,
  agent?: string,
): JournalEvent {
  return { v: 1, ts: T0 + offsetMin * 60_000, type, ...(agent ? { agent } : {}), data };
}

const SAMPLE: JournalEvent[] = [
  ev("priorities.set", { items: ["Ship the fix", "Refactor queue"], at: T0 }, 0, "foreman"),
  ev("task.create", { id: 1, by: "foreman", assignee: "worker-2", title: "Plan the fix", at: 0 }, 1, "foreman"),
  ev("message", { id: 1, from: "foreman", to: "worker-2", body: "secret body must not leak", at: 0 }, 2, "foreman"),
  ev("task.update", { id: 1, state: "returned", result: "A long plan résumé 🙂 ".repeat(30), at: 0 }, 30, "worker-2"),
  ev("question.ask", { id: 1, asker: "worker-2", question: "ship now?", at: 0 }, 40, "worker-2"),
  ev("question.answer", { id: 1, answer: "yes", by: "human", at: 0 }, 50, "foreman"),
  ev("digest.note", { text: "Good day: plan landed, shipped by lunch." }, 55, "foreman"),
  ev("message", { id: 2, from: "worker-2", to: "foreman", body: "another body", at: 0 }, 60, "worker-2"),
  ev("cursor", { agent: "foreman", last: 2 }, 61, "foreman"),
  ev("todo.create", { id: 1, title: "Merge PR #7", at: 0 }, 70), // unattributed (legacy-style)
];

describe("renderDigest", () => {
  it("is deterministic, ordered foreman→worker-N→unattributed, and excludes message bodies", () => {
    const a = renderDigest(SAMPLE, { project: "p", handle: "h", date: DAY });
    const b = renderDigest([...SAMPLE], { project: "p", handle: "h", date: DAY });
    expect(a.body).toBe(b.body);
    expect(a.body.startsWith(`<!-- roundhouse digest v${DIGEST_VERSION} -->`)).toBe(true);
    const foremanIdx = a.body.indexOf("## foreman");
    const workerIdx = a.body.indexOf("## worker-2");
    const unattributedIdx = a.body.indexOf("## unattributed");
    expect(foremanIdx).toBeGreaterThan(-1);
    expect(workerIdx).toBeGreaterThan(foremanIdx);
    expect(unattributedIdx).toBeGreaterThan(workerIdx);
    // notes render, bodies don't
    expect(a.body).toContain("Good day: plan landed");
    expect(a.body).not.toContain("secret body");
    expect(a.body).toContain("messages sent: 1");
    // truncation is code-point safe and bounded
    const resultLine = a.body.split("\n").find((l) => l.includes("ticket #1 returned"))!;
    expect(resultLine).toContain("…");
    expect(Array.from(resultLine).length).toBeLessThan(200);
    // cursor bookkeeping is not itemized
    expect(a.body).not.toContain("cursor");
  });

  it("renders focus labels in section headers, derived from focus.set events", () => {
    const withFocus = [
      ev("focus.set", { station: "worker-2", focus: "developer API", at: 0 }, 5, "foreman"),
      ...SAMPLE,
    ];
    const d = renderDigest(withFocus, { project: "p", handle: "h", date: DAY });
    expect(d.body).toContain("## worker-2 · developer API");
    expect(d.body).toContain("focus → developer API");
    // a NEXT-day render still shows the label (last set ≤ that day)
    const later = renderDigest(
      [...withFocus, ev("task.create", { id: 9, title: "t", at: 0 }, 24 * 60 + 10, "worker-2")],
      { project: "p", handle: "h", date: "2026-08-04" },
    );
    expect(later.body).toContain("## worker-2 · developer API");
  });

  it("filters strictly by UTC day", () => {
    const other = renderDigest(SAMPLE, { project: "p", handle: "h", date: "2026-08-04" });
    expect(other.body).toContain("_no activity_");
  });
});

describe("regenerateDigests", () => {
  function journalWith(events: JournalEvent[], remote: string, home: string, writerId: string) {
    const j = openJournal({
      env: { AGENT_BUS_HOME: path.join(root, home) },
      cwd: root,
      config: { ...DEFAULT_CONFIG, remote: { url: remote, handle: "michael", project: "proj" } },
      writerId,
    })!;
    const logDir = path.join(j.dir, "journal", "proj", "michael", "log");
    fs.mkdirSync(logDir, { recursive: true });
    const byDay = new Map<string, JournalEvent[]>();
    for (const e of events) {
      const day = new Date(e.ts).toISOString().slice(0, 10);
      (byDay.get(day) ?? byDay.set(day, []).get(day)!).push(e);
    }
    for (const [day, evs] of byDay) {
      fs.appendFileSync(
        path.join(logDir, `${day}.${writerId}.ndjson`),
        evs.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
    }
    return j;
  }

  function bareRemote(name: string): string {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", dir]);
    return dir;
  }

  it("writes digest + README, skips unchanged, respects newer stamps", () => {
    const remote = bareRemote("origin.git");
    const j = journalWith(SAMPLE, remote, "homeA", "macbook");
    const changed = regenerateDigests(j);
    expect(changed).toContain(path.join("journal", "proj", "michael", `${DAY}.md`));
    expect(changed).toContain(path.join("journal", "proj", "michael", "README.md"));
    // unchanged second run writes nothing
    expect(regenerateDigests(j)).toEqual([]);
    // a NEWER renderer's file is never downgraded
    const file = path.join(j.dir, "journal", "proj", "michael", `${DAY}.md`);
    fs.writeFileSync(file, "<!-- roundhouse digest v999 -->\nfrom the future\n");
    expect(regenerateDigests(j)).toEqual([]);
    expect(fs.readFileSync(file, "utf8")).toContain("from the future");
    const readme = fs.readFileSync(path.join(j.dir, "journal", "proj", "michael", "README.md"), "utf8");
    expect(readme).toContain(`[${DAY}](./${DAY}.md)`);
  });

  it("two machines, one handle: digests conflict, auto-resolve, and converge (no ping-pong)", () => {
    const remote = bareRemote("origin.git");
    const a = journalWith(SAMPLE.slice(0, 5), remote, "homeA", "macbook");
    const b = journalWith(SAMPLE.slice(5), remote, "homeB", "studio");

    expect(syncPush(a, { force: true }).status).toBe("pushed"); // A: events + digest

    // B renders + COMMITS its digest before ever pulling — the genuine
    // concurrent-edit case (offline machine). Its <DAY>.md must conflict with
    // A's on rebase and auto-resolve.
    regenerateDigests(b);
    execFileSync("git", ["-C", b.dir, "add", "-A", "--", "journal"], { stdio: "ignore" });
    execFileSync("git", ["-C", b.dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "offline digest"], { stdio: "ignore" });

    expect(syncPush(b, { force: true }).status).toBe("pushed"); // conflict → --theirs → regen from merge
    // A pulls the converged world; regeneration produces identical bytes → clean
    expect(syncPush(a, { force: true }).status).toBe("clean");
    expect(syncPush(b, { force: true }).status).toBe("clean");

    const fileA = fs.readFileSync(path.join(a.dir, "journal", "proj", "michael", `${DAY}.md`), "utf8");
    const fileB = fs.readFileSync(path.join(b.dir, "journal", "proj", "michael", `${DAY}.md`), "utf8");
    expect(fileA).toBe(fileB);
    // the converged digest reflects BOTH machines' events
    expect(fileA).toContain("ticket #1"); // fired line
    expect(fileA).toContain("Good day: plan landed");
  });

  it("regenerates a past date when its events arrive late", () => {
    const remote = bareRemote("origin.git");
    const yesterday = "2026-08-02";
    const tsY = Date.parse(`${yesterday}T12:00:00Z`);
    const a = journalWith(SAMPLE, remote, "homeA", "macbook");
    expect(syncPush(a, { force: true }).status).toBe("pushed");

    // machine B pushes an event dated YESTERDAY
    const late: JournalEvent = { v: 1, ts: tsY, type: "task.create", agent: "foreman", data: { id: 9, by: "foreman", title: "late-arriving", at: tsY } };
    const b = journalWith([late], remote, "homeB", "studio");
    expect(syncPull(b.dir).ok).toBe(true);
    expect(syncPush(b, { force: true }).status).toBe("pushed");

    // A's next sync must surface yesterday's digest (pushed if it re-rendered
    // first, clean if B's converged render already covered it — either way the
    // file must exist locally with the late event)
    expect(["pushed", "clean"]).toContain(syncPush(a, { force: true }).status);
    const y = fs.readFileSync(path.join(a.dir, "journal", "proj", "michael", `${yesterday}.md`), "utf8");
    expect(y).toContain("late-arriving");
  });
});

describe("renderIndex", () => {
  it("lists days newest-first with summaries", () => {
    const idx = renderIndex(
      [
        { date: "2026-08-01", summary: "2 items · 1 message" },
        { date: "2026-08-03", summary: "5 items · 2 messages" },
      ],
      { project: "p", handle: "h" },
    );
    expect(idx.indexOf("2026-08-03")).toBeLessThan(idx.indexOf("2026-08-01"));
  });
});
