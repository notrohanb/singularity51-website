// Run with: node --test tests/contact.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Config, handle, LIMITS, parseOrigins, validate } from "../supabase/functions/contact/lib.ts";

const ORIGIN = "https://team51.github.io";
const GOOD = { name: "Ada Lovelace", email: "ada@example.com", organization: "Boeing", subject: "sponsor", message: "Hello team" };

// A stand-in for Supabase and Resend that records what the backend sent.
function fake(opts: { ipCount?: number; allCount?: number; dbFails?: boolean; resendFails?: boolean } = {}) {
  const rows: Record<string, unknown>[] = [];
  const patches: Record<string, unknown>[] = [];
  const emails: Record<string, any>[] = [];
  const countUrls: string[] = [];
  const stub = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.startsWith("https://api.resend.com")) {
      emails.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: opts.resendFails ? 500 : 200 });
    }
    if (opts.dbFails) return new Response("{}", { status: 500 });
    if (method === "GET") {
      countUrls.push(url);
      const total = url.includes("ip_hash=eq.") ? (opts.ipCount ?? 0) : (opts.allCount ?? 0);
      return new Response("[]", { headers: { "content-range": `0-0/${total}` } });
    }
    if (method === "POST") {
      rows.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify([{ id: "row-1" }]), { status: 201 });
    }
    patches.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const cfg: Config = {
    supabaseUrl: "https://example.supabase.co",
    serviceKey: "service-key",
    allowedOrigins: [ORIGIN],
    salt: "pepper",
    resendKey: "resend-key",
    to: "ftc.fiftyone@gmail.com",
    from: "Site <site@example.com>",
    fetch: stub,
  };
  return { cfg, rows, patches, emails, countUrls };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://example.supabase.co/functions/v1/contact", {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json", "x-forwarded-for": "203.0.113.9, 10.0.0.1", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("a good message is stored and emailed, with reply-to set to the sender", async () => {
  const f = fake();
  const res = await handle(post(GOOD), f.cfg);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(res.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal(f.rows[0].name, "Ada Lovelace");
  assert.equal(f.rows[0].subject, "sponsor");
  assert.equal(f.emails[0].reply_to, "ada@example.com");
  assert.deepEqual(f.emails[0].to, ["ftc.fiftyone@gmail.com"]);
  assert.match(f.emails[0].subject, /Sponsorship: Ada Lovelace/);
  assert.match(f.emails[0].text, /Hello team/);
  assert.deepEqual(f.patches, [{ email_status: "sent" }]);
});

test("the raw IP is never stored", async () => {
  const f = fake();
  await handle(post(GOOD), f.cfg);
  assert.ok(!JSON.stringify(f.rows[0]).includes("203.0.113.9"));
  assert.match(String(f.rows[0].ip_hash), /^[0-9a-f]{64}$/);
});

test("a failed email alert still succeeds, and marks the row failed", async () => {
  const f = fake({ resendFails: true });
  const res = await handle(post(GOOD), f.cfg);
  assert.equal(res.status, 200);
  assert.equal(f.rows.length, 1);
  assert.deepEqual(f.patches, [{ email_status: "failed" }]);
});

test("with no email provider, messages are stored and marked disabled", async () => {
  const f = fake();
  f.cfg.resendKey = undefined;
  const res = await handle(post(GOOD), f.cfg);
  assert.equal(res.status, 200);
  assert.equal(f.rows[0].email_status, "disabled");
  assert.equal(f.emails.length, 0);
});

test("the honeypot pretends to succeed and stores nothing", async () => {
  const f = fake();
  const res = await handle(post({ ...GOOD, website: "http://spam.example" }), f.cfg);
  assert.equal(res.status, 200);
  assert.equal(f.rows.length, 0);
  assert.equal(f.emails.length, 0);
});

test("other websites are refused, including at the preflight", async () => {
  const f = fake();
  const res = await handle(post(GOOD, { Origin: "https://evil.example" }), f.cfg);
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("access-control-allow-origin"), null);
  const pre = await handle(new Request("https://x.co/", { method: "OPTIONS", headers: { Origin: "https://evil.example" } }), f.cfg);
  assert.equal(pre.status, 403);
  assert.equal(f.rows.length, 0);
});

test("requests with no Origin are refused", async () => {
  const req = new Request("https://x.co/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(GOOD) });
  assert.equal((await handle(req, fake().cfg)).status, 403);
});

test("the preflight allows our site", async () => {
  const res = await handle(new Request("https://x.co/", { method: "OPTIONS", headers: { Origin: ORIGIN } }), fake().cfg);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), ORIGIN);
  assert.match(res.headers.get("access-control-allow-headers") ?? "", /content-type/);
});

test("the sixth message in an hour from one address is refused", async () => {
  const f = fake({ ipCount: LIMITS.perIpPerHour });
  const res = await handle(post(GOOD), f.cfg);
  assert.equal(res.status, 429);
  assert.equal(f.rows.length, 0);
  assert.equal(f.emails.length, 0);
});

test("the sitewide hourly cap stops a flood from many addresses", async () => {
  const f = fake({ allCount: LIMITS.allPerHour });
  assert.equal((await handle(post(GOOD), f.cfg)).status, 429);
});

test("rate checks look back one hour", async () => {
  const f = fake();
  f.cfg.now = () => new Date("2026-11-06T12:00:00.000Z");
  await handle(post(GOOD), f.cfg);
  assert.equal(f.countUrls.length, 2);
  assert.ok(f.countUrls.every((u) => u.includes(encodeURIComponent("2026-11-06T11:00:00.000Z"))));
});

test("a database failure reports an error and sends no email", async () => {
  const f = fake({ dbFails: true });
  const res = await handle(post(GOOD), f.cfg);
  assert.equal(res.status, 500);
  assert.equal(f.emails.length, 0);
});

test("bad input gets a clear status", async () => {
  const f = fake();
  assert.equal((await handle(post("{not json"), f.cfg)).status, 400);
  assert.equal((await handle(post(GOOD, { "Content-Type": "text/plain" }), f.cfg)).status, 415);
  assert.equal((await handle(post({ ...GOOD, message: "x".repeat(LIMITS.bodyBytes) }), f.cfg)).status, 413);
  assert.equal((await handle(new Request("https://x.co/", { headers: { Origin: ORIGIN } }), f.cfg)).status, 405);
  const res = await handle(post({ ...GOOD, email: "nope", subject: "join" }), f.cfg);
  assert.equal(res.status, 422);
  assert.deepEqual((await res.json()).fields, ["email", "subject"]);
  assert.equal(f.rows.length, 0);
});

test("validation", () => {
  assert.ok("fields" in validate({ ...GOOD, organization: undefined }));
  for (const bad of [null, "x", 5, [], {}]) assert.ok("invalid" in validate(bad));
  assert.deepEqual(validate({ ...GOOD, name: "   " }), { invalid: ["name"] });
  assert.deepEqual(validate({ ...GOOD, name: 7 }), { invalid: ["name"] });
  assert.deepEqual(validate({ ...GOOD, message: "x".repeat(LIMITS.message + 1) }), { invalid: ["message"] });
  assert.deepEqual(validate({ ...GOOD, subject: "constructor" }), { invalid: ["subject"] });
});

test("line breaks in the name can't forge email fields", () => {
  const out = validate({ ...GOOD, name: "Ada\r\nBcc: x@y.com" });
  assert.ok("fields" in out);
  assert.equal(out.fields.name, "Ada Bcc: x@y.com");
});

test("origin list parsing tolerates spaces and trailing slashes", () => {
  assert.deepEqual(parseOrigins(" https://a.io/, https://b.io ,, "), ["https://a.io", "https://b.io"]);
  assert.deepEqual(parseOrigins(undefined), []);
});
