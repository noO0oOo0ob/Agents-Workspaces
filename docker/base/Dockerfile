FROM node:22-bookworm-slim

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates openssh-client \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && pnpm add --global @openai/codex @anthropic-ai/claude-code \
  && useradd --create-home --uid 10001 agent

USER agent
WORKDIR /workspace

CMD ["sleep", "infinity"]
