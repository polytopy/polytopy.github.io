# Contact form backend

`code.gs` is the Apps Script behind the contact form. It is kept here so it is
versioned alongside the page that talks to it; the copy that actually runs
lives in the Apps Script project bound to the Responses spreadsheet.

## Deploying

1. Paste `code.gs` over the existing script in the Apps Script editor.
2. **Deploy → Manage deployments → edit the active deployment → New version →
   Deploy.** Editing the existing deployment keeps the same `/exec` URL. Creating
   a *new* deployment issues a different URL, which would need changing in the
   form `action` in `index.html`.
3. Access must stay **Anyone**, including for `doGet` — the static page fetches
   its challenge from the same URL.

Check it with a browser: opening the `/exec` URL directly should return JSON
like `{"result":"challenge","nonce":"...","code":"KN4W"}`.

## Order of deployment

Publish the site first, then the script.

The new page works against the old script (it sends a nonce the old script
ignores, and falls back to a locally generated code when `doGet` returns an
error page). The old page does **not** work against the new script, because it
sends no nonce at all. If the two have to overlap, set `REQUIRE_CHALLENGE` to
`false` for the changeover and back to `true` afterwards.
