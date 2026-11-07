// Contact form backend. Everything lives here, separate from the Deno entry
// point, so the tests can run it under Node with a fake `fetch`.

export const SUBJECTS: Record<string, string> = {
  general: "General Inquiry",
  sponsor: "Sponsorship",
  outreach: "Outreach Collaboration",
  cad: "CAD Lessons or Question",
};

export const LIMITS = {
  bodyBytes: 16 * 1024,
  name: 120,
  email: 254,
  organization: 160,
  message: 5000,
  perIpPerHour: 5,
  allPerHour: 60,
};

export type Config = {
  supabaseUrl: string;
  serviceKey: string;
  allowedOrigins: string[];
  salt: string;
  resendKey?: string;
  to: string;
  from: string;
  fetch: typeof fetch;
  now?: () => Date;
};

export type Fields = {
  name: string;
  email: string;
  organization: string;
  subject: string;
  message: string;
};

export function parseOrigins(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

function clean(value: unknown, max: number, singleLine: boolean): string | null {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return null;
  const text = singleLine ? value.replace(/\s+/g, " ").trim() : value.trim();
  return text.length > max ? null : text;
}

export function validate(input: unknown): { fields: Fields } | { invalid: string[] } {
  const body = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const name = clean(body.name, LIMITS.name, true);
  const email = clean(body.email, LIMITS.email, true);
  const organization = clean(body.organization, LIMITS.organization, true);
  const subject = clean(body.subject, 32, true);
  const message = clean(body.message, LIMITS.message, false);

  const invalid: string[] = [];
  if (!name) invalid.push("name");
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) invalid.push("email");
  if (organization === null) invalid.push("organization");
  if (!subject || !Object.hasOwn(SUBJECTS, subject)) invalid.push("subject");
  if (!message) invalid.push("message");
  if (invalid.length) return { invalid };

  return {
    fields: {
      name: name as string,
      email: email as string,
      organization: organization as string,
      subject: subject as string,
      message: message as string,
    },
  };
}

async function hashIp(ip: string, salt: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${ip}`));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function dbHeaders(cfg: Config): Record<string, string> {
  return { apikey: cfg.serviceKey, Authorization: `Bearer ${cfg.serviceKey}`, "Content-Type": "application/json" };
}

function table(cfg: Config): string {
  return `${cfg.supabaseUrl.replace(/\/+$/, "")}/rest/v1/contact_messages`;
}

async function countSince(cfg: Config, since: string, ipHash?: string): Promise<number> {
  const filters = [`created_at=gte.${encodeURIComponent(since)}`, "select=id"];
  if (ipHash) filters.push(`ip_hash=eq.${ipHash}`);
  const res = await cfg.fetch(`${table(cfg)}?${filters.join("&")}`, {
    headers: { ...dbHeaders(cfg), Prefer: "count=exact", Range: "0-0" },
  });
  if (!res.ok) throw new Error(`rate check failed: ${res.status}`);
  const total = Number(res.headers.get("content-range")?.split("/")[1]);
  if (!Number.isFinite(total)) throw new Error("rate check had no count");
  return total;
}

async function insertMessage(cfg: Config, row: Record<string, unknown>): Promise<string> {
  const res = await cfg.fetch(table(cfg), {
    method: "POST",
    headers: { ...dbHeaders(cfg), Prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`insert failed: ${res.status}`);
  const rows = await res.json();
  return rows[0].id;
}

async function setEmailStatus(cfg: Config, id: string, status: string): Promise<void> {
  const res = await cfg.fetch(`${table(cfg)}?id=eq.${id}`, {
    method: "PATCH",
    headers: dbHeaders(cfg),
    body: JSON.stringify({ email_status: status }),
  });
  if (!res.ok) console.error(`email status update failed: ${res.status}`);
}

async function sendAlert(cfg: Config, f: Fields): Promise<boolean> {
  const from = f.organization ? `${f.name} (${f.organization})` : f.name;
  const res = await cfg.fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: cfg.from,
      to: [cfg.to],
      reply_to: f.email,
      subject: `[Website] ${SUBJECTS[f.subject]}: ${f.name}`,
      text: `${f.message}\n\n--\nFrom: ${from}\nEmail: ${f.email}\nSubject: ${SUBJECTS[f.subject]}\n\nHit reply to answer them directly.`,
    }),
  });
  if (!res.ok) console.error(`email alert failed: ${res.status}`);
  return res.ok;
}

export async function handle(req: Request, cfg: Config): Promise<Response> {
  const origin = (req.headers.get("origin") ?? "").replace(/\/+$/, "");
  const allowed = cfg.allowedOrigins.includes(origin);
  const cors: Record<string, string> = {
    Vary: "Origin",
    ...(allowed
      ? {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "content-type",
          "Access-Control-Max-Age": "86400",
        }
      : {}),
  };
  const reply = (status: number, body: Record<string, unknown>) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "Content-Type": "application/json" },
    });

  if (!allowed) return reply(403, { error: "forbidden" });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return reply(415, { error: "unsupported_media_type" });
  }

  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > LIMITS.bodyBytes) return reply(413, { error: "too_large" });

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return reply(400, { error: "invalid_json" });
  }

  // Bots fill every field. Tell them it worked so they don't try anything else.
  const honeypot = (body as Record<string, unknown> | null)?.website;
  if (typeof honeypot === "string" && honeypot.trim()) return reply(200, { ok: true });

  const checked = validate(body);
  if ("invalid" in checked) return reply(422, { error: "invalid", fields: checked.invalid });
  const { fields } = checked;

  try {
    const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
    const ipHash = await hashIp(ip, cfg.salt);
    const since = new Date((cfg.now?.() ?? new Date()).getTime() - 3_600_000).toISOString();
    const [fromThisIp, fromEveryone] = await Promise.all([
      countSince(cfg, since, ipHash),
      countSince(cfg, since),
    ]);
    if (fromThisIp >= LIMITS.perIpPerHour || fromEveryone >= LIMITS.allPerHour) {
      return reply(429, { error: "rate_limited" });
    }

    const id = await insertMessage(cfg, {
      name: fields.name,
      email: fields.email,
      organization: fields.organization || null,
      subject: fields.subject,
      message: fields.message,
      ip_hash: ipHash,
      email_status: cfg.resendKey ? "pending" : "disabled",
    });

    // The message is safe in the database now. A failed alert must not tell the
    // sender to try again, or the team would get duplicates.
    if (cfg.resendKey) {
      let sent = false;
      try {
        sent = await sendAlert(cfg, fields);
      } catch (err) {
        console.error("email alert threw", err);
      }
      await setEmailStatus(cfg, id, sent ? "sent" : "failed");
    }
    return reply(200, { ok: true });
  } catch (err) {
    console.error("contact failed", err);
    return reply(500, { error: "server_error" });
  }
}
