# UI delivery gate

Reviewed 2026-10-27. Scope: the Mantine application and its implemented API-backed workflows. Test infrastructure uses real PostgreSQL with an explicitly simulated model and node. Live Docker/Minecraft and cloud credentials are separate release checks in `verification.md`.

Default-provider update reviewed 2026-10-28: the added Mantine button uses the existing component styling. The browser suite selects a default and checks its disabled status label; API tests cover ownership, encrypted private bootstrap, idempotence and exclusion of public accounts. The real local key was checked only through AWS model discovery, without inference; it is excluded from source/client artifacts and ordinary test fixtures.

Onboarding update: the password minimum is 8 characters in both API and forms; initial account setup uses email/password and remains closed after the first administrator. The optional local-node dialog offers setup or Later, exposes Docker availability and job progress, and uses the existing Mantine palette, focus/contrast styles and responsive modal. API tests cover authorization, missing Docker, duplicate requests and retry with the same node. Browser tests exercise the new prompt and automatic enrollment with a simulated installer; no live Docker installation is claimed.

Docker diagnostic update: missing/stopped daemon and denied socket access now produce distinct actionable messages, translated into Romanian. Five targeted tests cover these errors and a successful probe. The local Docker service was started and enabled, panel-user group membership was applied, and the live panel was restarted with Docker-group access. Existing component styling and layout are unchanged.

Publishing update: the footer uses the concrete label GitHub and points to the public REX repository, retaining the AGPL license label. Browser assertions verify the label, destination and new-tab behavior; source archive coverage remains in API integration tests. Fedora agent enrollment was verified against Docker after applying a controller-specific SELinux option and shared data-volume labels; SELinux remains enabled on the host.

## Hard gate

- R-02 PASS: application copy contains no em dashes.
- R-03 PASS: Chromium checks at 360, 768, 1280 and 1440 pixels; no document overflow, including the server workspace at 200% root text size.
- R-17 PASS: resource values come from allocations or agent responses; no marketing statistics exist.
- R-18 PASS: no testimonials, fictional people, or generated avatars exist.
- R-23 PASS: branding uses the supplied product name in text; no invented visual assets exist. Fixture data is explicitly described as simulated and is isolated to tests.
- R-24 PASS: navigation routes resolve to Servers, Providers, Settings, Administration, and the selected server; source download has an implemented endpoint.
- R-25 PASS: axe WCAG A/AA scans pass in light/dark server views and the authentication form. Contrast checker: white/green 6.11:1; black/green 10.47:1; light hint text 7.19:1; dark hint text 7.62:1.
- R-26 PASS: controls call API operations, update a real preference, open a dialog, navigate, upload, download, or refresh a query. No placeholder actions exist.
- R-27 PASS: query views render loading, actionable errors with Retry, and product-specific empty states; the browser suite exercises an injected listing failure and successful retry.
- R-28 PASS: no FAQ exists.
- R-32 PASS: visible focus styles, labelled dialogs and notifications, Escape dismissal, keyboard navigation, and Enter/Space secret visibility controls are implemented and exercised.
- R-33 PASS: source changes were written directly to application/configuration files; no external source-patching script exists.
- R-34 PASS: both themes are selected and checked in Chromium, including axe scans.
- R-35 PASS: production build, TypeScript checks, API integration tests, and recorded browser click-through run against the application. Docker and actual cloud models are not represented as verified.
- R-36 PASS: no unsupported security certification, performance, hosting, or customer claims exist. Runtime limits are documented in README.
- R-37 PASS: the user selected simple Mantine, grey/green, light/dark; DESIGN.md records ENERGY 1 / RHYTHM 1 / MOTION 1.
- R-38 PASS: ordinary installations start empty; only isolated test fixtures contain simulated servers, logs, models and metrics.

## Purpose gate

- R-01 PASS: no decorative gradients or glows; green identifies primary actions.
- R-04 PASS: text labels handle navigation/actions; built-in visibility/close/select glyphs communicate their component behavior.
- R-06 PASS: system sans for readable forms, monospace for actual console/code output; reasons recorded in DESIGN.md.
- R-07 PASS: no decorative grids or background patterns.
- R-08 PASS: no decorative button arrows.
- R-09 PASS: provider capabilities and node/run state are plain informational text, without decorative badges.
- R-10 PASS: no glassmorphism.
- R-12 PASS: panel surfaces are flat; Mantine dialog elevation separates a modal from its backdrop.
- R-13 PASS: no glow effects.
- R-14 PASS: server/provider lists follow their content; the chat workspace and technical details have different hierarchy.
- R-19 PASS: no looping decoration; transitions serve interaction states and reduced-motion overrides are present.
- R-22 PASS: no unrelated illustrations.

## Liveliness

- Dials PASS: ENERGY 1 / RHYTHM 1 / MOTION 1 match the deliberately quiet administration interface.
- Focal point PASS: server chat and its composer occupy the primary workspace; technical detail is secondary.
- Spacing PASS: page, conversation, composer and console use separate spacing levels; mobile stacks the workspace.
- Accent PASS: green marks the primary action and selected navigation state; operational error colors retain their meaning.
- Identity PASS: REX conversation, Minecraft runtime details, action history and compact console repeat consistently across server views.
- Design read PASS: the agreed direction was declared before implementation and recorded in DESIGN.md.

## Craftsmanship and consistency

- C-1 / R-31 PASS: major choices have reasons in DESIGN.md; default Mantine styling follows the user's explicit request.
- C-2 PASS: implemented controls have source handlers and the browser suite exercises setup/login/registration/logout, node enrollment/token copy, allocation, provider create/edit/model/test/delete, chat attachments/run/stop, power commands, file operations, backups, shell, themes, language and source download.
- C-3 / R-05 PASS: the layout serves server administration; no landing-page template, decorative chart, pricing section, or filler exists.
- C-4 PASS: mobile, keyboard, 200% text, loading, empty, error and theme states are checked.
- C-5 PASS: fixture content is labelled and no operational success is claimed without a backend result.
- R-11 PASS: inputs/buttons use small radii; panels/dialogs use the larger surface radius.
- R-15 / R-16 PASS: actions use concrete labels such as Add provider, Allocate server and Save file; no promotional buzzwords.
- R-20 / R-30 PASS: the composition follows REX's chat-based Minecraft workflow and does not reproduce another panel's UI.
- R-21 PASS: theme follows the system initially and remains user-selectable.
- R-29 PASS: neutrals and green form the palette; red/yellow are reserved for functional errors and warnings.

## Evidence

`tests/browser/panel.spec.ts` records the click-through and accessibility checks. Generated screenshots are saved to `test-results/rex-desktop.png`, `rex-mobile.png` and `rex-dark.png`. `tests/api.test.ts` covers authorization, provider secrecy, allocation, agent transport, worker runs, cancellation and interruption recovery. `tests/security.test.ts`, `providers.test.ts` and `modrinth.test.ts` cover their respective boundaries and protocols.
