# Zeli — Business Intelligence

## Financial

- contribution and withdrawal trends;
- net cash-flow movement;
- income and expenses;
- remittance performance and variance;
- period-over-period comparisons;
- reconciliation exceptions;
- pending withdrawals and submitted accounts.

## Customer operations

- new versus active accounts;
- dormant active accounts (no contribution in period);
- contribution consistency (single-contribution share);
- engagement distribution;
- activity trends.

No customer-specific record is sent to an external provider.

## Staff and collector operations

- collector contribution and remittance distribution;
- collectors without a remittance in the period;
- workload concentration;
- outstanding handovers;
- activity patterns.

These are workload observations, not performance judgements. No misconduct or
fraud conclusion is drawn.

## Business management

- branch contribution comparison with a statistical outlier check;
- reporting gaps (zero-transaction days);
- incomplete daily accounts;
- stale aggregate warnings;
- cash-flow observations.

## Recommendations

Each recommendation has:

- title and severity;
- explanation;
- evidence source and period;
- suggested investigation;
- confidence and limitations;
- `humanActionRequired = true`.

Recommendations never execute financial actions.

## Calculation integrity

- Reversed records excluded.
- Periods are UTC half-open.
- Tenant and branch scope always applied.
- Aggregates refresh idempotently.
- Local facts are inserted after any provider response.
- Insights state correlation, not causation.
