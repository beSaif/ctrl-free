# One image: the React build served by the FastAPI backend on $PORT.
# Runtime state goes to $DATA_DIR (mount a volume there); see deploy/entrypoint.sh.

FROM node:22-slim AS frontend
WORKDIR /app/frontend
RUN corepack enable && corepack prepare pnpm@10.31.0 --activate
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY frontend/ ./
# Pins "today" like frontend/.env.development so the Oberglatt deadline reads "12 days left".
# Build with --build-arg VITE_TODAY= to use the real date.
ARG VITE_TODAY=2026-09-10
ENV VITE_TODAY=${VITE_TODAY}
RUN pnpm build

FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.12 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PYTHONUNBUFFERED=1
WORKDIR /app/backend
COPY backend/pyproject.toml backend/uv.lock backend/README.md ./
RUN uv sync --frozen --no-dev --no-install-project
COPY backend/ ./
RUN uv sync --frozen --no-dev
COPY problem_statement/Schulhaus_Oberglatt_Hackathon_Starter_Package_v2/ /app/problem_statement/Schulhaus_Oberglatt_Hackathon_Starter_Package_v2/
COPY --from=frontend /app/frontend/dist /app/frontend/dist
COPY deploy/entrypoint.sh /app/entrypoint.sh

ENV DATA_DIR=/data PORT=8000
EXPOSE 8000
CMD ["/app/entrypoint.sh"]
