# Setup and credential handling

jevgraph accepts a Jev credential from the process environment or a hidden interactive setup prompt. It never accepts an API key as a command-line argument.

For an environment-only run:

```sh
export TYPESAFE_API_KEY='...'
# or export OPENROUTER_API_KEY='...'
jevgraph search "query" --input ./snapshot.json
```

To persist the exported key for later runs:

```sh
jevgraph setup --from-env
```

To choose a provider explicitly:

```sh
jevgraph setup --provider typesafe --from-env
jevgraph setup --provider openrouter --from-env
```

In a TTY, `jevgraph setup` shows a provider menu. Use ↑/↓ to select TypeSafe or OpenRouter and Enter to confirm, then paste your API key into the hidden prompt. TypeSafe is selected initially. Press Esc or Ctrl+C to cancel the menu. `--provider` skips the menu. In a noninteractive process setup exits with an actionable message and recommends `--from-env`; it never waits for hidden input.

The credential file is `${XDG_CONFIG_HOME:-$HOME/.config}/jevgraph/credentials.env`, with a `0700` parent and `0600` file. Environment values take precedence over saved values. `TYPESAFE_API_KEY` is preferred over the compatibility `JEV_API_KEY` alias. `JEVGRAPH_PROVIDER=typesafe|openrouter` selects a provider explicitly; if both providers remain applicable without a selection, resolution fails rather than guessing.

`jevgraph config` prints only configured/provider/model/source metadata. `jevgraph doctor` adds boolean environment-presence checks and states that no live authentication was attempted. Neither command prints key material.

Semantic retrieval uses the bounded persistent cache supplied by the package when enabled. Its default location is `${XDG_CACHE_HOME:-$HOME/.cache}/jevgraph`; `--no-cache` passes `enabled: false`, bypassing disk and memory reuse.

OpenRouter uses the native Decisions transport and the verified model `typesafe/jev-1.13`; direct Jev uses `jev-latest` by default. The package does not invent chat-completion fallbacks or silently switch providers.

Semantic commands may override the selection with `--provider typesafe|openrouter` and `--model MODEL`. A forced provider must have its matching key; it does not fall back to another configured key.
