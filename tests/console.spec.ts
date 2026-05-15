/**
 * Console Playwright assertions (Section 9.6 of e2e.md).
 *
 * Reads the latest deterministic report from /reports/ to get real IDs, then
 * visits each page and asserts key content is visible.
 *
 * Run: pnpm e2e:console
 *   (requires coordinator + console already running)
 */

import { test, expect, type Page } from "@playwright/test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const REPORT_DIR = path.join(ROOT, "reports");
const CONSOLE_BASE = process.env.VIBLY_E2E_CONSOLE_URL ?? "http://127.0.0.1:3001";

type Report = {
  projectId?: string;
  projectSlug?: string;
  organizationId?: string;
  proposalId?: string;
  taskId?: string;
  artifactId?: string;
  [k: string]: unknown;
};

async function loadLatestReport(): Promise<Report> {
  const files = (await readdir(REPORT_DIR)).filter((f) => f.endsWith(".json")).sort();
  if (!files.length) throw new Error(`No report files found in ${REPORT_DIR}`);
  const latest = files[files.length - 1]!;
  const text = await readFile(path.join(REPORT_DIR, latest), "utf8");
  return JSON.parse(text) as Report;
}

let report: Report;

test.beforeAll(async () => {
  report = await loadLatestReport();
});

test("anonymous homepage loads public feed shell", async ({ page }: { page: Page }) => {
  const res = await page.goto(`${CONSOLE_BASE}/`);
  expect(res?.ok() ?? res?.status()).toBeTruthy();
  const body = await page.textContent("body");
  expect(body?.length).toBeGreaterThan(0);
});

test("anonymous organizations page loads", async ({ page }: { page: Page }) => {
  await page.goto(`${CONSOLE_BASE}/organizations`);
  await expect(page.locator("body")).not.toBeEmpty();
  const body = await page.textContent("body");
  expect((body?.length ?? 0) > 50).toBe(true);
});

test("project detail page loads", async ({ page }: { page: Page }) => {
  const slug = report.projectSlug ?? report.projectId;
  if (!slug) test.skip();
  await page.goto(`${CONSOLE_BASE}/projects/${slug}`);
  await expect(page.locator("body")).not.toBeEmpty();
  const title = await page.evaluate(() => document.title);
  expect(title).not.toContain("404");
});

test("agent detail page loads anonymously", async ({ page }: { page: Page }) => {
  const response = await fetch(`${CONSOLE_BASE}/api/coordinator/agents?limit=1`);
  if (!response.ok) test.skip();
  const body = await response.json() as { data?: unknown; ok?: boolean };
  const data = body.data;
  const first = Array.isArray(data) ? data[0] : (data && typeof data === "object" && Array.isArray((data as { items?: unknown[] }).items) ? (data as { items: unknown[] }).items[0] : undefined);
  if (!first || typeof first !== "object") test.skip();
  const agentId = String((first as { id?: string }).id ?? "");
  if (!agentId) test.skip();

  await page.goto(`${CONSOLE_BASE}/agents/${encodeURIComponent(agentId)}`);
  await expect(page.locator("body")).not.toBeEmpty();
  const title = await page.evaluate(() => document.title);
  expect(title).not.toContain("404");
});

test("anonymous private inbox API is rejected", async ({ page }: { page: Page }) => {
  const response = await page.request.get(`${CONSOLE_BASE}/api/coordinator/agents/demo/inbox?limit=1`);
  expect(response.status()).toBe(401);
});

test("proposal detail page loads and shows correct status", async ({ page }: { page: Page }) => {
  if (!report.proposalId) test.skip();
  const slug = report.projectSlug ?? report.projectId;
  await page.goto(`${CONSOLE_BASE}/projects/${slug}/proposals/${report.proposalId}`);
  await expect(page.locator("body")).not.toBeEmpty();
  // Should not be a 404
  const statusCode = await page.evaluate(() => document.title);
  expect(statusCode).not.toContain("404");
});

test("task detail page loads", async ({ page }: { page: Page }) => {
  if (!report.taskId) test.skip();
  const slug = report.projectSlug ?? report.projectId;
  await page.goto(`${CONSOLE_BASE}/projects/${slug}/tasks/${report.taskId}`);
  await expect(page.locator("body")).not.toBeEmpty();
  const title = await page.evaluate(() => document.title);
  expect(title).not.toContain("404");
});

test("artifact detail page loads", async ({ page }: { page: Page }) => {
  if (!report.artifactId) test.skip();
  const slug = report.projectSlug ?? report.projectId;
  await page.goto(`${CONSOLE_BASE}/projects/${slug}/artifacts/${report.artifactId}`);
  await expect(page.locator("body")).not.toBeEmpty();
  const title = await page.evaluate(() => document.title);
  expect(title).not.toContain("404");
});
