# GitStudio 1.25.0 — every provider on its own model

## Every provider starts on its own default model

The OpenAI-compatible model settings used to default to OpenAI's
gpt-4o-mini / gpt-4o for every endpoint, so Groq, OpenRouter or a local
server was sent OpenAI's model. Left empty, they now mean the defaults of
the provider your base URL points at — the same ones the desktop app uses.
OpenAI's are now gpt-6-luna / gpt-6.1-terra / gpt-6.1-sol.

Each card in the AI panel starts on its provider's default and lists the
models you can switch to. A detected list no longer replaces a cloud
default; for Ollama or LM Studio the default becomes a model the server
actually has.

## Fixed

- **OpenAI's reasoning models work.** The o-series and gpt-5 and later
  answered every request with HTTP 400, because GitStudio sent them
  `max_tokens`; they now get `max_completion_tokens`, with low reasoning
  effort for these short tasks.
