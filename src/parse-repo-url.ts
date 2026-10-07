import type { ParsedRepo } from "./schema.ts";

export function parseRepoUrl(url: string): ParsedRepo {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid repo URL: ${url}`);
  }

  const parts = parsed.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error(
      `Repo URL must look like https://host/owner/repo, got: ${url}`,
    );
  }

  const owner = parts[0]!;
  const repo = parts[1]!.replace(/\.git$/, "");

  return {
    apiBase: `${parsed.origin}/api/v1`,
    owner,
    repo,
    url: `${parsed.origin}/${owner}/${repo}`,
  };
}
