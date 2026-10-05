---
"pi-provider-opencode-console": patch
---

Refresh model facts against the current gateway catalog: route `qwen3.8-max` to OpenAI-completions on both gateways (the endpoint table gives this one Qwen tier a different API from the Messages-mapped family — pi's official config and independent routers agree), and filter `jev*` ids from every catalog source. Jev models run the System One structured-decision protocol (models.dev lists them with output limit 0, structured-only, no tool call) and cannot serve chat text; the Console supplemental table, which only held jev mirrors, collapses to empty — remaining Go supplemental mirrors are unaffected.
