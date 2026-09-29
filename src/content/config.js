/* =========================================================================
   ==                                                                     ==
   ==   S E L E C T O R   /   T U N I N G   C O N F I G                   ==
   ==                                                                     ==
   ==   This is the only file you should need to edit when LinkedIn       ==
   ==   changes its markup. See README.md -> "Fixing broken selectors".   ==
   ==                                                                     ==
   ==   Captured from a live page on 2026-09-28. Two things about the     ==
   ==   current LinkedIn DOM drive every decision below:                  ==
   ==                                                                     ==
   ==   1. Class names are hashed build output (m6fa1p, m6fgek, m6fmwa).  ==
   ==      They change on every deploy. NOTHING here keys off a class.    ==
   ==                                                                     ==
   ==   2. LinkedIn's component framework stamps a `componentkey`         ==
   ==      attribute carrying the job id, which is stable and semantic:   ==
   ==        list side:  componentkey="job-card-component-ref-4471514947" ==
   ==        pane side:  componentkey="JobDetails_AboutTheJob_4471514947" ==
   ==                    id="JobMatchRef_4471514947"                      ==
   ==      That is how we identify cards AND how we prove the details     ==
   ==      pane has caught up with the URL.                               ==
   ==                                                                     ==
   ==   Only TEXT below is locale-dependent - see TEXT if your LinkedIn   ==
   ==   is not in English.                                                ==
   ========================================================================= */
(function () {
  'use strict';

  window.__LIRJ_CONFIG = {

    /* ---- Where the extension is allowed to act -------------------------- */
    PATHS: [
      '/jobs/search',          // classic search
      '/jobs/search-results',  // what the URL actually looks like today
      '/jobs/collections'      // "Recommended for you", "Easy Apply", etc.
    ],

    /* ---- Job cards in the results list ---------------------------------- */
    CARD: {
      /* Primary hook. The job id is the suffix. */
      keyPrefix: 'job-card-component-ref-',
      selector: '[componentkey^="job-card-component-ref-"]',

      /* Tried only if the primary hook finds nothing - older LinkedIn
         layouts, and a generic structural fallback. */
      fallbackSelectors: [
        'li[data-occludable-job-id]',
        'div[data-job-id]'
      ],
      fallbackIdAttributes: [
        'data-occludable-job-id',
        'data-job-id',
        'data-chameleon-result-urn',
        'data-entity-urn'
      ],
      fallbackJobLink: 'a[href*="/jobs/view/"]'
    },

    /* ---- The job details pane (right-hand side) ------------------------- */
    PANE: {
      /* An element whose componentkey/id starts with one of these AND ends
         with _<jobId> proves the pane is rendering that job. This is what
         defeats the pane-lags-the-URL race. */
      markerPrefixes: ['JobDetails', 'JobMatch'],

      /* The metadata line. Observed shape (2026-09-28):
           <p>
             <span>Denver, CO</span><span> </span>·<span> </span>
             <span><strong>Reposted 1 hour ago</strong></span>   <-- the signal
             <span> </span>·<span> </span>
             <span>81 people clicked apply</span>
           </p>
         Found as: a <p> containing a <strong> that looks like a posted time,
         not inside a job card, not inside another extension's subtree. */
      metaContainer: 'p',
      timeEmphasis: 'strong',

      /* The job title. NOTE: document.querySelector('h1') is NOT safe here -
         on a page with the Jobright extension installed the first h1 belongs
         to Jobright ("Low match to this role"). We search upward from the
         metadata line and skip foreign subtrees. */
      titleSelectors: ['h1', 'h2', '[role="heading"]'],
      titleSearchDepth: 7,

      /* Company: a /company/ link, or the aria-label LinkedIn puts on the
         company block, e.g. aria-label="Company, Slalom." */
      companyLinkSelector: 'a[href*="/company/"]',
      companyAriaPattern: /^\s*company,\s*(.+?)\.?\s*$/i,

      /* Last-resort scrape: "Slalom hiring Data Engineer - West Region in
         Denver, CO | LinkedIn" */
      documentTitlePattern: /^(.*?)\s+hiring\s+(.*?)\s+in\s+(.*?)\s*\|/i
    },

    /* ---- Subtrees belonging to OTHER extensions ------------------------- */
    /* Never treated as cards or pane content, and their mutations are
       ignored so a third-party widget redrawing itself does not make us
       re-scan forever. Add entries here if you install another LinkedIn
       extension. */
    FOREIGN_SUBTREES: [
      '#jobright-linkedin-banner-mount',
      '[id^="jobright"]',
      '[class*="jobright"]',
      '.lirj-prompt'
    ],

    /* ---- Visible text patterns (LOCALE DEPENDENT) ----------------------- */
    TEXT: {
      /* Anchored to the start, so a description that merely mentions the word
         cannot trigger it. */
      reposted: /^\s*reposted\b/i,
      /* Any posted-time string, repost or not. Used to find the metadata
         line. */
      timeAgo: /\b\d+\s+(second|minute|hour|day|week|month|year)s?\s+ago\b/i,
      /* \b keeps this off "applicant" and "Easy Apply". */
      applied: /\bapplied\b/i,
      applicationSent: /\b(application\s+(was\s+)?sent|your\s+application\s+was\s+sent)\b/i,
      applyButton: /^\s*apply\b/i,
      easyApply: /easy\s*apply/i
    },

    /* ---- Timing --------------------------------------------------------- */
    TIMING: {
      /* An isolated world cannot observe the page's history.pushState calls,
         so we poll location.href. */
      urlPollMs: 250,
      mutationDebounceMs: 200,
      /* After the URL changes, poll until a JobDetails*_<newId> marker
         appears. Timing out means "unknown", never "not reposted". */
      paneVerifyIntervalMs: 100,
      paneVerifyTimeoutMs: 4000,
      /* The markers can appear a beat before the metadata line paints. */
      paneSettleMs: 150
    },

    /* ---- Optional background check (off by default) --------------------- */
    BG: {
      /* LinkedIn's internal Voyager API. Called from the content script so
         the request is same-origin and carries your normal session - which is
         also why the extension needs no "cookies" permission. */
      endpoint: 'https://www.linkedin.com/voyager/api/jobs/jobPostings/',
      intervalMs: 1500,
      maxBackoffMs: 60000,
      backoffFactor: 2,
      /* A repost is a posting whose original listing predates its current
         listing by more than this. */
      repostThresholdMs: 6 * 60 * 60 * 1000,
      listedAtFields: ['listedAt'],
      originalListedAtFields: ['originalListedAt']
    },

    /* Set true for a running commentary in the page console. */
    DEBUG: false
  };
})();
