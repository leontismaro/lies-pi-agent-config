# Provider Error Normalizer

Local Pi extension that normalizes provider/API errors before they are shown in the TUI or reused in context.

## What it does

- Rewrites assistant messages with `stopReason: "error"` and noisy provider `errorMessage` bodies.
- Removes raw HTML/CSS error pages from displayed and stored error messages.
- Adds concise diagnostics for common statuses such as `429`, `502`, `503`, and `504`.
- Can use non-blocking TUI notifications and footer status when running in TUI mode.
- Aggregates repeated provider errors by adding a count to the latest normalized error title and footer status.
- Supports English or Chinese semantic text without noisy meaning/action labels.
- Cleans old provider errors during context construction as a fallback.

## Optional config

Create `~/.pi/provider-errors.json`:

```json
{
  "enabled": true,
  "cleanContext": true,
  "notify": false,
  "setStatus": true,
  "setWidget": false,
  "language": "zh",
  "aggregateNotify": true,
  "notifyWindowMs": 120000,
  "showProvider": true,
  "showModel": true,
  "showRequestId": true,
  "showRetryAfter": true,
  "includeRawSnippet": false,
  "maxRawChars": 500
}
```

Reload Pi after changes with `/reload` or restart Pi.
