import * as p from "@clack/prompts";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ZodError } from "zod";
import {
  AppConfigSchema,
  formatZodError,
  type AppConfig,
  type GitPlatform,
} from "./schema.ts";

const ROOT = resolve(import.meta.dir, "..");

export function projectRoot(): string {
  return ROOT;
}

export function defaultConfigPath(): string {
  return resolve(ROOT, "config.jsonc");
}

export type LoadConfigResult =
  | { ok: true; config: AppConfig; path: string; warnings: string[] }
  | { ok: false; path: string; errors: string[]; warnings: string[] };

export function tryLoadConfig(configPath?: string): LoadConfigResult {
  const path = configPath ? resolve(configPath) : defaultConfigPath();
  const warnings: string[] = [];

  if (!existsSync(path)) {
    return {
      ok: false,
      path,
      errors: [
        `Config not found: ${path}`,
        `Copy config.jsonc.example to config.jsonc and edit it.`,
      ],
      warnings,
    };
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      path,
      errors: [`Failed to read config: ${message}`],
      warnings,
    };
  }

  if (raw.trim().length === 0) {
    return {
      ok: false,
      path,
      errors: [
        `Config is empty: ${path}`,
        `Copy config.jsonc.example to config.jsonc and edit it.`,
      ],
      warnings,
    };
  }

  let data: unknown;
  try {
    data = Bun.JSONC.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      path,
      errors: [`Failed to parse JSONC: ${message}`],
      warnings,
    };
  }

  if (data === null || data === undefined) {
    return {
      ok: false,
      path,
      errors: [
        `Config is empty: ${path}`,
        `Copy config.jsonc.example to config.jsonc and edit it.`,
      ],
      warnings,
    };
  }

  if (!Array.isArray(data) || data.length === 0) {
    return {
      ok: false,
      path,
      errors: [
        `Config has no usable repos: ${path}`,
        `Root must be a non-empty array of repo objects. Copy config.jsonc.example to config.jsonc and edit it.`,
      ],
      warnings,
    };
  }

  collectSoftWarnings(data, warnings);

  try {
    const config = AppConfigSchema.parse(data);
    return { ok: true, config, path, warnings };
  } catch (err) {
    if (err instanceof ZodError) {
      return {
        ok: false,
        path,
        errors: [`Invalid config:\n${formatZodError(err)}`],
        warnings,
      };
    }
    throw err;
  }
}

export function loadConfig(configPath?: string): AppConfig {
  const result = tryLoadConfig(configPath);
  if (!result.ok) {
    for (const err of result.errors) {
      p.log.warn(err);
    }
    for (const w of result.warnings) {
      p.log.warn(w);
    }
    process.exit(1);
  }
  for (const w of result.warnings) {
    p.log.warn(w);
  }
  return result.config;
}

export function loadToken(gitPlatform: GitPlatform): string {
  if (gitPlatform === "github") {
    const token = process.env.GITHUB_TOKEN?.trim();
    if (!token) {
      throw new Error(
        "GITHUB_TOKEN is missing. Copy .env.example to .env and set your GitHub token (repo + workflow scopes).",
      );
    }
    return token;
  }

  const token = process.env.GITEA_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "GITEA_TOKEN is missing. Copy .env.example to .env and set your token.",
    );
  }
  return token;
}

function collectSoftWarnings(repos: unknown[], warnings: string[]): void {
  const labels = new Map<string, number>();
  for (const [repoIndex, repo] of repos.entries()) {
    if (!repo || typeof repo !== "object" || Array.isArray(repo)) continue;
    const r = repo as Record<string, unknown>;
    const label = typeof r.label === "string" ? r.label : `[${repoIndex}]`;

    if (typeof r.label === "string") {
      const prev = labels.get(r.label);
      if (prev !== undefined) {
        warnings.push(
          `Duplicate repo label "${r.label}" at [${prev}] and [${repoIndex}]`,
        );
      } else {
        labels.set(r.label, repoIndex);
      }
    }

    const steps = r.steps;
    if (!Array.isArray(steps)) continue;
    for (const [stepIndex, step] of steps.entries()) {
      if (!step || typeof step !== "object" || Array.isArray(step)) continue;
      const s = step as Record<string, unknown>;
      if ("interactive" in s) {
        warnings.push(
          `${label} steps[${stepIndex}]: stale key "interactive" (remove it; inputs prompt when workflow_dispatch.inputs exist)`,
        );
      }
    }
  }
}
