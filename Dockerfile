# Foundry sandbox — Strategy 1 (plan §1.4).
# Each headless job runs inside this container with --dangerously-skip-permissions;
# the container is the blast radius, hooks/guard.sh + deny rules are the seatbelt.
#
# Build:  docker build -t foundry .
# Run supervisor in-container:
#   docker run --rm -it \
#     -e CLAUDE_CODE_OAUTH_TOKEN \
#     -e FOUNDRY_PERMISSION_MODE=bypassPermissions \
#     -v "$PWD":/foundry \
#     foundry bin/foundry-run.sh

FROM node:22-bookworm

# Playwright/Chromium system deps
RUN npx -y playwright@latest install-deps chromium \
  && apt-get update && apt-get install -y --no-install-recommends jq git curl \
  && rm -rf /var/lib/apt/lists/*

# Claude Code CLI (native install)
RUN curl -fsSL https://claude.ai/install.sh | bash \
  && ln -sf /root/.local/bin/claude /usr/local/bin/claude

WORKDIR /foundry

# Pre-bake the Chromium browser binary so jobs don't download it at runtime.
RUN npx -y playwright@latest install chromium

# The repo is bind-mounted at /foundry; nothing else of value exists in here.
ENV FOUNDRY_IN_SANDBOX=1
CMD ["bash", "bin/foundry-run.sh"]
