# Verification

## Automated

`pnpm test` checks credential hashing/encryption, private-network and traversal rejection, Docker allocation configuration, real PostgreSQL setup/login/authorization, node enrollment, resource allocation, provider secrecy, tool calling, and an end-to-end worker run over the actual agent transport with simulated services.

`pnpm test:e2e` checks the real Mantine UI against a temporary database and simulated node/model. Test fixtures are deliberately identified as simulated and are not seeded into ordinary installations.

The browser suite also runs axe WCAG A/AA checks, light/dark switching, 200% text sizing, mobile overflow checks, and keyboard-only secret visibility. See [UI delivery gate](ui-review.md) for the review and evidence.

## Live-host release checks

On a Linux x86-64 host with Docker, run `scripts/docker-smoke.ts` against a configured test server to exercise container install, startup, status, file editing, logs, backup, and restore. This starts real Minecraft and downloads third-party server software. Set `REX_SMOKE_EULA=true` only after accepting the Minecraft EULA. Do not point this at production data.

```sh
REX_SMOKE_EULA=true corepack pnpm exec tsx scripts/docker-smoke.ts
```

For each supported edition, allocate an exact supported version and confirm a Minecraft client can join through the configured TCP/UDP ports. Verify a compatible Modrinth project loads after restart, then restore a world backup. For Bedrock, check the client-facing node IPv4 and NetherNet UDP range. Confirm a second node can enroll over WSS and an offline node reports an actionable error.

Test each provider with your own credentials: model listing or manual model selection, connection/tool test, streamed or completed text, a status tool call, a multi-step request, provider timeout, invalid credentials, and exhausted quota. Native provider APIs have different response timing; progress events remain visible even when a provider returns text only at completion.

Never record credentials or world contents in test reports. The automated fixture does not establish live Minecraft or cloud-provider compatibility.
