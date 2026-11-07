import { handle, parseOrigins } from "./lib.ts";

const need = (name: string): string => {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing secret: ${name}`);
  return value;
};

Deno.serve((req: Request) =>
  handle(req, {
    supabaseUrl: need("SUPABASE_URL"),
    serviceKey: need("SUPABASE_SERVICE_ROLE_KEY"),
    allowedOrigins: parseOrigins(Deno.env.get("ALLOWED_ORIGINS")),
    salt: need("CONTACT_SALT"),
    resendKey: Deno.env.get("RESEND_API_KEY") || undefined,
    to: Deno.env.get("CONTACT_TO") || "ftc.fiftyone@gmail.com",
    from: Deno.env.get("CONTACT_FROM") || "Singularity 51 Website <onboarding@resend.dev>",
    fetch,
  })
);
