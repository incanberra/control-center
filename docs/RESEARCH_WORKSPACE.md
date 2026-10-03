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

Schema version 7 adds `content_reviews`; it preserves stories, tasks, reminders and existing archive state. The database initializer makes a consistent pre-migration SQLite copy under the private data directory's `migration-backups` folder. Existing backup tooling includes the new table because it backs up the entire SQLite database.

Run `npm run backup` before updating an installation with valuable data. To return to the old app, stop the app, retain a copy of the current data, and restore the pre-migration database into a separate data directory. Point `CONTROL_CENTER_DATA_DIR` at that directory and run the old revision. The old schema guard correctly refuses a schema-7 database; do not downgrade by editing `user_version`.

Setup documentation and runtime version files now agree on Node 24.13+. The lockfile includes compatible security updates. Any remaining development-dependency advisories should be assessed separately before adopting a breaking toolchain change.

## Next increments

1. Catalogue a small selection of real reusable work, with original-file links, descriptions, dates, reuse status and connections between charts, datasets, notebooks and reports. Add search and previews before automated ingestion.
2. Integrate the existing morning geoeconomics collector through a versioned local JSON export/import. Preserve producer/run identity, source evidence, partial-run status and user review state; avoid duplicate collection or repeat AI summarisation.
3. Add Topics with a research question, dated changes, linked evidence and linked assets. Shape Today around important updates and research actions.

No real asset files, clients, credentials or source subscriptions are seeded by this change. Test stories are explicit fixtures only. Keep private data outside the repository.
