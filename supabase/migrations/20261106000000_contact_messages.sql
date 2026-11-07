-- Messages sent through the website's Contact form.
-- Row level security is on with no policies, so the public API keys can't read
-- or write this table. Only the `contact` Edge Function (service role) and the
-- Supabase dashboard can reach it.
create table public.contact_messages (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  name          text not null check (char_length(name) between 1 and 120),
  email         text not null check (char_length(email) between 3 and 254),
  organization  text check (char_length(organization) <= 160),
  subject       text not null check (subject in ('general', 'sponsor', 'outreach', 'cad')),
  message       text not null check (char_length(message) between 1 and 5000),
  -- Salted hash, used only for rate limiting. The raw IP address is never stored.
  ip_hash       text not null,
  -- pending: email not tried yet, sent: alert delivered,
  -- failed: alert failed, disabled: no email provider configured.
  email_status  text not null default 'pending'
                check (email_status in ('pending', 'sent', 'failed', 'disabled'))
);

comment on table public.contact_messages is 'Website Contact form submissions.';

create index contact_messages_created_at_idx on public.contact_messages (created_at desc);
create index contact_messages_rate_limit_idx on public.contact_messages (ip_hash, created_at desc);

alter table public.contact_messages enable row level security;
revoke all on public.contact_messages from anon, authenticated;
