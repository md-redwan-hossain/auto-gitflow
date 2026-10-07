import * as p from "@clack/prompts";
import chalk from "chalk";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const RELEASE_BASE =
  "https://github.com/md-redwan-hossain/gitrung/releases/tag/latest/download";

type PlatformAsset = {
  binary: string;
  checksum: string;
};

function resolvePlatformAsset(): PlatformAsset {
  if (process.platform === "win32" && process.arch === "x64") {
    return {
      binary: "gitrung-windows-x64.exe",
      checksum: "gitrung-windows-x64.exe.sha256",
    };
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return {
      binary: "gitrung-linux-x64",
      checksum: "gitrung-linux-x64.sha256",
    };
  }
  if (process.platform === "darwin" && process.arch === "arm64") {
    return {
      binary: "gitrung-darwin-arm64",
      checksum: "gitrung-darwin-arm64.sha256",
    };
  }
  if (process.platform === "darwin" && process.arch === "x64") {
    return {
      binary: "gitrung-darwin-x64",
      checksum: "gitrung-darwin-x64.sha256",
    };
  }
  throw new Error(
    `Unsupported platform: ${process.platform}/${process.arch}.`,
  );
}

function isBunRuntime(): boolean {
  const executable = basename(process.execPath).toLowerCase();
  return executable === "bun" || executable === "bun.exe";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;

  const units = ["KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = -1;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function renderDownloadProgress(
  downloaded: number,
  total: number | undefined,
): void {
  const downloadedText = formatBytes(downloaded);
  if (total === undefined) {
    process.stdout.write(
      `\r${chalk.yellow(`${downloadedText} downloaded`)}\x1b[K`,
    );
    return;
  }

  const percentage = Math.min(100, Math.round((downloaded / total) * 100));
  process.stdout.write(
    `\r${chalk.green(`${percentage}%`)} ${chalk.yellow(
      `${downloadedText} / ${formatBytes(total)}`,
    )}\x1b[K`,
  );
}

async function download(
  url: string,
  options: { showProgress?: boolean } = {},
): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed (${response.status} ${response.statusText})`);
  }

  if (!response.body) {
    throw new Error("Download failed: response body is unavailable.");
  }

  const totalHeader = response.headers.get("content-length");
  const parsedTotal = totalHeader ? Number.parseInt(totalHeader, 10) : NaN;
  const total =
    Number.isFinite(parsedTotal) && parsedTotal >= 0 ? parsedTotal : undefined;
  const showProgress =
    options.showProgress === true && process.stdout.isTTY === true;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let downloaded = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      chunks.push(value);
      downloaded += value.byteLength;
      if (showProgress) renderDownloadProgress(downloaded, total);
    }
  } finally {
    reader.releaseLock();
    if (showProgress) process.stdout.write("\n");
  }

  const result = new Uint8Array(downloaded);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function parseChecksum(data: Uint8Array, expectedAsset: string): string {
  const text = new TextDecoder().decode(data).trim();
  const match = text.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
  if (!match || basename(match[2]!.trim()) !== expectedAsset) {
    throw new Error(`Checksum file is malformed for ${expectedAsset}.`);
  }
  return match[1]!.toLowerCase();
}

function currentExecutable(): string {
  if (isBunRuntime()) {
    throw new Error(
      "Self-update is available only for a compiled gitrung binary, not bun src/index.ts.",
    );
  }
  const executable = resolve(process.execPath);
  if (!existsSync(executable)) {
    throw new Error(`Current executable was not found: ${executable}`);
  }
  return executable;
}

function launchWindowsReplacement(
  executable: string,
  replacement: string,
): void {
  const helper = join(tmpdir(), `gitrung-upgrade-${Date.now()}.cmd`);
  const script = [
    "@echo off",
    `:wait`,
    `tasklist /FI "PID eq ${process.pid}" | find "${process.pid}" >nul`,
    "if not errorlevel 1 (timeout /t 1 /nobreak >nul & goto wait)",
    `copy /Y "${replacement}" "${executable}" >nul`,
    `del /Q "${replacement}"`,
    `del /Q "%~f0"`,
  ].join("\r\n");
  writeFileSync(helper, script);
  const child = Bun.spawn(["cmd.exe", "/d", "/c", helper], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  child.unref();
}

async function replaceExecutable(
  executable: string,
  replacementBytes: Uint8Array,
): Promise<void> {
  const replacement = join(
    dirname(executable),
    `.${basename(executable)}.upgrade-${Date.now()}`,
  );
  writeFileSync(replacement, replacementBytes);
  if (process.platform === "win32") {
    launchWindowsReplacement(executable, replacement);
    return;
  }
  chmodSync(replacement, 0o755);
  copyFileSync(replacement, executable);
  unlinkSync(replacement);
}

export async function runUpgrade(): Promise<void> {
  p.intro("gitrung upgrade");

  try {
    const asset = resolvePlatformAsset();
    const executable = currentExecutable();
    const checksumBytes = await download(
      `${RELEASE_BASE}/${encodeURIComponent(asset.checksum)}`,
    );
    const expectedHash = parseChecksum(checksumBytes, asset.binary);
    const currentHash = sha256(new Uint8Array(readFileSync(executable)));

    if (currentHash === expectedHash) {
      p.log.success("Already up to date.");
      return;
    }

    const choice = await p.select({
      message: "A new gitrung binary is available. Update now?",
      options: [
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" },
      ],
    });
    if (p.isCancel(choice) || choice === "no") {
      p.outro("Update skipped.");
      return;
    }

    const replacementBytes = await download(
      `${RELEASE_BASE}/${encodeURIComponent(asset.binary)}`,
      { showProgress: true },
    );
    if (sha256(replacementBytes) !== expectedHash) {
      throw new Error("Downloaded binary failed checksum verification.");
    }
    await replaceExecutable(executable, replacementBytes);
    p.outro(
      process.platform === "win32"
        ? "Update scheduled. The new binary will be installed after exit."
        : "Updated successfully.",
    );
  } catch (err) {
    p.log.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
