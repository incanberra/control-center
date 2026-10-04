# Control Center

A local-first business dashboard for industry updates, strict brand mentions, newsletter monitoring, public audience totals, reminders, and tasks.

Every fresh install starts empty. There are no built-in names, companies, websites, social profiles, API keys, or demo records. Each user tailors the dashboard to their own niche in **Settings**.

## Install and open

Requirements: [Node.js 24.13 or newer](https://nodejs.org/en/download), npm, and a modern desktop browser.

```bash
git clone https://github.com/incanberra/control-center.git
cd control-center
npm run launch
```

`npm run launch` is the golden path. It installs the locked dependencies when needed, builds the app when source files change, starts one loopback-only server, waits for a health check, and opens `http://127.0.0.1:3000` in the default browser. Keep that terminal window open; press `Ctrl+C` to stop.

Prefer a ZIP? Download **Code → Download ZIP** on GitHub, extract it, open a terminal in the extracted folder, and run `npm run launch`. Git is only required for the clone/update workflow.

Useful commands:

```bash
npm run doctor                 # verify runtime, settings, build, and SQLite health
npm run backup                 # make a consistent private backup
npm run launch -- --no-open    # start without opening a browser
npm run launch -- --port=3001  # use another local port
```

## First-run setup

The Today page shows the four live areas and links directly to the right Settings section.

1. **Industry:** add any public homepage, RSS/Atom feed, and optional topic phrases.
2. **Mentions:** add exact names, brands, handles, official domains, distinguishing identity anchors, and known false-positive contexts.
3. **Audience:** add exact public profile URLs or handles for the platforms you use.
4. **AI curation (optional):** choose OpenAI, Anthropic, Gemini, or Grok and save that provider's key, or connect a running local model in LM Studio or Ollama. The model selector starts at **Default**; available alternatives load from the selected provider.
5. **Newsletters (optional):** connect any Gmail account with a read-only OAuth client, choose the Gmail search query, and configure AI curation to extract and rank news.
6. **Daily brief:** choose how many Industry, Mention, and Newsletter stories appear on Today. Each section can show 1–10 stories or be turned off.

Collectors run shortly after startup, every 15 minutes while the app remains open, and when **Refresh** is pressed. Industry, Mentions, and Newsletters open from their last saved collector snapshot, so moving between tabs does not repeat public web or Gmail collection.

## Today and the daily brief

The daily brief is a quick snapshot of the saved reading queues, not a separate collection job. It shows the highest-priority active stories from each enabled tab, five per section by default. Choose **Customize** on Today or **Settings → Daily brief** to change those counts. Archived and expired stories are excluded; opening Today does not make additional AI, web, or Gmail calls. Each section links to the full tab and shows when that source was last checked.

Private actions, meetings, and messages are a separate optional section below the snapshot. They require the connector bridge described below; the three-tab snapshot does not.

## Industry collection

Each configured URL is treated independently and can belong to any niche.

1. The collector checks an explicit feed, page feed metadata, and common RSS/Atom paths.
2. If no feed is readable, it merges sitemap locations from `robots.txt` and common sitemap paths, including recursive sitemap indexes.
3. A first sitemap scan records a quiet baseline. Later scans report newly discovered pages.

A blocked homepage does not stop feed or sitemap discovery. Raw discoveries are stored separately from the reading queue. Canonical URL/title deduplication, watched-source priority, recency, configured topics and exclusions, material-change signals, event similarity, and source diversity select at most the configured daily target (30 by default). This keeps hundreds of broad discoveries available to the collector without presenting hundreds of cards as equally important.

The **Monitor** tab provides **Latest**, **Unreviewed**, **Saved**, **History** and **Archived** views. Latest uses the discovery window selected in Settings (1, 3 or 7 days; 1 by default). Unreviewed retains surfaced items until explicitly reviewed or archived, including older history from before this upgrade. Opening a source does not mark it reviewed. Save is independent of review and archive status; saved evidence stays available regardless of age. Both choices survive refreshes, app restarts and backups. **Mark these N reviewed** changes only the currently displayed, filtered batch; **Mark unread** reverses an individual review.

Open **Feedback** beneath a Monitor update to choose **Useful**, **Too routine**, **Off-topic** or **Already knew**, with an optional reason. The **Feedback history** panel records each change, its original story/source/topic context and any undo. Changing a reason and choosing an option saves a new revision; undo restores the prior choice, or removes the current choice if there was none before it. Feedback survives recollection, restarts and backups, independently of Save, review and Archive. Feedback actions and history reads make no AI calls and never change ranking on their own.

Open **Research preferences** from Monitor to review a visible, editable profile. Start with about 20–30 real feedback examples. Broad proposals require at least three supporting distinct headlines and 75% agreement among matching examples; an **Already knew** example can propose a rule for repeated coverage of that particular development. Proposals use literal topic phrases and listed editorial signals, not semantic interpretation of your reasons or model training. Add proposals to your draft or write your own rules, separating relevance, novelty and significance. The profile supports up to 12 rules and starts **off**.

**Compare these rules** shows the same stored candidate pool with and without the draft rules. It excludes archived and explicitly excluded stories, changes no queues, and makes no collection or AI calls. This local ranking preview is not a prediction of the AI's exact choices. Enabling a profile, or changing its active rules, requires a comparison with available candidates in the last 24 hours under the current source/topic settings. Editing an active draft requires another comparison before saving. Drafts do not affect collection.

When enabled, preferences take effect at the next scheduled collection or **Refresh sources**. They add bounded soft ranking weights, preserve substantive new evidence, and reserve roughly one fifth of the reading target for important coverage outside matched rules when available. Normal Monitor AI selection receives only the compact approved rules, using the existing provider and model; full feedback history and reasons are not sent. **Undo latest change** restores the previous profile, including its on/off state. **Reset preferences** turns the profile off and clears its rules while retaining feedback. These preferences apply to Monitor; Newsletter selection remains separate.

Settings offers Australian, US and UK English-language Google News editions, up to 24 topic phrases, and reading targets from 10 to 50 items per collection. New and legacy settings without an edition use Australia. Older configurations exceeding 24 phrases display a coverage warning until shortened. Longer windows recover available source material, not guaranteed complete coverage. Undated feed entries establish a baseline instead of being presented as fresh news. Watched-site updates remain prioritized independently. A selected AI provider can rerank the bounded candidate set; failures automatically fall back to the local importance model. Multiple sources are described as coverage, not independent corroboration.

Monitor reads saved collection results every minute. This does not trigger web or AI collection; the existing server scheduler and **Refresh sources** control collection. Other legacy tabs retain their existing refresh behaviour. Source failures are visible and the last collection time is shown in Australia/Sydney time. The app must be running to collect.

This fork's first research-workspace change is persistent monitoring. The reusable-work catalogue, topic workspaces and existing geoeconomics-brief import are subsequent changes; see [docs/RESEARCH_WORKSPACE.md](docs/RESEARCH_WORKSPACE.md).

## Mentions

Mention discovery searches Google News and Bing News across the previous seven days. When a user enables a cloud AI provider with search support, a cached two-hour broad-web pass also searches articles, podcasts, videos, directories, forums, GitHub, Reddit, and supported public social pages. Multi-word names and brands are searched as complete phrases, never as loose individual words.

For predictable laptop-friendly collection, a watchlist can contain up to 12 names, handles, and official websites combined, plus up to 24 identity anchors and 24 negative contexts. Every configured identity is processed; provider failures are reported as partial coverage rather than silently dropping entries.

Strict mode requires identity evidence:

- unique handles and official domains can qualify directly;
- common names and broad brand phrases need direct-page identity, niche, or anchor context;
- roles, products, locations, collaborators, and niche topics can serve as anchors;
- weak namesakes and broad word overlap are rejected as noise;
- search snippets and AI output never count as proof; the app fetches the direct canonical URL and requires literal page-local identity evidence;
- configured negative terms hard-reject recurring namesakes and unrelated brand contexts;
- official domains establish identity but can be excluded from the third-party Mention queue;
- literal but ambiguous matches stay review-only when strict mode is off; strict mode requires a second identity signal or multiple configured identity anchors.

Canonical story identities are stored locally. Once a result is archived, later scans do not resurface the same story through a search-provider wrapper or tracking URL.

Industry and Mention archive actions update the local library and saved collector snapshot together. The card moves immediately without waiting for a new source scan. Mention cards can also be sent directly to Reminders.

After identity verification, the selected cloud or local model can explain what a page says about the tracked identity and assign an attention-priority score. Summaries use only the verified page evidence and cannot admit an otherwise unverified mention. Results are cached and saved with the queue. Sort by **Priority**, **Newest**, or **Oldest**; without AI, deterministic importance ranking still works.

Public search is useful discovery, not complete web coverage. Pages that block signed-out verification are rejected instead of being presented as certain mentions. Facebook posts are intentionally excluded from broad research because the app cannot reliably verify exact public-post text without an official connection.

## Audience tracking

Supported public profiles: YouTube, X, Instagram, Facebook, LinkedIn, Threads, and TikTok.

Public pages are checked first and do not require platform API keys. Optional official credentials remain collapsed under advanced settings for providers that support a fallback. Successful metrics must match the configured account identity; a count from an unrelated page is rejected.

Public collection is provider-controlled and best effort. A platform can change or block signed-out metadata without notice. A failed check is shown as unavailable or limited, never as a false zero; a prior verified value is clearly labeled as last known. Combined totals are sums across platforms, not deduplicated people.

Follower and subscriber growth is measured against the newest comparable sample from 24–36 hours earlier. The app keeps one historical anchor per 12-hour bucket, so hourly/manual refreshes update the live total without becoming a misleading baseline. Until a true yesterday sample exists, the UI says **Baseline**. Post, video, and thread counts are shown only as separate content metadata; they are never used as audience growth.

The Audience page includes platform-colored account cards, a platform mix, and interactive 7-day/30-day charts. Switch between total audience and change over the selected range, inspect individual readings, or open the exact-values table. Charts use only verified saved readings: a new account starts with a point, not invented historical growth, and long gaps or last-known counts are labeled.

## Optional AI curation

No AI key is required for installation or for Industry, news Mention discovery, sitemap, RSS, Audience, Task, Reminder, or the daily snapshot features. **Newsletter intelligence requires a configured AI model**, either a cloud provider with a key or a running local model.

Under **Settings → AI curation**, choose **OpenRouter**, **OpenAI**, **Anthropic**, **Gemini**, **Grok (xAI)**, **LM Studio**, or **Ollama**. Keep **Default** selected for an automatic model choice or choose a model returned by that provider. Cloud lists use the selected provider's key. Local lists show only currently loaded, supported text-generation models, not every model available to download. **Reload models** updates the list without saving changes or starting a collector.

**OpenRouter** uses its own API key, separately from any ChatGPT or Gemini chat subscription. Model discovery validates the key and loads a bounded, paginated text-model catalogue without making inference calls. Listed input/output token prices appear in the model menu where available. Default is the fixed `google/gemini-2.5-flash-lite` model, never an arbitrary catalogue entry or automatic router. Set an OpenRouter key spending limit to control the app's allowance. This adapter extracts and ranks collected evidence; it does not enable OpenRouter web-search plugins. Public news collectors continue to run. Invalid keys, exhausted credits, rate limits and incomplete answers remain visible; raw provider error bodies are never displayed. OpenRouter routes evidence to the selected model's serving provider under your OpenRouter account settings.

The selected provider is used for bounded background jobs:

- semantic reranking of already-discovered Industry candidates, with a deterministic local fallback and the same daily cap;
- cached broad-web Mention discovery with supported cloud providers, followed by independent direct-page verification inside Control Center;
- summaries and priority ranking for already-verified Mention pages;
- newsletter story extraction, priority ranking, and cross-newsletter deduplication, using only the separately connected mailbox's matching issues.

Keys can instead be supplied as `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, or `XAI_API_KEY` in `.env.local`. Environment keys are still inert until the matching provider is selected in Settings. Cloud calls can incur usage charges. Saved keys remain in the local server-side settings file, never return through the Settings API, and are not sent to any unselected provider.

### OpenRouter usage and costs

**Settings → AI curation → Usage & costs** shows this app's OpenRouter input/output tokens, reported costs, model totals and recent tasks over 24 hours, 7 days or 30 days. Recording starts with this feature; historical requests from before installation are not reconstructed. Each outbound inference attempt gets a durable local ledger entry. Charged usage in incomplete responses is retained, and requests lacking provider accounting are marked unknown rather than free. Reasoning and cached tokens are subsets of the reported output/input counts, not extra tokens added to the total. The ledger stores accounting fields, not prompts, email bodies or API keys.

**Check OpenRouter balance** reads key usage/limits and account credits without running inference. These account totals can include scanners or other applications using the same key and are kept separate from this app's ledger. The workload calculator uses the selected model's currently listed input/output rates. Amounts are US dollars; estimates can differ from bills because of caching, reasoning, price changes and credit-purchase fees. The [OpenRouter activity page](https://openrouter.ai/activity) remains the authoritative account history.

### Local models

Start the local server in LM Studio or Ollama and load a text model there first. Choose that provider in Control Center, use the default loopback endpoint or enter its local port, then select **Reload models**. Control Center does not install, download, or load models. An optional token is supported if your local server requires one; most local setups do not need a key. Ollama cloud models are not listed, and `OLLAMA_API_KEY` is deliberately not used as a local credential.

Only numeric loopback endpoints (`127.0.0.1` or `::1`) are accepted, with `localhost` normalized to loopback. Requests do not follow redirects. Local models handle curation, summaries, and newsletters; public Mention discovery continues through the regular news collectors without AI web-search tools.

The dashboard sends local-model requests only to that loopback server. For processing entirely on this computer, also disable remote forwarding such as [LM Studio's LM Link](https://lmstudio.ai/docs/developer/core/lm-link) in the model runtime. Control Center cannot inspect or control how another application routes requests internally. A local model must be capable of following the JSON extraction instructions; model failures are reported without fabricating stories.

Keep the model loaded while the dashboard runs and choose a context window large enough for newsletter and page evidence. The model menu shows the runtime's actual loaded capacity. Control Center conservatively checks the input and output allowance before sending a prompt, never enlarges the allocation automatically, and refuses unknown or insufficient capacity with setup guidance. Older local servers may need an update to expose this information. Ollama requests disable truncation and context shifting; incomplete model output is not accepted as a finished result.

## Tasks

Completing a repeating task records a dated, immutable occurrence in Completed and advances the active series to its next due date. One-time tasks remain in Completed until you delete them.

## Newsletter Gmail

The newsletter mailbox can be completely separate from any Gmail account used elsewhere.

When connecting, approve the Gmail email-reading permission on Google's consent screen. Google can complete sign-in even when that permission is declined; Control Center checks the granted scopes before saving a new connection. If an older connection reports insufficient permissions, use **Settings → Newsletters → Save & choose Gmail account**, select the newsletter mailbox again, tick the email-reading permission, then refresh intelligence. Saved stories and OAuth client credentials are retained.

The Newsletters page is an intelligence queue rather than an inbox mirror. On a refresh, Control Center reads previously unseen matching Gmail issues and asks the selected AI provider to extract substantive news—not every hyperlink. Navigation, polls, ads, stock tickers, author profiles, and housekeeping are excluded. Safe public tracking redirects, canonical URLs, headline matching, and AI event consolidation group repeat coverage into one story. Each topic shows how many issues and newsletters covered it, links to the original sources, and a Gmail evidence link. Persistent topic aliases keep archive state stable when later newsletters repeat a story.

The active reading queue covers the latest 36 hours; **Earlier** keeps older extracted topics available, and **Archive** contains only stories you manually archived. The first backfill is processed in bounded batches with a visible queued count. Saved results open immediately between background passes. Without a configured AI model, processing pauses and the page explains what to configure instead of falling back to an inbox or link dump.

Sort each queue by **Priority**, **Newest**, or **Oldest**, search the extracted stories, and select one or more newsletters to see their coverage. Multi-newsletter stories remain one card, with all source evidence intact. Only 30 matching cards render initially; **Show 30 more** reveals the next batch. Ranking is stored with the stories, so changing filters or reopening the tab does not spend additional AI tokens. Previously extracted stories receive priority scores in bounded background batches without rereading their Gmail bodies.

1. Create or select a project in [Google Cloud Console](https://console.cloud.google.com/).
2. Enable the Gmail API and configure the OAuth consent screen.
3. Create a **Web application** OAuth client.
4. Copy the exact redirect URI shown under **Settings → Newsletters** into the OAuth client.
5. Paste the client ID and secret, customize the Gmail search query if desired, and choose **Save & choose Gmail account**.

The requested scope is Gmail read-only. The app never sends, labels, deletes, marks as read, or archives Gmail messages. Dashboard archive state is local only. Newsletter text is sent only to the selected AI provider for extraction; email addresses and subscriber-specific link URLs are masked first. Raw bodies are not stored locally; SQLite keeps issue metadata, a body hash, extracted story metadata, and deduplicated topic state.

Google classifies `gmail.readonly` as a restricted scope. A personal OAuth project left in External/Testing mode can require periodic reauthorization; production distribution of shared OAuth credentials requires Google verification. This project intentionally uses bring-your-own OAuth credentials rather than shipping a universal secret.

## Local data and privacy

The server binds to `127.0.0.1` and rejects API requests with foreign Host or Origin headers. Do not expose it through a network proxy without adding authentication.

Fresh installs store durable data outside the application folder:

| Platform | Default data directory                            |
| -------- | ------------------------------------------------- |
| macOS    | `~/Library/Application Support/Control Center`    |
| Windows  | `%LOCALAPPDATA%\Control Center`                   |
| Linux    | `${XDG_DATA_HOME:-~/.local/share}/control-center` |

Existing installations that already contain `./.control-center` continue using that directory automatically, so this update does not make their data appear missing. An optional absolute `CONTROL_CENTER_DATA_DIR` can be set in `.env.local`.

Stored files include:

- `settings.json`: configuration, OAuth tokens, and any saved AI/provider keys, owner-readable on POSIX systems;
- `control-center.sqlite`: raw Industry discoveries, saved collector snapshots, surfaced content, extracted newsletter issue/link metadata, archive and reading state, editorial feedback history, research preference revisions and comparisons, AI usage, reminders, and tasks;
- snapshot JSON files: sitemap and audience baselines.

Secrets never return through the Settings API. They remain local, but they are not encrypted at rest. Protect the operating-system account and any backups.

## Backup and recovery

```bash
npm run backup
```

This creates a consistent SQLite backup plus settings, snapshot files and the application's `.env.local` (when present) under `~/Documents/Control Center Backups/<timestamp>`. Each backup includes a checksum manifest and recovery instructions. Before reporting success, it checks every copied file and restores a separate temporary database copy, verifying integrity, relationships, schema and table row counts. The live database is not changed. Existing backup artifacts are never overwritten, and the live data directory cannot be used as a destination. It is a private full backup and may contain OAuth tokens or AI provider keys; keep it outside your Git repository.

To choose another destination:

```bash
npm run backup -- --to=/absolute/path/to/backup-folder
```

To recheck a backup made with the new manifest:

```bash
npm run backup:verify -- --from=/absolute/path/to/backup-folder
```

For recovery, stop the app and preserve the current data. Copy the database, settings and snapshot files into a separate recovery directory. If needed, restore `.env.local` into the application folder, changing `CONTROL_CENTER_DATA_DIR` to point to that recovery directory. Use an app version that supports the backup's schema, then check saved evidence, tasks and settings before resuming work. Credentials supplied only through the operating-system environment must be restored separately. Older backups without a manifest remain recoverable but are not supported by `backup:verify`.

Make a new backup before upgrades and after valuable research sessions. GitHub stores committed application code, not the local research database or private configuration. A backup on this computer protects against application/data errors; keep a protected copy on another device or backup service for recovery after loss of the computer.

If startup safely stops on a local-data error, run `npm run doctor`. The app fails closed: it will not render editable empty defaults or overwrite settings, tasks, or reminders after a failed initial read.

## Updates

For a Git clone:

```bash
git pull --ff-only
npm run launch
```

The setup path compares the installed dependency tree to the committed lockfile and performs a clean install when it changes. User data is outside a fresh checkout, so replacing a ZIP with a newer version does not replace that data directory.

## Development and verification

```bash
npm run setup
npm run dev
npm run check
npm run smoke
```

`npm run check` runs lint, the regression suite, and a production build. `npm run smoke` exercises the same one-command launcher with an isolated temporary data directory and verifies the health endpoint, rendered home page, generic first-run state, and localhost request boundary. GitHub Actions runs the documented setup, full check, and launcher smoke path on Linux, macOS, and Windows.

## Private connector bridge

The standalone dashboard does not automatically inherit private Codex connectors. Instead, **Settings → Integrations** provides a portable local bridge for Gmail, Slack, Granola, Google Calendar, Apple Messages, Computer History, or any other user-approved source.

This is an optional advanced integration, not a login screen. The app names are labels for incoming summaries; adding a label does not connect or authorize the app. Industry, Mentions, Newsletters, Audience, and the daily snapshot work independently of this bridge.

Choose the apps, save, and choose **Copy setup prompt**. The generated prompt tells Codex to use the installed connectors read-only, minimize private content, report per-source success or failure, and send stable action/meeting/message items to the loopback-only Daily Brief endpoint. Successful empty checks are recorded, completed items are reconciled away, and failed sources keep their last successful set while showing the failure. The Today page provides Today/Week views and can turn any item into a task. Scripts can use `npm run ingest` with the same JSON contract.

The bridge makes connector-backed overviews portable without shipping anyone's account access. A connector automation still needs to be created by each user because those permissions belong to that user's Codex/provider accounts. See [docs/CONNECTOR_BRIDGE.md](docs/CONNECTOR_BRIDGE.md).

See [CHANGELOG.md](CHANGELOG.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [SECURITY.md](SECURITY.md) for release and project details.
