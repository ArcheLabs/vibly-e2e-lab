import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

type Phase = "plan" | "build" | "deploy" | "full";
type DeployProfile = "custom" | "gcp" | "npm";

interface ProjectDefinition {
  id: string;
  label: string;
  repoPath: string;
  buildCommands: string[];
  defaultDeployCommand?: string;
}

interface ProjectExecutionResult {
  id: string;
  label: string;
  repoPath: string;
  branch: string;
  commit: string;
  dirty: boolean;
  buildCommands: string[];
  deployEnvVar: string;
  deploySource?: string;
  deployCommand?: string;
  missingDeployEnv: string[];
  skipped: boolean;
  skipReason?: string;
  buildRan: boolean;
  deployRan: boolean;
  status: "planned" | "succeeded" | "failed" | "skipped";
  error?: string;
}

interface Options {
  phase: Phase;
  profile: DeployProfile;
  dryRun: boolean;
  allowDirty: boolean;
  continueOnError: boolean;
  list: boolean;
  requireDeployHook: boolean;
  only: Set<string>;
  skip: Set<string>;
  target: string;
}

interface DeployCommandResolution {
  envVar: string;
  command?: string;
  source?: string;
  missingEnv: string[];
}

interface GitInfo {
  branch: string;
  commit: string;
  dirty: boolean;
}

const ROOT = path.resolve(import.meta.dirname, "..");
const REPORT_DIR = path.join(ROOT, "reports");
const REPO_ROOT = path.resolve(ROOT, "..");

const PROJECTS: ProjectDefinition[] = [
  {
    id: "concord",
    label: "Concord",
    repoPath: path.join(REPO_ROOT, "concord"),
    buildCommands: ["pnpm build"],
  },
  {
    id: "vibly-chain",
    label: "Vibly Chain",
    repoPath: path.join(REPO_ROOT, "vibly-chain"),
    buildCommands: ["cargo build --release -p vibly-solo-node"],
  },
  {
    id: "vibly-client",
    label: "Vibly Client",
    repoPath: path.join(REPO_ROOT, "vibly-client"),
    buildCommands: ["pnpm build"],
  },
  {
    id: "vibly-console",
    label: "Vibly Console",
    repoPath: path.join(REPO_ROOT, "vibly-console"),
    buildCommands: ["pnpm build"],
  },
  {
    id: "vibly-coordinator",
    label: "Vibly Coordinator",
    repoPath: path.join(REPO_ROOT, "vibly-coordinator"),
    buildCommands: ["pnpm build"],
  },
  {
    id: "vibly-docs",
    label: "Vibly Docs",
    repoPath: path.join(REPO_ROOT, "vibly-docs"),
    buildCommands: [],
  },
  {
    id: "vibly-e2e-lab",
    label: "Vibly E2E Lab",
    repoPath: path.join(REPO_ROOT, "vibly-e2e-lab"),
    buildCommands: ["pnpm typecheck"],
  },
  {
    id: "vibly-indexer",
    label: "Vibly Indexer",
    repoPath: path.join(REPO_ROOT, "vibly-indexer"),
    buildCommands: ["npm run build"],
  },
  {
    id: "vibly-coordinator-http-contract",
    label: "Coordinator HTTP Contract",
    repoPath: path.join(REPO_ROOT, "vibly-coordinator-http-contract"),
    buildCommands: ["pnpm build"],
  },
];

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(REPORT_DIR, { recursive: true });

  if (options.list) {
    printProjectList();
    return;
  }

  const selected = PROJECTS.filter((project) => {
    if (options.only.size > 0 && !options.only.has(project.id)) return false;
    if (options.skip.has(project.id)) return false;
    return true;
  });

  if (selected.length === 0) {
    throw new Error("No projects selected. Use --only or remove --skip filters.");
  }

  const results: ProjectExecutionResult[] = [];
  for (const project of selected) {
    try {
      const result = await deployProject(project, options);
      results.push(result);
    } catch (error) {
      if (!options.continueOnError) throw error;
      results.push(failedResult(project, options, error));
      console.error(`[deploy] ${project.id} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const reportPath = await writeReport(results, options);
  printSummary(results, options, reportPath);

  if (results.some((result) => result.status === "failed")) {
    process.exitCode = 1;
  }
}

async function deployProject(project: ProjectDefinition, options: Options): Promise<ProjectExecutionResult> {
  ensureRepo(project.repoPath);
  const git = readGitInfo(project.repoPath);
  const deploy = resolveDeployCommand(project, options, git);

  if (options.phase !== "plan" && git.dirty && !options.allowDirty) {
    throw new Error(`${project.id} has uncommitted changes. Re-run with --allow-dirty if this is intentional.`);
  }

  const result: ProjectExecutionResult = {
    id: project.id,
    label: project.label,
    repoPath: project.repoPath,
    branch: git.branch,
    commit: git.commit,
    dirty: git.dirty,
    buildCommands: [...project.buildCommands],
    deployEnvVar: deploy.envVar,
    deploySource: deploy.source,
    deployCommand: deploy.command,
    missingDeployEnv: deploy.missingEnv,
    skipped: false,
    buildRan: false,
    deployRan: false,
    status: "planned",
  };

  console.log(`\n[deploy] ${project.label} (${project.id})`);
  console.log(`[deploy] repo=${project.repoPath}`);
  console.log(`[deploy] ref=${git.branch}@${git.commit}${git.dirty ? " dirty" : ""}`);

  if (options.phase === "plan") {
    printProjectPlan(project, deploy);
    return result;
  }

  if (options.phase === "build" || options.phase === "full") {
    for (const command of project.buildCommands) {
      runShellCommand(command, project.repoPath, project.id, options, git);
      result.buildRan = true;
    }
  }

  if (options.phase === "deploy" || options.phase === "full") {
    if (!deploy.command) {
      if (options.requireDeployHook) {
        const missing = deploy.missingEnv.length ? ` Missing: ${deploy.missingEnv.join(", ")}` : "";
        throw new Error(`No deploy hook configured for ${project.id}.${missing}`);
      }
      result.skipped = true;
      result.status = "skipped";
      result.skipReason = `No deploy hook configured. Set ${deploy.envVar}.`;
      console.log(`[deploy] skip deploy: ${result.skipReason}`);
      return result;
    }
    runShellCommand(deploy.command, project.repoPath, project.id, options, git);
    result.deployRan = true;
  }

  result.status = "succeeded";
  return result;
}

function runShellCommand(command: string, cwd: string, projectId: string, options: Options, git: GitInfo): void {
  const prefix = options.dryRun ? "[dry-run]" : "[exec]";
  console.log(`${prefix} (${projectId}) ${command}`);
  if (options.dryRun) return;

  const child = spawnSync("bash", ["-lc", command], {
    cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      VIBLY_DEPLOY_PROJECT: projectId,
      VIBLY_DEPLOY_TARGET: options.target,
      VIBLY_DEPLOY_ROOT: REPO_ROOT,
      VIBLY_DEPLOY_GIT_BRANCH: git.branch,
      VIBLY_DEPLOY_GIT_COMMIT: git.commit,
      VIBLY_DEPLOY_GIT_DIRTY: git.dirty ? "true" : "false",
      VIBLY_DEPLOY_REPO_PATH: cwd,
    },
  });
  if (child.status !== 0) {
    throw new Error(`Command failed for ${projectId}: ${command}`);
  }
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    phase: "plan",
    profile: "custom",
    dryRun: false,
    allowDirty: false,
    continueOnError: false,
    list: false,
    requireDeployHook: false,
    only: new Set<string>(),
    skip: new Set<string>(),
    target: process.env.VIBLY_DEPLOY_TARGET ?? "production",
  };

  for (const arg of argv) {
    if (arg === "--") continue;
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--allow-dirty") {
      options.allowDirty = true;
      continue;
    }
    if (arg === "--continue-on-error") {
      options.continueOnError = true;
      continue;
    }
    if (arg === "--list") {
      options.list = true;
      continue;
    }
    if (arg === "--require-deploy-hook") {
      options.requireDeployHook = true;
      continue;
    }
    if (arg.startsWith("--profile=")) {
      const profile = arg.slice("--profile=".length) as DeployProfile;
      if (!["custom", "gcp", "npm"].includes(profile)) {
        throw new Error(`Unsupported profile: ${profile}`);
      }
      options.profile = profile;
      continue;
    }
    if (arg.startsWith("--phase=")) {
      const phase = arg.slice("--phase=".length) as Phase;
      if (!["plan", "build", "deploy", "full"].includes(phase)) {
        throw new Error(`Unsupported phase: ${phase}`);
      }
      options.phase = phase;
      continue;
    }
    if (arg.startsWith("--only=")) {
      for (const item of splitCsv(arg.slice("--only=".length))) options.only.add(item);
      continue;
    }
    if (arg.startsWith("--skip=")) {
      for (const item of splitCsv(arg.slice("--skip=".length))) options.skip.add(item);
      continue;
    }
    if (arg.startsWith("--target=")) {
      options.target = arg.slice("--target=".length) || options.target;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelpAndExit();
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.dryRun && options.phase !== "plan") {
    console.log(`[deploy] dry-run enabled; phase=${options.phase}`);
  }

  return options;
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function ensureRepo(repoPath: string): void {
  if (!existsSync(repoPath)) {
    throw new Error(`Repository path does not exist: ${repoPath}`);
  }
}

function readGitInfo(repoPath: string): GitInfo {
  const branch = runGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const commit = runGit(repoPath, ["rev-parse", "--short", "HEAD"]);
  const dirty = runGit(repoPath, ["status", "--porcelain"]).length > 0;
  return { branch, commit, dirty };
}

function runGit(repoPath: string, args: string[]): string {
  const child = spawnSync("git", args, {
    cwd: repoPath,
    encoding: "utf8",
  });
  if (child.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${repoPath}: ${child.stderr || child.stdout}`);
  }
  return child.stdout.trim();
}

function failedResult(project: ProjectDefinition, options: Options, error: unknown): ProjectExecutionResult {
  let git = { branch: "unknown", commit: "unknown", dirty: false };
  try {
    git = readGitInfo(project.repoPath);
  } catch {
    // Preserve the original failure as the result error.
  }
  const deploy = resolveDeployCommand(project, options, git);
  return {
    id: project.id,
    label: project.label,
    repoPath: project.repoPath,
    branch: git.branch,
    commit: git.commit,
    dirty: git.dirty,
    buildCommands: [...project.buildCommands],
    deployEnvVar: deploy.envVar,
    deploySource: deploy.source,
    deployCommand: deploy.command,
    missingDeployEnv: deploy.missingEnv,
    skipped: false,
    buildRan: false,
    deployRan: false,
    status: "failed",
    error: error instanceof Error ? error.message : String(error),
  };
}

function deployEnvVarName(projectId: string): string {
  return `VIBLY_DEPLOY_${projectId.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase()}_CMD`;
}

function resolveDeployCommand(project: ProjectDefinition, options: Options, git?: GitInfo): DeployCommandResolution {
  const envVar = deployEnvVarName(project.id);
  const override = process.env[envVar]?.trim();
  if (override) {
    return { envVar, command: override, source: envVar, missingEnv: [] };
  }

  const profile = resolveProfileDeployCommand(project.id, options, git);
  if (profile) {
    return { envVar, ...profile };
  }

  if (project.defaultDeployCommand) {
    return { envVar, command: project.defaultDeployCommand, source: "default", missingEnv: [] };
  }

  return { envVar, missingEnv: [] };
}

function resolveProfileDeployCommand(projectId: string, options: Options, git?: GitInfo): Omit<DeployCommandResolution, "envVar"> | undefined {
  if (options.profile === "gcp") return resolveGcpDeployCommand(projectId, git);
  if (options.profile === "npm") return resolveNpmDeployCommand(projectId);
  return undefined;
}

function resolveGcpDeployCommand(projectId: string, git?: GitInfo): Omit<DeployCommandResolution, "envVar"> | undefined {
  const project = requiredEnv("GCP_PROJECT_ID");
  const region = requiredEnv("GCP_REGION");
  const defaultVmZone = requiredEnv("GCP_VM_ZONE");
  const allowUnauth = envFlag("GCP_RUN_ALLOW_UNAUTHENTICATED", true) ? "--allow-unauthenticated" : "--no-allow-unauthenticated";
  const flags = (name: string) => {
    const value = process.env[name]?.trim();
    return value ? ` ${value}` : "";
  };
  const missingRunEnv = [
    project ? null : "GCP_PROJECT_ID",
    region ? null : "GCP_REGION",
  ].filter(Boolean) as string[];

  const cloudRun = (serviceName: string, extraFlagsEnv: string): Omit<DeployCommandResolution, "envVar"> => {
    if (missingRunEnv.length > 0) return { source: "gcp", missingEnv: missingRunEnv };
    return {
      command: `gcloud run deploy ${shellQuote(serviceName)} --source . --region ${shellQuote(region!)} --project ${shellQuote(project!)} ${allowUnauth}${flags(extraFlagsEnv)}`,
      source: "gcp",
      missingEnv: [],
    };
  };

  const cloudVm = (
    vmName: string | undefined,
    zoneName: string | undefined,
    requiredVars: string[],
    remoteCommand: string,
  ): Omit<DeployCommandResolution, "envVar"> => {
    const missingVmEnv = [
      project ? null : "GCP_PROJECT_ID",
      zoneName ? null : requiredVars.find((name) => name.endsWith("_ZONE")) ?? "GCP_VM_ZONE",
      vmName ? null : requiredVars.find((name) => name.endsWith("_VM")) ?? "GCP_VM_NAME",
    ].filter(Boolean) as string[];
    if (missingVmEnv.length > 0) return { source: "gcp", missingEnv: missingVmEnv };
    return {
      command: `gcloud compute ssh ${shellQuote(vmName!)} --zone ${shellQuote(zoneName!)} --project ${shellQuote(project!)} --command ${shellQuote(remoteCommand)}`,
      source: "gcp",
      missingEnv: [],
    };
  };

  switch (projectId) {
    case "vibly-chain": {
      const vm = process.env.GCP_VIBLY_CHAIN_VM?.trim();
      const zone = process.env.GCP_VIBLY_CHAIN_ZONE?.trim() || defaultVmZone;
      const service = process.env.GCP_VIBLY_CHAIN_SERVICE?.trim() || "vibly-solo-node";
      const mode = process.env.GCP_VIBLY_CHAIN_DEPLOY_MODE?.trim() || "upload";
      const remoteBin = process.env.GCP_VIBLY_CHAIN_REMOTE_BIN?.trim() || "/usr/local/bin/vibly-solo-node";
      const stagingPath = process.env.GCP_VIBLY_CHAIN_REMOTE_STAGING_PATH?.trim() || "/tmp/vibly-solo-node";
      const localBin = process.env.GCP_VIBLY_CHAIN_BINARY_PATH?.trim() || "./target/release/vibly-solo-node";
      const remoteDir = process.env.GCP_VIBLY_CHAIN_REMOTE_DIR?.trim() || "/opt/vibly/vibly-chain";
      if (mode === "remote-build") {
        return cloudVm(
          vm,
          zone,
          ["GCP_VIBLY_CHAIN_VM", "GCP_VIBLY_CHAIN_ZONE"],
          [
            `cd ${shellQuote(remoteDir)}`,
            "git fetch --all --tags",
            `git checkout ${shellQuote(git?.branch ?? "main")}`,
            "git pull --ff-only",
            "cargo build --release -p vibly-solo-node",
            `sudo install -m 755 target/release/vibly-solo-node ${shellQuote(remoteBin)}`,
            `sudo systemctl restart ${shellQuote(service)}`,
            `sudo systemctl --no-pager --full status ${shellQuote(service)} --lines=20`,
          ].join(" && "),
        );
      }
      if (!project || !vm || !zone) {
        return {
          source: "gcp",
          missingEnv: [
            project ? null : "GCP_PROJECT_ID",
            vm ? null : "GCP_VIBLY_CHAIN_VM",
            zone ? null : "GCP_VIBLY_CHAIN_ZONE or GCP_VM_ZONE",
          ].filter(Boolean) as string[],
        };
      }
      return {
        command: [
          `gcloud compute scp ${shellQuote(localBin)} ${shellQuote(`${vm}:${stagingPath}`)} --zone ${shellQuote(zone)} --project ${shellQuote(project)}`,
          `gcloud compute ssh ${shellQuote(vm)} --zone ${shellQuote(zone)} --project ${shellQuote(project)} --command ${shellQuote(
            [
              `sudo install -m 755 ${shellQuote(stagingPath)} ${shellQuote(remoteBin)}`,
              `rm -f ${shellQuote(stagingPath)}`,
              `sudo systemctl restart ${shellQuote(service)}`,
              `sudo systemctl --no-pager --full status ${shellQuote(service)} --lines=20`,
            ].join(" && "),
          )}`,
        ].join(" && "),
        source: "gcp",
        missingEnv: [],
      };
    }
    case "vibly-indexer": {
      const vm = process.env.GCP_VIBLY_INDEXER_VM?.trim();
      const zone = process.env.GCP_VIBLY_INDEXER_ZONE?.trim() || defaultVmZone;
      const remoteDir = process.env.GCP_VIBLY_INDEXER_REMOTE_DIR?.trim() || "/opt/vibly/vibly-indexer";
      const mode = process.env.GCP_VIBLY_INDEXER_DEPLOY_MODE?.trim() || "remote-build";
      const endpoint = process.env.GCP_VIBLY_INDEXER_ENDPOINT?.trim() || "ws://127.0.0.1:9944";
      const chainId = process.env.GCP_VIBLY_INDEXER_CHAIN_ID?.trim() || "substrate:vibly-solo";
      const startBlock = process.env.GCP_VIBLY_INDEXER_START_BLOCK?.trim() || "1";
      const composeEnv = `ENDPOINT=${shellQuote(endpoint)} CHAIN_ID=${shellQuote(chainId)} START_BLOCK=${shellQuote(startBlock)}`;
      const steps = [`cd ${shellQuote(remoteDir)}`];
      if (mode === "remote-build") {
        steps.push(
          "git fetch --all --tags",
          `git checkout ${shellQuote(git?.branch ?? "main")}`,
          "git pull --ff-only",
          "npm ci",
          "npm run build",
        );
      }
      steps.push(
        `${composeEnv} docker compose pull`,
        `${composeEnv} docker compose up -d --remove-orphans`,
        "docker compose ps",
      );
      return cloudVm(vm, zone, ["GCP_VIBLY_INDEXER_VM", "GCP_VIBLY_INDEXER_ZONE"], steps.join(" && "));
    }
    case "vibly-coordinator": {
      const service = process.env.GCP_VIBLY_COORDINATOR_SERVICE?.trim() || "vibly-coordinator";
      return cloudRun(service, "GCP_VIBLY_COORDINATOR_FLAGS");
    }
    case "vibly-console": {
      const service = process.env.GCP_VIBLY_CONSOLE_SERVICE?.trim() || "vibly-console";
      return cloudRun(service, "GCP_VIBLY_CONSOLE_FLAGS");
    }
    default:
      return undefined;
  }
}

function resolveNpmDeployCommand(projectId: string): Omit<DeployCommandResolution, "envVar"> | undefined {
  const access = process.env.NPM_PUBLISH_ACCESS?.trim() || "public";
  const tag = process.env.NPM_PUBLISH_TAG?.trim() || "latest";
  const otp = process.env.NPM_PUBLISH_OTP?.trim();
  const otpFlag = otp ? ` --otp ${shellQuote(otp)}` : "";

  switch (projectId) {
    case "concord":
      return {
        command: `pnpm -r --filter '@vibly-ai/concord-*' publish --access ${shellQuote(access)} --tag ${shellQuote(tag)} --no-git-checks${otpFlag}`,
        source: "npm",
        missingEnv: [],
      };
    case "vibly-client":
      return {
        command: `pnpm publish --access ${shellQuote(access)} --tag ${shellQuote(tag)} --no-git-checks${otpFlag}`,
        source: "npm",
        missingEnv: [],
      };
    case "vibly-coordinator-http-contract":
      return {
        command: `pnpm publish --access ${shellQuote(access)} --tag ${shellQuote(tag)} --no-git-checks${otpFlag}`,
        source: "npm",
        missingEnv: [],
      };
    default:
      return undefined;
  }
}

function requiredEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function envFlag(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return value === "1" || value === "true" || value === "yes";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function printProjectPlan(project: ProjectDefinition, deploy: DeployCommandResolution): void {
  const build = project.buildCommands.length > 0 ? project.buildCommands.join(" && ") : "(none)";
  console.log(`[deploy] build=${build}`);
  if (deploy.command) {
    console.log(`[deploy] deploy=${deploy.source ?? "custom"} ${deploy.command}`);
    return;
  }
  if (deploy.missingEnv.length > 0) {
    console.log(`[deploy] deploy=missing-env ${deploy.missingEnv.join(", ")}`);
    return;
  }
  console.log(`[deploy] deploy=not-configured set ${deploy.envVar}`);
}

function printProjectList(): void {
  console.log("[deploy] projects");
  for (const project of PROJECTS) {
    const build = project.buildCommands.length > 0 ? project.buildCommands.join(" && ") : "(none)";
    console.log(`[deploy] ${project.id} | ${project.label} | ${path.relative(REPO_ROOT, project.repoPath)} | build=${build}`);
  }
}

async function writeReport(results: ProjectExecutionResult[], options: Options): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(REPORT_DIR, `deploy-${timestamp}.json`);
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        options: {
          ...options,
          only: Array.from(options.only),
          skip: Array.from(options.skip),
        },
        results,
      },
      null,
      2,
    ),
  );
  return reportPath;
}

function printSummary(results: ProjectExecutionResult[], options: Options, reportPath: string): void {
  console.log("\n[deploy] summary");
  console.log(`[deploy] phase=${options.phase} profile=${options.profile} target=${options.target} dryRun=${options.dryRun} allowDirty=${options.allowDirty}`);
  for (const result of results) {
    const flags = [
      result.status,
      result.buildRan ? "built" : "not-built",
      result.deployRan ? "deployed" : "not-deployed",
      result.skipped ? `skipped:${result.skipReason}` : null,
      result.error ? `error:${result.error}` : null,
    ].filter(Boolean);
    console.log(`[deploy] ${result.id} ${result.branch}@${result.commit}${result.dirty ? " dirty" : ""} -> ${flags.join(", ")}`);
  }
  console.log(`[deploy] report=${reportPath}`);
}

function printHelpAndExit(): never {
  console.log(`Usage: pnpm deploy:all -- [options]

Options:
  --phase=plan|build|deploy|full   Execution phase (default: plan)
  --profile=custom|gcp|npm         Built-in deploy template profile (default: custom)
  --target=<name>                  Deployment target label (default: production)
  --only=a,b,c                     Only include these project ids
  --skip=a,b,c                     Skip these project ids
  --list                           List known project ids and build commands
  --allow-dirty                    Allow repositories with uncommitted changes
  --continue-on-error              Keep processing later projects after a failure
  --require-deploy-hook            Fail deploy/full phases when a selected project has no deploy hook
  --dry-run                        Print commands without executing them
  --help                           Show this help

Deploy hooks:
  Set VIBLY_DEPLOY_<PROJECT_ID>_CMD for any project that has a real deploy step.
  Example:
    VIBLY_DEPLOY_VIBLY_CONSOLE_CMD="gcloud run deploy vibly-console --source ."`);
  process.exit(0);
}

void main().catch((error) => {
  console.error(`[deploy] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
