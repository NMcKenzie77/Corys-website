# Dispensary Automation Guide

Automation is managed under `/admin#automations` using the protected store administrator account.

## Required variables

- `DATABASE_URL`
- `SESSION_SECRET`
- `ADMIN_EMAIL`
- `AUTOMATION_ALERT_EMAIL`
- `AUTOMATION_TIME_ZONE=America/Los_Angeles`
- `AUTOMATION_INTERVAL_MS=300000`
- `RESEND_API_KEY` and `EMAIL_FROM` for internal email delivery

## Automation rules

### Low inventory

Creates an internal alert when an active menu package reaches or falls below the configured unit threshold. The alert resolves after inventory rises above the threshold.

This alert does not replace the store's required POS and traceability inventory controls.

### Stalled pickup order

Creates an alert when a reservation remains too long in `NEW`, `CONFIRMED`, or `PICKING`. Staff should confirm, prepare, contact the customer, cancel, or otherwise resolve the reservation.

### Unclaimed ready order

Creates an urgent alert when a reservation remains `READY` beyond the configured threshold. Staff may contact the customer and expire the reservation under store policy. Expiring the reservation restores website inventory.

### Lapsed customer draft

Creates a draft campaign when there are eligible, opted-in Washington customers whose last completed order is older than the configured period. It never sends the campaign automatically.

### Daily operations digest

Sends an internal summary of open pickup orders, automation alerts, and low-stock packages after the configured Washington-local hour. It does not send customer marketing.

## Safety boundaries

- Automation never completes a cannabis sale.
- Automation never verifies customer ID.
- Automation never records POS payment or traceability entries.
- Automation never ships or delivers cannabis.
- Automation never charges a customer online.
- Automation never sends a bulk campaign automatically.
- Marketing audiences remain limited to opted-in Washington contacts who have not unsubscribed.
- Staff remain responsible for every campaign's copy, images, price, promotion, audience, and legal review.
- A PostgreSQL advisory lock prevents multiple application instances from running the same automation cycle simultaneously.

## Launch test

1. Open `/admin#automations` and confirm all five rules load.
2. Toggle one rule off and on and confirm the setting persists.
3. Run `LOW_INVENTORY` with one package below the threshold and confirm an alert appears.
4. Increase inventory, rerun the rule, and confirm the alert resolves.
5. Age a test reservation in `NEW`, `CONFIRMED`, or `PICKING` and confirm the stalled-order alert.
6. Age a test reservation in `READY` and confirm the unclaimed-order alert.
7. Run `LAPSED_CUSTOMER_DRAFT` and confirm it creates at most one current draft and sends nothing.
8. Configure Resend and test the internal daily digest.
9. Review run history for timestamps, matched records, actions, and errors.
10. Confirm dismissed alerts do not prevent staff from seeing later, materially new conditions.
