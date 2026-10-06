# Research workspace implementation

The initial direction is a personal geoeconomics workspace: Monitor for developments, My work for reusable charts/datasets/notebooks/reports, and Topics to connect the two. Client-management features follow actual business activity.

## First change: persistent monitoring

- Monitor replaces the Industry navigation label; source settings and API compatibility remain.
- Latest uses the configured 1/3/7-day collection window. Unreviewed retains surfaced items until explicitly reviewed or archived. Saved retains bookmarked evidence independent of age, review and archive state.
- Review actions use dedicated SQLite records, linked to existing content IDs. Recollection and canonical URL deduplication preserve these choices. The snapshot response reads current review state from the database and ages Latest into History without recollecting.
- Existing historical items start unreviewed; already archived items remain excluded from Unreviewed. Mark the displayed batch reviewed to clear a backlog gradually. Opening links never implies review.
- Topic discovery offers Australian, US and UK English editions. A 24-phrase limit is enforced on save, with a visible warning for oversized legacy configurations. Longer windows cannot guarantee recovery from unavailable sources.
- Reading targets include 10 and 15. Source counts mean coverage, not independent corroboration. Original reports and competing claims still need human assessment.
- Monitor reads its saved state every minute. The existing 15-minute server collection scheduler remains; per-module collection schedules are a later change.

## Migration and recovery

Schema version 9 adds local `editorial_feedback` history. Monitor offers Useful, Too routine, Off-topic and Already knew, optional reasons, revisions and undo. Feedback snapshots retain the original story/source context and literal matches to the configured topic phrases. They are linked to canonical stored story IDs and read at response time, so collector snapshots cannot replace a newer choice. Writes use a current-feedback revision check to avoid overwriting changes from another view. Undo only applies to the current revision and restores the previous remaining choice. Reading, saving and archiving do not create feedback. Feedback writes update the displayed story locally without requesting collection, and the history endpoint only reads the database.

Schema version 10 adds local research preference revisions and comparison records. Research preferences is reachable from Monitor and starts off. Up to 12 editable rules separate relevance, novelty and significance. Current feedback proposes broad literal topic/signal rules after at least three supporting distinct headlines and 75% agreement; identical normalized headlines count once. Proposals inspect at most the latest 500 current examples, with the sample size visible. Already knew proposes a dated event-specific novelty rule rather than a topic-wide reduction. Reasons remain human-readable context, not automatically interpreted training inputs. Collect roughly 20–30 real examples before judging the broad proposals.

The comparison uses the same saved raw candidates and current source/topic/window/exclusion settings for both lists. It excludes archived stories, leaves queues and profiles unchanged, and makes no source or AI calls. Enabling or changing active rules requires matching comparison proof with candidates, the current settings scope and a timestamp within 24 hours. Stale profile edits are rejected. The comparison shows local rule effects; subsequent AI selection can differ. Feedback alone never changes selection.

Approved rules apply on the next scheduled or manual Monitor collection. Each matching rule adjusts local scores by eight points, capped at sixteen points overall in either direction. Relevance/significance reductions retain detected substantive evidence. Novelty reductions target unchanged coverage of a known development, with a seven-day window for matching headlines at other URLs and no penalty for an updated story at the same URL. Roughly 20% of the reading target is reserved for important unmatched baseline coverage when available. Explicit exclusions retain precedence. Normal AI selection receives compact approved rules through the existing provider/model; feedback histories, evidence IDs and private reasons are excluded. Its cache identity includes the approved profile. Opening preferences, comparing, saving, undoing and resetting make no AI calls. Newsletter selection is unchanged.

Undo restores the prior saved profile, including its enabled state. Reset disables preferences and clears rules while preserving feedback. Both history and comparisons survive full backup/recovery. Schema 10 uses the existing consistent pre-migration backup mechanism and preserves saved evidence, review state, tasks, reminders, settings and the AI usage ledger.

Schema version 7 adds `content_reviews`; it preserves stories, tasks, reminders and existing archive state. The database initializer makes a consistent pre-migration SQLite copy under the private data directory's `migration-backups` folder. Existing backup tooling includes the new table because it backs up the entire SQLite database.

Schema version 8 adds `ai_usage` for OpenRouter request accounting. It preserves the existing monitor, newsletter, task and reminder data and uses the same pre-migration backup mechanism. The usage panel separates this app's recorded requests from account-wide key and credit totals; no past app usage is fabricated.

Run `npm run backup` before updating an installation with valuable data. To return to the old app, stop the app, retain a copy of the current data, and restore the pre-migration database into a separate data directory. Point `CONTROL_CENTER_DATA_DIR` at that directory and run the old revision. The old schema guard correctly refuses a newer database; do not downgrade by editing `user_version`.

Backups now include `.env.local` when present, a checksum/schema/count manifest and recovery instructions. Creation checks a separate restored copy before reporting success; `npm run backup:verify -- --from=<backup-directory>` repeats that check without altering live data. Protect private backups separately from GitHub code history. Keep local operation and SQLite for the personal pilot; cloud hosting and database migration are not prerequisites.

Setup documentation and runtime version files now agree on Node 24.13+. The lockfile includes compatible security updates. Any remaining development-dependency advisories should be assessed separately before adopting a breaking toolchain change.

## Next increments

Collection status and scanner integration are now implemented in schema 11. The Collection and scanners screen shows durable collection attempts/full successes, failures, backlog, costs and the next local scheduler check. It provides persisted pause and optional saved-report import controls, a safe dated report viewer, manual version-1 import/export, producer provenance and idempotent imports into Monitor. Original summaries and reading/feedback choices are retained. Complete morning editions are protected from ad-hoc or partial replacement. See `SCANNER_INTERCHANGE.md` for the contract, adapter boundaries and recovery behavior. No unattended service is installed, and automatic report imports start off.

1. Collect real feedback and use Research preferences to compare a compact draft before enabling it. Review selected and missed developments after several collection cycles before expanding the rules. Semantic event clustering or interpretation of reasons would be a separate, explicitly scoped change.
2. Evaluate the implemented scanner imports with real morning runs, confirm source coverage and repeated-import behavior, and enable optional saved-report imports when useful. Decide whether unattended collection is actually needed before adding an OS service or changing the scanner schedules.
3. Catalogue a small selection of real reusable work, with original-file links, descriptions, dates, reuse status and connections between charts, datasets, notebooks and reports. Add search and previews before automated ingestion.
4. Add Topics with a research question, dated changes, linked evidence and linked assets. Shape Today around important updates and research actions.

No real asset files, clients, credentials or source subscriptions are seeded by this change. Test stories are explicit fixtures only. Keep private data outside the repository.
