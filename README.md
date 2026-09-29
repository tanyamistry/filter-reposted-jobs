# filter-reposted-jobs

A Chrome extension (Manifest V3) that hides **reposted** jobs from LinkedIn job
search, and keeps a local record of the jobs you've **applied** to.

LinkedIn re-lists old jobs with a fresh date. It marks them "Reposted 2 weeks
ago" — but usually only in the job details pane after you click, and often not
on the card in the results list at all. This hides them so the list only shows
genuinely new postings.

Everything stays in your browser. No servers, no analytics, no remote code.

---

## Install (unpacked)

1. Clone or download this folder.
2. Open `chrome://extensions` (or `brave://extensions`).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the `filter-reposted-jobs` folder — the
   one containing `manifest.json`.
5. Open <https://www.linkedin.com/jobs/search-results/> and run a search.

There is no build step. Edit a file, then hit the **reload** icon on the
extension card in `chrome://extensions` and refresh the LinkedIn tab.

### Permissions it asks for

| Permission | Why |
| --- | --- |
| `storage` | Remembering reposted job IDs, checked job IDs, and your applied-jobs list. |
| `https://www.linkedin.com/*` | Running the content script on job pages. |

That's the whole list. It deliberately does **not** request `cookies` (the
optional background check runs inside the page, where the session is already
available), `downloads` (CSV/JSON export uses a blob link), or `tabs`.

---

## How detection works

### Reposted jobs — three layers

**Layer 1 — card text.** Any result card whose text contains "Reposted" is
hidden immediately. In practice this rarely fires: LinkedIn usually does not
put the label on the card. It costs nothing, so it stays.

**Layer 2 — the details pane (the one that does the work).** When you open a
job, the extension reads the pane's metadata line:

```html
<p>
  <span>Denver, CO</span> · 
  <span><strong>Reposted 1 hour ago</strong></span> ·     <!-- the signal -->
  <span>81 people clicked apply</span>
</p>
```

If that `<strong>` starts with "Reposted", the job ID is written to
`chrome.storage.local` permanently and hidden in every future search.

**Layer 3 — background check (off by default, experimental).** Looks up jobs
you haven't opened yet, one at a time, ~1 request every 1.5 s, with
exponential backoff on HTTP 429. See
[Background check](#background-check-experimental) for what it does and how
much to trust it.

### The pane-lags-the-URL race

LinkedIn is a single-page app. When you click a different job, `currentJobId`
in the URL changes **before** the details pane re-renders. Reading the pane too
early attributes the *previous* job's "Reposted" label to the new one — which
would silently hide good jobs.

LinkedIn's component framework stamps section elements with the job ID:

```html
<div componentkey="JobDetails_AboutTheJob_4460076588">
<div id="JobMatchRef_4460076588">
```

So the extension waits until a `JobDetails*_<newJobId>` marker exists in the
DOM, lets it settle briefly, and only then reads the metadata line. If that
marker never appears within 4 s, the result is **"unknown"** — never "not
reposted". Being unsure is always resolved in favour of showing you the job.

### Applied jobs — four layers

1. The card or pane says "Applied" → saved automatically.
2. An Easy Apply confirmation dialog appears → saved automatically.
3. You click an external **Apply** button (LinkedIn can't confirm those) → a
   small "Did you apply? Save to your list" prompt appears. Dismissing it is
   remembered, so it won't nag you about that job again.
4. **Mark as applied** button in the details pane, for anything the automatic
   layers miss.

### Never hides what you're reading

The job currently open in the pane is always **dimmed**, never hidden, whatever
the display mode — hiding it would pull the context out from under you.

---

## Storage

| Key | Contents | Cap |
| --- | --- | --- |
| `settings` | On/off, display mode, background check, hide-applied | – |
| `reposted` | `{ jobId: timestamp }` | 5,000, oldest evicted |
| `checked` | `{ jobId: timestamp }` — already looked at, don't look again | 5,000, oldest evicted |
| `dismissed` | `{ jobId: timestamp }` — "did you apply?" dismissals | 2,000, oldest evicted |
| `applied` | `{ jobId: { title, company, location, url, appliedAt, source, status, notes } }` | **none** |

`reposted`, `checked` and `dismissed` are caches — losing an entry just costs
one extra lookup, so they're capped. `applied` is **never** trimmed: losing an
application record is a real loss.

> **Your applied-jobs list lives only in this browser profile.** It is not
> synced. Clearing site data, switching machines, or a new profile loses it.
> Export JSON from the applied-jobs page for a backup.

---

## The popup

- **On/off toggle**
- **Display mode** — hide reposted jobs, or dim and badge them
- **Also hide jobs I've applied to**
- **Check jobs in the background** (experimental; see below)
- **Counts** — filtered on this page · reposts remembered · jobs applied to
- **Open applied jobs** — the full-page searchable, sortable table
- **Copy diagnostics** — puts a JSON dump of what the content script currently
  sees on your clipboard. This is the first thing to grab when something breaks.
- **Forget all reposted jobs** — clears `reposted` and `checked`. Does not
  touch your applied list.

---

## Applied jobs page

Opened from the popup. A searchable, sortable table with one row per job:
link to the posting, editable status (Applied / Interviewing / Offer /
Rejected / No response), free-text notes, and delete.

- **Export CSV** — respects the current search/filter, opens in Excel or
  Sheets (written with a UTF-8 BOM so Excel doesn't mangle accents).
- **Export JSON** — the full list, for backup.
- **Import JSON** — merges a backup. **Entries already in your list win**, so
  an import never overwrites newer edits.

---

## Background check (experimental)

Off by default. When enabled, it queries LinkedIn's internal Voyager API from
inside the page:

```
GET https://www.linkedin.com/voyager/api/jobs/jobPostings/<jobId>
    csrf-token: <JSESSIONID cookie value>
    x-restli-protocol-version: 2.0.0
```

It does not look for the word "Reposted". It compares two timestamps —
`originalListedAt` against `listedAt`. A gap larger than 6 hours (see
`BG.repostThresholdMs` in `config.js`) means the posting was re-listed.

**Confidence: moderate, roughly 60%.** The comparison is, as far as I can
tell, the semantics LinkedIn itself renders the label from. What I am *not*
confident about is that this undocumented endpoint still has that exact path
and response shape — Voyager changes without notice.

It is built to fail loudly rather than quietly:

- If the response arrives without `listedAt`/`originalListedAt`, the feature
  **disables itself** and the popup says so. It never guesses "not reposted".
- On 401/403/404 or a missing CSRF token, same.
- On 429 it backs off exponentially (1.5 s → 3 s → 6 s …, capped at 60 s) and
  retries the job it was on.
- Re-ticking the checkbox clears a previous failure verdict and retries.

Two caveats worth stating plainly. Automated calls to LinkedIn's internal API
are against the spirit of their user agreement, even throttled and from your
own session. And this is the part of the extension most likely to need fixing.
Layer 2 works without it.

---

## Fixing broken selectors

LinkedIn changes its markup often, so assume this will break eventually.

**Everything you need to edit is in
[`src/content/config.js`](src/content/config.js).** No other file contains a
selector.

### Why there are no class names in there

As of the DOM captured on 2026-09-28, LinkedIn serves **hashed, build-generated
class names**:

```html
<p class="m6fmff m6fmeh m6fmed m6fmet m6fmeu m6fmew m6fme2 m6ffr2 m6fmfd m6fmlp">
```

Those change on every deploy and are worthless as selectors. Detection
therefore keys off, in order of preference:

1. **`componentkey` / `id` attributes** — `job-card-component-ref-<jobId>`,
   `JobDetails_AboutTheJob_<jobId>`. Semantic and stable.
2. **Document structure** — e.g. "the `<p>` containing a `<strong>` that looks
   like a posted time".
3. **Visible text** — the words "Reposted", "Applied".

If you ever edit this file and find yourself pasting an `m6f…` class, that's a
sign the hook you want is somewhere else.

### Diagnosing a break

1. Open a LinkedIn job search, click a job.
2. Extension popup → **Copy diagnostics**.
3. Paste it somewhere and read it:

| Field | Meaning if wrong |
| --- | --- |
| `cards.found: 0` | Card detection is broken. `CARD.keyPrefix` / `CARD.selector` changed. |
| `cards.via` | Which strategy matched. `"fallback selectors"` means the primary hook is gone. |
| `pane.markerFound: false` | The pane-identity markers changed. Update `PANE.markerPrefixes`. |
| `pane.metaFound: false` | The metadata line moved. Check `PANE.metaContainer` / `timeEmphasis`. |
| `pane.strongText` | Should read like `"Reposted 1 hour ago"` or `"7 hours ago"`. |
| `pane.isReposted` | `null` means "couldn't read" — not "clean". |
| `pane.title` / `company` | Empty means the scrape fell through to `document.title`. |

For a live commentary instead, set `DEBUG: true` at the bottom of `config.js`
and watch the page console.

### Finding new hooks

With a job open, in the page console:

```js
// what carries the current job id?
const id = new URL(location.href).searchParams.get('currentJobId');
[...document.querySelectorAll('*')]
  .filter(e => [...e.attributes].some(a => a.name !== 'href' && a.value.includes(id)))
  .slice(0, 12)
  .forEach(e => console.log(e.tagName, JSON.stringify(
    Object.fromEntries([...e.attributes].map(a => [a.name, a.value.slice(0, 80)])))));
```

If Chrome refuses to let you paste, **type** `allow pasting` into the console
first, or use DevTools → Sources → Snippets.

### Other extensions

The Jobright extension injects an `<h1>` into the job details column, which is
why nothing here uses `document.querySelector('h1')`. Foreign subtrees are
listed in `FOREIGN_SUBTREES` in `config.js`; their mutations are ignored and
they're never mistaken for job cards. Add an entry if you install another
LinkedIn extension and see odd behaviour.

### Non-English LinkedIn

Everything locale-dependent is in the `TEXT` block of `config.js`. Translate
`reposted`, `timeAgo`, `applied`, `applicationSent` and `applyButton`.

---

## Layout

```
manifest.json
icons/                     generated by tools/make-icons.js
src/
  content/
    config.js              ← all selectors and tunables
    content.js             observer, detection, hide/dim, applied capture
    content.css            dim, badge, prompt, mark-applied button
  shared/
    storage.js             schema, caps, get/set helpers
  popup/
    popup.html/.css/.js
  pages/
    applied.html/.css/.js  full-page applied-jobs table
tools/
  make-icons.js            regenerate icons (node tools/make-icons.js)
```

## Known limits

- **English only** out of the box — see the `TEXT` block.
- A job LinkedIn reposts *after* you've already seen and checked it stays
  visible until something re-checks it. "Forget all reposted jobs" clears the
  checked cache and forces a fresh look.
- Easy Apply confirmation detection keys off dialog text and is the most
  fragile part; "Mark as applied" is the backstop.
- Hiding sets `display: none` rather than removing nodes, so LinkedIn's
  virtualised list keeps working — but a hidden card's spacing may occasionally
  leave a small gap.
