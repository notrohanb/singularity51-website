# Singularity 51 website

The website for FIRST Tech Challenge Team #51, Singularity 51, from CAMS in Carson, CA.

- **Website:** plain HTML in `index.html`, with photos and PDFs in `assets/`. There is no build step.
- **Contact form backend:** a Supabase Edge Function in `supabase/functions/contact/`. It saves each message to a database and emails the team.

## Editing the site

Everything is in `index.html`. Most text appears three times on one line, so change all three:

```html
<h3 data-en="English text" data-es="Texto en español">English text</h3>
```

Open `index.html` in a browser to preview. Push to `main` and GitHub Pages updates in about a minute.

## Going live

### 1. Publish the site on GitHub Pages

1. Create a GitHub repository and push this folder to `main`.
2. In the repository, go to **Settings → Pages**.
3. Under **Source**, choose **Deploy from a branch**, then `main` and `/ (root)`.
4. Note the site's address, such as `https://your-team.github.io/your-repo/`.

The site works at this point. Until the backend is connected, the Contact form copies the visitor's message so they can email it to the team.

### 2. Set up the backend

You need the [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started) and a Supabase project under the team's organization.

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
supabase functions deploy contact --no-verify-jwt
```

The function only accepts messages from the site in `SITE_ORIGINS`, at the top of `supabase/functions/contact/index.ts`, currently `https://notrohanb.github.io`. If the site moves, set this secret. Use the address with **no path**, so `https://your-team.github.io`, not `.../your-repo/`.

```bash
supabase secrets set ALLOWED_ORIGINS=https://your-team.github.io
```

### 3. Turn on email alerts

1. Create a free [Resend](https://resend.com) account. Until you verify a domain, Resend only delivers to the address you signed up with, so set `CONTACT_TO` to that same address.
2. Create an API key, then run:

```bash
supabase secrets set RESEND_API_KEY=your-key
```

Without this step, messages are still saved. You just won't get an email about them.

### 4. Connect the form

Paste the function's address into `config.js`, then commit and push:

```js
window.S51_CONTACT_ENDPOINT = "https://YOUR_PROJECT_REF.supabase.co/functions/v1/contact";
```

The button changes from **Copy Message** to **Send Message**. Send a test message and confirm it arrives.

## Reading messages

- **Email:** each message arrives at the address in the `CONTACT_TO` secret (Supabase → Edge Functions → Secrets). The sender's address is in the alert, so answer them from the team account, ftc.fiftyone@gmail.com.
- **Database:** every message is in the Supabase dashboard under **Table Editor → contact_messages**, even if the email failed. Check `email_status` there: `sent`, `failed`, or `disabled` (no Resend key).

## Spam and privacy

- Only the allowed website address can use the form from a browser.
- A hidden field catches simple bots.
- Limits: 5 messages an hour from one connection, and 60 an hour across the whole site.
- Visitors' IP addresses are never stored, only a salted hash used for the hourly limit.
- The message table isn't readable with public keys.

The hourly sitewide limit means a spam flood can block real messages for up to an hour. Those visitors are told to email the team instead.

**Never commit secrets.** The service key and Resend key live only in Supabase. The address in `config.js` is safe to publish.

## Tests

Requires Node 24 or newer. No install needed:

```bash
node --test tests/contact.test.ts
```

## Optional settings

| Secret | Default | Purpose |
| --- | --- | --- |
| `CONTACT_TO` | `ftc.fiftyone@gmail.com` | Where alerts go |
| `CONTACT_FROM` | `Singularity 51 Website <onboarding@resend.dev>` | Sender shown on alerts. Needs a verified domain to change. |
| `CONTACT_SALT` | The service role key | Salts the IP hashes used for rate limiting |
