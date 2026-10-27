import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('complete Mantine workflow, manual controls, themes, translations and mobile reflow', async ({ page, request }) => {
  test.setTimeout(120000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  async function operate(type: string, action: () => Promise<unknown>) {
    const response = page.waitForResponse(r => r.url().endsWith('/operations') && r.request().method() === 'POST' && r.request().postDataJSON()?.type === type);
    await action(); const result = await response; expect(result.ok(), await result.text()).toBe(true);
  }
  await page.goto('/');
  await expect(page.getByLabel('Setup token')).toHaveCount(0);
  await expect(page.getByLabel('Password')).toHaveAttribute('minlength', '8');
  await page.getByLabel('Email').fill('browser@example.com'); await page.getByLabel('Password').fill('rexpass8');
  await page.getByRole('button', { name: 'Set up REX', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Set up a node now?', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Later', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your Minecraft servers' })).toBeVisible();
  await page.getByRole('link', { name: 'Administration', exact: true }).first().click();
  await page.getByRole('button', { name: 'Add node', exact: true }).click();
  const nodeModal = page.getByRole('dialog');
  await nodeModal.getByLabel('Name').fill('Simulated browser node'); await nodeModal.getByLabel('Address').fill('203.0.113.5'); await nodeModal.getByRole('button', { name: 'Add node', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Enrollment token', exact: true })).toContainText('Token expires');
  const token = await page.getByRole('dialog', { name: 'Enrollment token', exact: true }).locator('pre').innerText(); await request.post('/__test/enroll', { data: { token: token.trim() } });
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  const config = await (await request.get('/__test/config')).json();
  await page.getByLabel('Trusted provider origins').fill(config.providerOrigin); await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('tab', { name: 'Users', exact: true }).click(); await expect(page.getByRole('cell', { name: 'browser@example.com' })).toBeVisible();
  await page.getByRole('tab', { name: 'Server allocations' }).click(); await page.getByRole('button', { name: 'Allocate server' }).click();
  const allocate = page.getByRole('dialog');
  await allocate.getByLabel('Name').fill('Browser Minecraft');
  await allocate.getByLabel('Nodes').click(); await page.getByRole('option', { name: /Simulated browser node/ }).click();
  await allocate.getByLabel('Version').fill('1.21.11'); await allocate.getByRole('checkbox').check(); await allocate.getByRole('button', { name: 'Allocate server' }).click(); await expect(allocate).not.toBeVisible();
  await page.getByRole('link', { name: 'Providers', exact: true }).first().click(); await page.getByRole('button', { name: 'Add provider' }).click();
  const providerModal = page.getByRole('dialog');
  await providerModal.getByLabel('Preset').click(); await page.getByRole('option', { name: 'Custom OpenAI-compatible', exact: true }).click();
  await providerModal.getByLabel('Name').fill('Simulated provider'); await providerModal.getByLabel('Endpoint URL').fill(`${config.providerOrigin}/v1`); await providerModal.getByLabel('Model').fill('simulated-model'); await providerModal.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Test connection' }).click(); await expect(page.getByText('Tools verified', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Use by default', exact: true }).click(); await expect(page.getByRole('button', { name: 'Default provider', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'List models' }).click(); await expect(page.getByRole('textbox', { name: 'Model', exact: true })).toHaveAttribute('aria-haspopup', 'listbox'); await page.getByRole('textbox', { name: 'Model', exact: true }).click(); await page.getByRole('option', { name: 'simulated-model-2', exact: true }).click(); await page.getByRole('button', { name: 'Update model' }).click(); await expect(page.getByText('Chat only / untested', { exact: true })).toBeVisible(); await page.getByRole('button', { name: 'Test connection' }).click(); await expect(page.getByText('Tools verified', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit provider' }).click(); const editProvider = page.getByRole('dialog', { name: 'Edit provider', exact: true }); await editProvider.getByLabel('Name').fill('Edited simulated provider'); await editProvider.getByRole('button', { name: 'Save', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Edited simulated provider' })).toBeVisible(); await page.getByRole('button', { name: 'Test connection' }).click(); await expect(page.getByText('Tools verified', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Servers', exact: true }).first().click(); await page.getByRole('link', { name: 'Open server' }).click();
  const attached = page.waitForResponse(r => r.url().includes('/upload?') && r.request().method() === 'POST'); await page.getByRole('tabpanel', { name: 'Chat', exact: true }).locator('input[type=file]').setInputFiles({ name: 'request.txt', mimeType: 'text/plain', buffer: Buffer.from('user attachment fixture') }); expect((await attached).ok()).toBe(true); await expect(page.getByLabel('What should REX do?')).toHaveValue(/Attached file: uploads\/request.txt/);
  await page.getByLabel('What should REX do?').fill('Check server status.'); await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('Simulated node reports that the server is running. Status verified.', { exact: true })).toBeVisible({ timeout: 20000 });
  await expect(page.getByText('Run status: completed', { exact: true })).toBeVisible(); await page.getByLabel('What should REX do?').fill('long-running-test'); await page.getByRole('button', { name: 'Send', exact: true }).click(); await page.getByRole('button', { name: 'Stop execution' }).click(); await expect(page.getByText('Run status: stopped', { exact: true })).toBeVisible({ timeout: 15000 });
  await page.getByRole('tab', { name: 'Activity', exact: true }).click(); await expect(page.locator('summary').filter({ hasText: 'tool.completed' })).toBeVisible(); await page.locator('summary').filter({ hasText: 'tool.completed' }).click();
  await page.getByRole('tab', { name: 'Advanced', exact: true }).click(); await operate('install', () => page.getByRole('button', { name: 'Install', exact: true }).click()); await operate('power', () => page.getByRole('button', { name: 'Start', exact: true }).click());
  for (const name of ['Restart', 'Stop', 'Start', 'Kill', 'Start']) await operate('power', () => page.getByRole('button', { name, exact: true }).click());
  await page.getByLabel('Console command').fill('list'); await operate('console', () => page.getByRole('button', { name: 'Send command', exact: true }).first().click());
  await page.getByRole('tab', { name: 'Files', exact: true }).click(); await page.getByRole('button', { name: 'uploads/', exact: true }).click(); await expect(page.getByRole('button', { name: 'request.txt', exact: true })).toBeVisible(); await page.getByRole('button', { name: 'Parent directory' }).click(); await page.getByRole('button', { name: 'server.properties', exact: true }).click(); await page.getByLabel('File content', { exact: true }).fill('motd=Edited in browser\n'); await operate('write', () => page.getByRole('button', { name: 'Save file' }).click());
  await page.getByLabel('File path').fill('browser.txt'); await page.getByRole('button', { name: 'New file' }).click(); await page.getByLabel('File content', { exact: true }).fill('new file'); await operate('write', () => page.getByRole('button', { name: 'Save file' }).click()); await page.getByRole('button', { name: 'Delete file' }).click(); await operate('remove', () => page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click());
  const upload = page.getByRole('tabpanel', { name: 'Files', exact: true }).locator('input[type=file]'); await upload.setInputFiles({ name: 'uploaded.txt', mimeType: 'text/plain', buffer: Buffer.from('uploaded in test') }); await expect(page.getByRole('button', { name: 'uploaded.txt', exact: true })).toBeVisible();
  const download = page.waitForEvent('download'); await page.getByRole('link', { name: 'Download', exact: true }).first().click(); expect((await download).suggestedFilename()).toBeTruthy();
  await page.getByRole('tab', { name: 'Backups', exact: true }).click(); await operate('backup', () => page.getByRole('button', { name: 'Create backup' }).click()); await page.getByRole('button', { name: 'Restore', exact: true }).click(); await operate('restore', () => page.getByRole('dialog').getByRole('button', { name: 'Restore', exact: true }).click());
  await page.getByRole('tab', { name: 'Shell', exact: true }).click(); await page.getByLabel('Shell command (inside game container)').fill('pwd'); await page.getByRole('button', { name: 'Send command', exact: true }).last().click(); await expect(page.getByText(/simulated-shell-output/)).toBeVisible();
  await page.getByRole('link', { name: 'Settings', exact: true }).first().click(); await page.getByText('Dark', { exact: true }).click(); await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'dark'); await page.getByText('Light', { exact: true }).click(); await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'light');
  await page.getByText('Română', { exact: true }).click(); await expect(page.getByRole('heading', { name: 'Setări' })).toBeVisible(); await page.getByText('English', { exact: true }).click();
  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 }); await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 360, height: 900 }); await page.getByRole('button', { name: 'Menu', exact: true }).click(); await page.getByRole('navigation', { name: 'Mobile', exact: true }).getByRole('link', { name: 'Servers', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Your Minecraft servers' })).toBeVisible();
  await page.getByRole('link', { name: 'Open server' }).click(); await expect(page.getByRole('heading', { name: 'Browser Minecraft', exact: true, level: 1 })).toBeVisible(); await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); await page.screenshot({ path: 'test-results/rex-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.screenshot({ path: 'test-results/rex-desktop.png', fullPage: true });
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.getByRole('link', { name: 'Settings', exact: true }).first().click(); await page.getByText('Dark', { exact: true }).click(); await page.getByRole('link', { name: 'Servers', exact: true }).first().click(); await page.getByRole('link', { name: 'Open server' }).click(); await expect(page.getByRole('heading', { name: 'Browser Minecraft' })).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]); await page.screenshot({ path: 'test-results/rex-dark.png', fullPage: true });
  await page.setViewportSize({ width: 360, height: 900 }); await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; }); await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
  await page.getByRole('button', { name: 'Menu', exact: true }).focus(); await page.keyboard.press('Enter'); await expect(page.getByRole('navigation', { name: 'Mobile', exact: true })).toBeVisible(); await page.keyboard.press('Tab'); expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('A');
  expect(errors).toEqual([]);
});

test('account forms, keyboard secret toggle, retry, token copy, provider deletion and GitHub link', async ({ page, request }) => {
  const status = await (await request.get('/api/v1/auth/status')).json();
  if (status.setupRequired) await request.post('/api/v1/auth/setup', { headers: { 'x-rex-request': '1' }, data: { email: 'browser@example.com', password: 'rexpass8' } });
  await page.goto('/'); await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await page.getByLabel('Email').fill('browser@example.com'); await page.getByLabel('Password').fill('wrong-password-123');
  await page.getByRole('button', { name: 'Show secret', exact: true }).focus(); await page.keyboard.press('Enter'); await expect(page.getByLabel('Password')).toHaveAttribute('type', 'text'); await page.getByRole('button', { name: 'Hide secret', exact: true }).focus(); await page.keyboard.press('Space'); await expect(page.getByLabel('Password')).toHaveAttribute('type', 'password');
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page.getByRole('alert').filter({ hasText: 'Email or password is incorrect.' }).first()).toBeVisible(); await page.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
  await page.getByLabel('Password').fill('rexpass8'); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Your Minecraft servers' })).toBeVisible();
  let fail = true;
  await page.route('**/api/v1/providers', route => { if (fail && route.request().method() === 'GET') { fail = false; return route.fulfill({ status: 503, json: { error: 'Simulated temporary provider listing failure.' } }); } return route.continue(); });
  await page.getByRole('link', { name: 'Providers', exact: true }).first().click(); await expect(page.getByText('Simulated temporary provider listing failure.', { exact: true })).toBeVisible(); await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('.provider-row').first().or(page.getByRole('heading', { name: 'No providers configured', exact: true }))).toBeVisible();
  if (await page.locator('.provider-row').count()) {
    await page.locator('.provider-row').first().getByRole('button', { name: 'Delete', exact: true }).click(); await page.getByRole('dialog', { name: 'Delete this provider?', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.locator('.provider-row').first().getByRole('button', { name: 'Delete', exact: true }).click(); await page.getByRole('dialog', { name: 'Delete this provider?', exact: true }).getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'No providers configured', exact: true })).toBeVisible();
  }
  await expect(page.getByRole('link', { name: 'Source code', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'GitHub', exact: true })).toHaveAttribute('href', 'https://github.com/rexsystems/rex-vibe-panel');
  await expect(page.getByRole('link', { name: 'GitHub', exact: true })).toHaveAttribute('target', '_blank');
  await page.getByRole('link', { name: 'Administration', exact: true }).first().click();
  if (await page.getByRole('button', { name: 'New enrollment token', exact: true }).count()) {
    await page.getByRole('button', { name: 'New enrollment token', exact: true }).first().click(); const dialog = page.getByRole('dialog', { name: 'Enrollment token', exact: true }); await dialog.getByRole('button', { name: 'Copy token', exact: true }).click(); await expect(page.getByText('Copied', { exact: true })).toBeVisible(); await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  }
  await page.getByRole('link', { name: 'Settings', exact: true }).first().click(); await page.getByText('System', { exact: true }).click(); await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('button', { name: 'Create account', exact: true }).click(); await page.getByLabel('Email').fill('new-user@example.com'); await page.getByLabel('Password').fill('newpass8'); await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No servers assigned', exact: true })).toBeVisible(); await expect(page.getByRole('link', { name: 'Administration', exact: true })).toHaveCount(0);
});

test('optional local-node auto-setup enrolls its agent and becomes ready', async ({ page }) => {
  await page.goto('/'); await page.getByLabel('Email').fill('browser@example.com'); await page.getByLabel('Password').fill('rexpass8'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('link', { name: 'Administration', exact: true }).first().click();
  await page.getByRole('button', { name: 'Auto-setup local node', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Set up a node now?', exact: true });
  await expect(dialog).toBeVisible(); await dialog.getByLabel('Node name').fill('Automatically enrolled fixture node'); await dialog.getByLabel('Address players will use').fill('127.0.0.1');
  await dialog.getByRole('button', { name: 'Set up local node', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('The node is connected and ready for server allocation.', { timeout: 15000 });
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Automatically enrolled fixture node', exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
});
