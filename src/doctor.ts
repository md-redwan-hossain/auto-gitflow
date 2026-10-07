import * as p from "@clack/prompts";
import { tryLoadConfig } from "./load-config.ts";

export function runDoctor(configPath?: string): void {
  p.intro("gitrung doctor");

  const result = tryLoadConfig(configPath);

  p.log.info(`Config: ${result.path}`);

  for (const w of result.warnings) {
    p.log.warn(w);
  }

  if (!result.ok) {
    for (const err of result.errors) {
      p.log.error(err);
    }
    p.outro("Config has problems.");
    process.exit(1);
  }

  const { config } = result;
  p.log.success(
    `OK — ${config.length} repo(s), ${config.reduce((n, r) => n + r.steps.length, 0)} step(s)`,
  );
  for (const repo of config) {
    p.log.info(`  ${repo.label}: ${repo.steps.length} step(s)`);
  }
  p.outro("Healthy.");
  process.exit(0);
}
