import { handle, parseOrigins } from "./lib.ts";

// The live site's address, with no path. Set the ALLOWED_ORIGINS secret to
// override this, for example after moving to a custom domain.
const SITE_ORIGINS = "https://notrohanb.github.io";

const need = (name: string): string => {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing secret: ${name}`);
  return value;
};

Deno.serve((req: Request) => {
  const serviceKey = need("SUPABASE_SERVICE_ROLE_KEY");
  return handle(req, {
    supabaseUrl: need("SUPABASE_URL"),
    serviceKey,
    allowedOrigins: parseOrigins(Deno.env.get("ALLOWED_ORIGINS") || SITE_ORIGINS),
    // Salts the IP hashes used for rate limiting. Any server-only value works.
    salt: Deno.env.get("CONTACT_SALT") || serviceKey,
    resendKey: Deno.env.get("RESEND_API_KEY") || undefined,
    to: Deno.env.get("CONTACT_TO") || "ftc.fiftyone@gmail.com",
    from: Deno.env.get("CONTACT_FROM") || "Singularity 51 Website <onboarding@resend.dev>",
    fetch,
  });
});
