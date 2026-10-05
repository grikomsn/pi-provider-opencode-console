---
"pi-provider-opencode-console": patch
---

Send the `x-opencode-session` header the Go surface requires, and use the raw upstream model id instead of the duplicate-disambiguated pi id, so console-catalog models such as `opencode-go/deepseek-v4.1-flash` no longer fail with `MissingSessionID` or `Model is unavailable`.
