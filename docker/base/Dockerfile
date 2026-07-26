FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates openssh-client \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global @openai/codex @anthropic-ai/claude-code \
  && useradd --create-home --uid 10001 agent

USER agent
WORKDIR /workspace

CMD ["sleep", "infinity"]
