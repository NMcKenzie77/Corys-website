# Automation Center

The automation center is available at `/admin/automations` and uses the same protected administrator account as products, orders, CRM, and marketing.

## Required Railway variables

- `DATABASE_URL`
- `SESSION_SECRET`
- `ADMIN_EMAIL`
- `RESEND_API_KEY`
- `EMAIL_FROM`
- `AUTOMATION_ALERT_EMAIL`
- `AUTOMATION_TIME_ZONE=America/Los_Angeles`
- `AUTOMATION_INTERVAL_MS=300000`

Tasks, alerts, and campaign drafts can run without Resend. Internal alert email and the daily digest remain unavailable until Resend and the alert recipient are configured.

## Default automation rules

### Stalled order alerts

Creates urgent or high-priority alerts when an order remains too long in `NEW`, `APPROVED`, `PACKING`, or `READY_FOR_CARRIER`.

### Low inventory alerts

Creates an alert for each active package variant at or below the configured unit threshold. The alert automatically resolves when inventory rises above the threshold.

### Sample follow-up tasks

Creates a dated CRM task after a `SAMPLE` activity is recorded. Duplicate tasks are prevented with a permanent automation key.

### Missing next-step tasks

Creates a limited batch of CRM tasks when an account is in an active sales stage but has no open task or dated next action.

### Lapsed-customer follow-up

Creates a reorder task when a customer has not ordered within the configured number of days.

### New-product campaign drafts

Creates a compliant marketing draft when a new active product appears. It never sends the campaign automatically.

### Restock campaign drafts

Takes an inventory snapshot and creates a campaign draft when an out-of-stock variant is replenished to the configured minimum. The initial snapshot does not create drafts.

### License-data review alert

Creates one summarized alert when active CRM accounts have a missing, unknown, or stale license-source date.

### Daily operations digest

Emails an internal summary of new orders, overdue CRM follow-ups, open automation alerts, low-stock variants, and campaign drafts.

### New-account prospecting batch

Disabled by default. When enabled, it creates a controlled number of first-touch CRM tasks each day rather than flooding the task list with every imported shop.

## Safety boundaries

- Bulk marketing campaigns are never auto-sent. Automations create drafts for Cory to review and approve.
- CRM account coverage does not equal marketing consent.
- Unsubscribed contacts remain suppressed.
- Alerts, tasks, and campaign drafts use idempotency keys to prevent duplicates.
- A PostgreSQL advisory lock prevents multiple Railway instances from running the same automation cycle concurrently.
- Dismissed alerts remain dismissed while the same condition persists. Resolved alerts can reopen if the condition returns.

## Launch test

1. Open `/admin/automations` and confirm all rule cards load.
2. Confirm `AUTOMATION_TIME_ZONE` displays as `America/Los_Angeles`.
3. Disable one rule, save it, refresh the page, and confirm the setting persists.
4. Run the low-inventory rule manually with one variant below its threshold and confirm an alert appears.
5. Increase inventory above the threshold, run the rule again, and confirm the alert resolves.
6. Log a CRM `SAMPLE` activity, run the sample follow-up rule, and confirm one follow-up task is created.
7. Run that rule again and confirm no duplicate task is created.
8. Add a new product, run the new-product rule, and confirm one campaign draft appears in `/admin/marketing`.
9. Run it again and confirm no duplicate draft is created.
10. Run the restock rule once to initialize its snapshot. Set a package to zero, run it, then replenish it above the configured minimum and run it again. Confirm one restock draft appears.
11. Create or age a test order past a configured threshold and confirm a stalled-order alert appears.
12. Configure Resend and run the daily digest after its local send time. Confirm the internal email arrives only once for that date.
13. Review the automation run history and confirm matched counts, action counts, failures, and timestamps are recorded.
14. Keep the new-account prospecting batch disabled until the statewide CRM account source and sales workflow are approved.
