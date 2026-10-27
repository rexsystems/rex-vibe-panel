# REX Vibe Panel

Self-hosted Minecraft hosting panel with AI administration, a Mantine interface, and an optional manual Advanced workspace. Licensed under **AGPL-3.0-only**.

REX starts from a user request. The AI can manage files, run shell commands inside the selected game container, install server software, download user-supplied URLs, install compatible Modrinth projects, and manage backups. It has no tool for administering the Linux host or other users' servers.

## Install on Linux x86-64

Requirements: Docker Engine with Compose, an accessible host IP, and enough RAM/disk for Minecraft plus the panel. You supply your own AI provider, locally or in the cloud.

```sh
git clone https://github.com/rexsystems/rex-vibe-panel.git
cd rex-vibe-panel
node scripts/configure.mjs
```

Edit `.env`: set `APP_ORIGIN` to the actual browser origin, `REX_DATA_DIR` to an absolute host directory, and `COOKIE_SECURE=true` when using HTTPS. The configuration script generates a database password and encryption key without printing them. Keep `.env` private and back up `ENCRYPTION_KEY`; losing it makes saved provider credentials unreadable.

```sh
docker compose up -d --build db migrate panel worker
```

Open `http://localhost:3000` on the host (or use an SSH tunnel). Create the first administrator with an email and a password of at least 8 characters. Initial setup closes after the first administrator is created. For remote access, put an HTTPS reverse proxy in front of port 3000 and enable WebSocket forwarding. The supplied port binding is loopback-only.

1. After creating the administrator, choose **Set up local node** to let REX create the node, enroll its agent, and start it automatically. Enter the address players will use; Bedrock requires IPv4. Choose **Later** to skip, or use **Auto-setup local node** in Administration whenever needed.
2. Wait until REX reports that the agent is connected. Progress and failures are displayed; retry reuses the same local node and data directory.
3. For manual enrollment instead, add a node in Administration, copy its enrollment token into `AGENT_ENROLLMENT_TOKEN` in `.env`, and run `docker compose --profile agent up -d agent`.
4. Allocate a server to a registered account, selecting its exact Minecraft version, edition, limits, and port. Record acceptance of the Minecraft EULA.
5. Add a provider and model under Providers, test the connection, and open the server chat.
6. Ask REX to install and start the server. Installing prepares a container; starting downloads and launches Minecraft. Check the live console for readiness and verify a connection from a Minecraft client.

The first agent image pull can take several minutes. Node status, console logs, and Docker health are displayed separately; a running container does not imply that Minecraft has finished starting.

Automatic local setup requires a running Docker Engine accessible to the panel. The supplied Compose configuration gives the panel Docker-socket access for this administrator-only operation. It reuses the panel image and Docker network and passes only agent enrollment/data configuration to the agent, never provider keys. A native Linux checkout can build the agent image automatically when missing; `LOCAL_AGENT_IMAGE` and `LOCAL_AGENT_PANEL_URL` provide explicit overrides. This feature configures the node and agent; it does not install operating-system packages or change host firewall rules.

## Providers

Included presets: Ollama, custom OpenAI-compatible URL, OpenAI, DeepSeek, OpenRouter, Groq, Gemini, Anthropic, Amazon Bedrock Runtime, and Bedrock Mantle. Model IDs are entered by the user or obtained from the provider's model listing. A connection test makes a small model request and may incur the provider's usual charges. Cloud free tiers are controlled by their providers.

Tool calling must pass the connection test before the model can administer a server. An untested model remains available for chat. Changing the model resets this verification. Bedrock Runtime accepts a user-supplied Bedrock API key or AWS access key/secret with optional session token; it never intentionally inherits panel IAM permissions. Mantle uses a Bedrock API key with its regional OpenAI-compatible base URL.

For a private initial default, set `DEFAULT_AI_PROVIDER=bedrock-mantle`, `BEDROCK_MANTLE_REGION`, `BEDROCK_MANTLE_MODEL`, and `BEDROCK_MANTLE_API_KEY` in the ignored `.env`. The first administrator receives this provider once on setup/login, with its key encrypted in PostgreSQL. Public registrations do not inherit the key. Deleting the imported provider does not recreate it on the next login. The default model is Qwen3 Coder Next; other models may require a different inference prefix. Mantle model discovery always uses `/v1/models`. Use **Test connection** to verify tool calling before AI administration. No inference is made during import. Each account can choose its own default with **Use by default**.

For Ollama running on the Docker host, use `http://host.docker.internal:11434` and add that exact origin in Administration → Settings → Trusted provider origins. Ollama must listen on an interface reachable from the container. `localhost` inside the panel container points to the panel itself. Private endpoint approval is restricted to administrators. Public endpoints require HTTPS; outgoing requests pin a validated DNS address and revalidate redirects.

## Remote nodes

Run the same image on each Docker host with the agent command, its own persistent data directory, and access to its Docker socket. Set `AGENT_PANEL_URL=wss://your-panel.example/api/v1/agent/connect`, `AGENT_DATA_DIR=/var/lib/rex`, and `AGENT_HOST_DATA_DIR` to the absolute host path mounted at `/var/lib/rex`. Enroll using a fresh one-use token from Administration. The saved identity is retained under the agent data directory. Never share that directory between nodes.

On each remote host, clone the repository, copy `.env.agent.example` to `.env.agent`, fill the panel URL, enrollment token, and absolute data directory, then run:

```sh
docker compose -f compose.agent.yaml --env-file .env.agent up -d --build
```

This starts only the node agent. It does not start another panel or database.

Allow inbound Minecraft ports through the host and provider firewalls. Java uses the allocated TCP port. Bedrock uses the allocated TCP port plus the following 16 UDP ports for NetherNet gameplay; REX reserves the full range and supplies the node IPv4 address to the image. Bedrock builds supporting NetherNet are the intended target. The panel does not configure external firewalls.

## Development and checks

Node.js 24 and pnpm 10 are used. Dependencies are locked in `pnpm-lock.yaml`.

```sh
corepack pnpm install --frozen-lockfile
cp .env.example .env
# Fill DATABASE_URL, ENCRYPTION_KEY; use APP_ORIGIN=http://localhost:5173
corepack pnpm db:migrate
corepack pnpm dev
# On a Docker host, in another terminal after enrollment:
corepack pnpm dev:agent
```

```sh
corepack pnpm typecheck
corepack pnpm test
corepack pnpm exec playwright install chromium
corepack pnpm test:e2e
corepack pnpm build
```

API/worker integration tests start a real temporary PostgreSQL database, with simulated model and agent services. Browser tests use the same kind of isolated fixture. They do not prove a live cloud model or Minecraft runtime works on your infrastructure. See [verification](docs/verification.md) for real-host checks.

OpenAPI documentation is served at `/api/docs`. Browser API writes require the session cookie and `x-rex-request: 1`; Swagger UI adds the header. The default API limit is 1200 requests per minute per source IP (`API_RATE_LIMIT`), with a separate 10-per-minute limit on each authentication endpoint. Static UI assets are excluded from API rate limiting.

## Runtime behavior and limits

- Java editions: Vanilla, Paper, Fabric, Forge, NeoForge. Image families select Java 8 for Minecraft ≤1.16, Java 17 for 1.17–1.20.4, and Java 21 for newer versions. Releases requiring a different JVM need an updated runtime mapping. Prefer exact versions when installing Modrinth projects.
- Modrinth installation checks Minecraft version, loader, server-side availability, required dependencies, and SHA-512 hashes. Client-only mods and unsupported archive formats are rejected. User-provided JARs and files can be uploaded or downloaded by URL.
- Backups stop a running server, copy its data directory, and restart it. Reinstallation and restore first create a recovery backup. Backups are local to the node and can be downloaded; they are not offsite disaster recovery.
- RAM and CPU limits are enforced by Docker. Disk allocations are checked before panel writes/downloads and monitored periodically; exceeding the allocation stops the game container. This is **not a filesystem hard quota**: a running game or shell can temporarily exceed its allocation. Backups also consume host disk. Operators must monitor host free space.
- File operations use an isolated helper container with only that server's data mounted, a read-only root filesystem, and no network. The agent itself requires trusted access to the Docker socket.
- Text editing is limited to 2 MB; uploads to 10 MiB; URL downloads to 256 MiB. Binary files are downloaded in chunks. Commands have bounded time/output. Cancelling or timing out shell execution stops its container because Docker has no portable exec-process kill API.
- AI runs have a 15-minute limit and at most 64 model turns. Completed changes are never silently rolled back. Interrupted runs are recorded and require review before a new request. No automatic autonomous repair or scheduled AI work is enabled.
- Billing, cross-user teams, SFTP, cross-node migration, and other games are outside this first release.

## Upgrades and source

Back up PostgreSQL, node data, backups, and `.env` before upgrading. Rebuild the image, run the migration service, then restart panel/worker/agents. Migrations are serialized and idempotent for the initial schema. Changes to that schema require a new numbered migration rather than editing an already deployed migration.

Every installation exposes `/api/v1/source/archive` with the application source, lockfile, license, and build instructions. The GitHub footer link points to `https://github.com/rexsystems/rex-vibe-panel`; set `SOURCE_URL` to your fork when serving a modified version. Modified deployments must keep the offered corresponding source current.
