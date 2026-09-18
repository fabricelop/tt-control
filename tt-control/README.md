# TT Control v1

Parallel prototype for TTiTTulares España. This branch does not alter the current production workflows.

## First milestone
- Ingest real Europa Press items from the existing repository feed.
- Store editorial state in Cloudflare D1.
- Desktop-first control room plus simplified mobile UI.
- States: NEW, SELECTED, PROCESSING, READY, PUBLISHED, DISMISSED, EXPIRED.
- Urgency is independent from editorial interest and can be corrected in both directions.
- Existing Telegram and TTiTTulares production remain untouched until explicit cutover.

## Editorial feedback
Selection/dismissal, urgency corrections, and later punchline feedback are stored as separate signals.
