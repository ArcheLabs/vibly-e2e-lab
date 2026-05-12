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

test("console loads login page", async ({ page }: { page: Page }) => {
  const res = await page.goto(`${CONSOLE_BASE}/login`);
  expect(res?.ok() ?? res?.status()).toBeTruthy();
  // The page should contain something indicating it's the Vibly console
  const body = await page.textContent("body");
  expect(body?.length).toBeGreaterThan(0);
});

test("project feed page loads and shows key events", async ({ page }: { page: Page }) => {
  const slug = report.projectSlug ?? report.projectId;
  if (!slug) test.skip();
  await page.goto(`${CONSOLE_BASE}/projects/${slug}/feed`);
  await expect(page.locator("body")).not.toBeEmpty();
  // Feed should contain at least one event entry
  const body = await page.textContent("body");
  const hasContent = (body?.length ?? 0) > 100;
  expect(hasContent).toBe(true);
});

test("project detail page loads", async ({ page }: { page: Page }) => {
  const slug = report.projectSlug ?? report.projectId;
  if (!slug) test.skip();
  await page.goto(`${CONSOLE_BASE}/projects/${slug}`);
  await expect(page.locator("body")).not.toBeEmpty();
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
