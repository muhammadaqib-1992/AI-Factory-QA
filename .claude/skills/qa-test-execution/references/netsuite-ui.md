# NetSuite UI — what is already known

Reference for `qa-test-execution`. Load before driving a NetSuite form. Add to it whenever a run
learns something new (a locator, a quirk, a dialog) so the next run doesn't rediscover it.

Account: `NETSUITE_ACCOUNT_ID` in `.env`; app URL `https://<account-id lowercase>.app.netsuite.com`.

## General

| Thing | How |
|---|---|
| Home page | `/app/center/card.nl?sc=-29` |
| Open any transaction | `/app/accounting/transactions/transaction.nl?id=<internal id>` |
| Saved-record id | `id=` query parameter after save |
| Record number on a saved record | `.uir-record-id` |
| Save confirmation | banner `.uir-alert-box` — "Transaction successfully Saved" |
| Field ids | stable across modes; labels differ between edit and view — target ids |
| Type-ahead fields (`*_display`) | fill the text, then press **Tab**, wait ~4 s for sourcing |
| Dropdown fields (`inpt_<field>`) | click the input, then click the option by its exact visible text |
| Line items | fill the edit row, click **Add** (`#item_addedit`), then the row appears in `#item_splits` |
| Save | `#btn_multibutton_submitter` |
| Slow pages | wait for `domcontentloaded` + 3–6 s; NetSuite sources fields asynchronously |

## Sales Order — `/app/accounting/transactions/salesord.nl`

Verified 2026-10-05 on TSTDRV2142416 (form "Custom Order 2"), order #2445 (id 101798).

| Field | Locator | Notes |
|---|---|---|
| Customer | `#entity_display` | type name, Tab; sources Subsidiary (e.g. HEADQUARTERS) |
| Date | `#trandate` | defaults to today |
| Status | — | defaults to Pending Fulfillment |
| Item (line) | `input[name="inpt_item"]` | **dropdown**, not type-ahead: click it, then click e.g. `BEDROOM : Platform Bed` by exact text |
| Quantity (line) | `#quantity_formattedValue` | |
| Rate (line) | `#rate_formattedValue` | sourced from the item's price; fill only if empty |
| Add line | `#item_addedit` | |
| Save | `#btn_multibutton_submitter` | |

Known-good test data on TSTDRV2142416: customer **Alpine Partners 2**, item **BEDROOM : Platform
Bed** (rate 1,280.00).
