import { describe, expect, it } from "vitest";
import {
  collectRobotsTxt,
  fetchRobotsTxt,
  matchRobotsRule,
  parseRobotsTxt,
  type RobotsTxtDocument,
  robotsEvidenceFor,
  robotsVerdict,
  selectRobotsGroup,
} from "../src/robots-txt.js";

function document(text: string): RobotsTxtDocument {
  const parsed = parseRobotsTxt(text);
  return {
    url: "https://example.com/robots.txt",
    fetched: true,
    status: 200,
    groups: parsed.groups,
    sitemaps: parsed.sitemaps,
  };
}

const GOOGLEBOT_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

describe("parseRobotsTxt", () => {
  it("groups consecutive user agents, keeps document-level sitemaps, and reads crawl delay", () => {
    const parsed = parseRobotsTxt(
      [
        "# a comment",
        "User-agent: alpha",
        "User-agent: beta",
        "Disallow: /private",
        "Allow: /private/public",
        "Crawl-delay: 2",
        "",
        "User-agent: *",
        "Disallow:",
        "Sitemap: https://example.com/sitemap.xml",
      ].join("\n"),
    );

    expect(parsed.groups).toHaveLength(2);
    expect(parsed.groups[0]?.agents).toEqual(["alpha", "beta"]);
    expect(parsed.groups[0]?.rules).toEqual([
      { allow: false, path: "/private" },
      { allow: true, path: "/private/public" },
    ]);
    expect(parsed.groups[0]?.crawlDelayMs).toBe(2000);
    // An empty Disallow carries no restriction, so the wildcard group ends up with no rules.
    expect(parsed.groups[1]?.rules).toEqual([]);
    expect(parsed.sitemaps).toEqual(["https://example.com/sitemap.xml"]);
  });

  it("starts a new group when a user-agent line follows a rule", () => {
    const parsed = parseRobotsTxt(
      ["User-agent: alpha", "Disallow: /a", "User-agent: beta", "Disallow: /b"].join("\n"),
    );

    expect(parsed.groups.map((group) => group.agents)).toEqual([["alpha"], ["beta"]]);
  });
});

describe("matchRobotsRule", () => {
  it("treats a trailing dollar as an end anchor and a star as a wildcard", () => {
    expect(matchRobotsRule("/page$", "/page")).toBe(6);
    expect(matchRobotsRule("/page$", "/page/sub")).toBeUndefined();
    expect(matchRobotsRule("/*.pdf", "/docs/guide.pdf")).toBe(6);
    expect(matchRobotsRule("/docs", "/other")).toBeUndefined();
  });
});

describe("selectRobotsGroup", () => {
  it("prefers the longest matching token over the wildcard group", () => {
    const subject = document(
      ["User-agent: *", "Disallow: /", "", "User-agent: Googlebot", "Disallow: /google-only"].join(
        "\n",
      ),
    );

    expect(selectRobotsGroup(subject, GOOGLEBOT_UA)?.agents).toEqual(["googlebot"]);
    expect(selectRobotsGroup(subject, "SomeOtherBot/1.0")?.agents).toEqual(["*"]);
  });
});

describe("robotsVerdict", () => {
  it("follows rule-length precedence for wildcard and end-anchored rules", () => {
    const verdict = (rules: string, path: string) =>
      robotsVerdict(document(`User-agent: *\n${rules}`), GOOGLEBOT_UA, path).verdict;
    expect(verdict("Allow: /page\nDisallow: /*.htm", "/page.htm")).toBe("disallowed");
    expect(verdict("Allow: /page\nDisallow: /*.ph", "/page.php5")).toBe("allowed");
    expect(verdict("Allow: /\nDisallow: /$", "/")).toBe("disallowed");
    expect(verdict("Allow: /fish\nDisallow: /fish*", "/fish/salmon")).toBe("allowed");
    expect(matchRobotsRule("/file-%2A.html", "/file-*.html")).toBeDefined();
    expect(matchRobotsRule("/file-%24", "/file-$")).toBeDefined();
  });
  it("uses literal query separators and rule specificity rather than wildcard expansion", () => {
    expect(matchRobotsRule("/page?print=1", "/page?print=1")).toBeDefined();
    expect(matchRobotsRule("/*?print=1", "/pageprint=1")).toBeUndefined();
    const subject = document("User-agent: *\nDisallow: /*\nAllow: /public/");
    expect(robotsVerdict(subject, GOOGLEBOT_UA, "/public/long/path").verdict).toBe("allowed");
  });

  it("combines equally specific groups and ignores unrelated records between agents", () => {
    const subject = document(
      "User-agent: Googlebot\nDisallow: /a\nUser-agent: Googlebot\nDisallow: /b",
    );
    expect(robotsVerdict(subject, GOOGLEBOT_UA, "/b").verdict).toBe("disallowed");
    const shared = document(
      "User-agent: alpha\nSitemap: https://example.com/map.xml\nUser-agent: Googlebot\nDisallow: /",
    );
    expect(shared.groups).toHaveLength(1);
    expect(robotsVerdict(shared, "alpha", "/page").verdict).toBe("disallowed");
  });

  it("normalizes escaped paths without decoding reserved characters", () => {
    expect(matchRobotsRule("/café", "/caf%C3%A9")).toBeDefined();
    expect(matchRobotsRule("/foo", "/%66oo")).toBeDefined();
    expect(matchRobotsRule("/a/b", "/a%2fb")).toBeUndefined();
    expect(matchRobotsRule("/a%2Fb", "/a%2fb")).toBeDefined();
  });
  it("lets the longest match decide", () => {
    const subject = document(
      ["User-agent: *", "Disallow: /folder/", "Allow: /folder/public/"].join("\n"),
    );

    expect(robotsVerdict(subject, GOOGLEBOT_UA, "/folder/secret").verdict).toBe("disallowed");
    expect(robotsVerdict(subject, GOOGLEBOT_UA, "/folder/public/page").verdict).toBe("allowed");
    expect(robotsVerdict(subject, GOOGLEBOT_UA, "/elsewhere").verdict).toBe("allowed");
  });

  it("lets an allow win an equally specific tie", () => {
    const subject = document(["User-agent: *", "Disallow: /page", "Allow: /page"].join("\n"));

    expect(robotsVerdict(subject, GOOGLEBOT_UA, "/page").verdict).toBe("allowed");
  });

  it("reports the matching rule and keeps the query string in the tested path", () => {
    const subject = document(["User-agent: *", "Disallow: /*?print=1"].join("\n"));
    const verdict = robotsVerdict(subject, GOOGLEBOT_UA, "/article?print=1");

    expect(verdict.verdict).toBe("disallowed");
    expect(verdict.matched).toBe("Disallow: /*?print=1");
  });

  it("allows everything when the document has no applicable group", () => {
    const subject = document(["User-agent: OtherBot", "Disallow: /"].join("\n"));

    expect(robotsVerdict(subject, GOOGLEBOT_UA, "/page").verdict).toBe("allowed");
  });

  it("marks an unread document unavailable instead of guessing", () => {
    const subject: RobotsTxtDocument = {
      url: "https://example.com/robots.txt",
      fetched: false,
      groups: [],
      sitemaps: [],
      error: "connection reset",
    };

    expect(robotsVerdict(subject, GOOGLEBOT_UA, "/page").verdict).toBe("unavailable");
  });
});

describe("fetchRobotsTxt", () => {
  it("cancels an oversized response without reading it to completion", async () => {
    let cancelled = false;
    const subject = await fetchRobotsTxt("https://example.com", {
      maxBytes: 8,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(9));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    });
    expect(subject.fetched).toBe(false);
    expect(subject.error).toContain("exceeded");
    expect(cancelled).toBe(true);
  });

  it("bounds concurrent origin requests and fetches each origin once", async () => {
    let active = 0;
    let maximum = 0;
    let calls = 0;
    const origins = ["https://a.test", "https://b.test", "https://c.test", "https://a.test"];
    await collectRobotsTxt(
      origins,
      {
        fetchImpl: async () => {
          calls += 1;
          active += 1;
          maximum = Math.max(maximum, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return new Response("", { status: 404 });
        },
      },
      2,
    );
    expect(calls).toBe(3);
    expect(maximum).toBe(2);
  });
  it("reads and parses a served document", async () => {
    const subject = await fetchRobotsTxt("https://example.com", {
      fetchImpl: async () =>
        new Response("User-agent: *\nDisallow: /admin", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    });

    expect(subject.fetched).toBe(true);
    expect(robotsVerdict(subject, GOOGLEBOT_UA, "/admin/x").verdict).toBe("disallowed");
  });

  it("treats a missing robots.txt as allow-all rather than a finding", async () => {
    const subject = await fetchRobotsTxt("https://example.com", {
      fetchImpl: async () => new Response("Not found", { status: 404 }),
    });

    expect(subject.fetched).toBe(true);
    expect(subject.status).toBe(404);
    expect(robotsVerdict(subject, GOOGLEBOT_UA, "/anything").verdict).toBe("allowed");
  });

  it("treats a server error as an unknown access rule", async () => {
    const subject = await fetchRobotsTxt("https://example.com", {
      fetchImpl: async () => new Response("boom", { status: 503 }),
    });

    expect(subject.fetched).toBe(false);
    expect(robotsVerdict(subject, GOOGLEBOT_UA, "/anything").verdict).toBe("unavailable");
  });

  it("records a network failure without throwing", async () => {
    const subject = await fetchRobotsTxt("https://example.com", {
      fetchImpl: async () => {
        throw new Error("socket hang up");
      },
    });

    expect(subject.fetched).toBe(false);
    expect(subject.error).toContain("socket hang up");
  });
});

describe("robotsEvidenceFor", () => {
  it("summarizes the verdict for one agent and URL", () => {
    const evidence = robotsEvidenceFor(
      document(["User-agent: Googlebot", "Disallow: /blocked"].join("\n")),
      GOOGLEBOT_UA,
      "https://example.com/blocked/page",
    );

    expect(evidence).toMatchObject({
      url: "https://example.com/robots.txt",
      fetched: true,
      verdict: "disallowed",
      matched: "Disallow: /blocked",
    });
  });

  it("returns nothing when no robots.txt was read", () => {
    expect(robotsEvidenceFor(undefined, GOOGLEBOT_UA, "https://example.com/")).toBeUndefined();
  });
});
