#!/usr/bin/env node
/**
 * Lightweight pre-push secret scan.
 *
 * Uses gitleaks if installed; otherwise falls back to deterministic
 * regex checks over tracked/untracked files in the repo.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT_DIR = process.cwd();

const FALLBACK_PATTERNS = [
  {
    id: "openai_api_key",
    label: "OpenAI API key",
    regex: /\bsk-(?:proj-|org-)?[A-Za-z0-9_-]{24,}\b/g,
  },
  { id: "aws_access_key_id", label: "AWS Access Key", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: "aws_secret_key", label: "AWS Secret", regex: /\bASIA[0-9A-Z]{16}\b/g },
  { id: "github_pat", label: "GitHub token", regex: /\bgh[pousr]_[A-Za-z0-9]{35,}\b/g },
  { id: "google_api_key", label: "Google API key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: "private_key", label: "Private key block", regex: /-----BEGIN\s+[A-Z ]+PRIVATE KEY-----/g },
  {
    id: "secret_env_assignment",
    label: "Secret-like env assignment",
    regex: /^\s*[A-Z0-9_]+(?:_KEY|_TOKEN|_SECRET|_PASS(?:WORD)?)\s*=\s*["']?[^"'\\s#]+["']?\s*$/gim,
  },
];

const SAFE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".zip",
  ".tar",
  ".gz",
  ".pdf",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".exe",
  ".dll",
  ".so",
  ".jar",
]);

const SKIP_PATH_PREFIXES = new Set([
  "node_modules/",
  "dist/",
  ".git/",
  "tmp/",
  ".agentloops/",
  "coverage/",
  ".githooks/",
]);

function execGit(args) {
  const full = ["git", ...args].join(" ");
  return execSync(full, {
    cwd: ROOT_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  }).trim();
}

function commandExists(command) {
  try {
    if (process.platform === "win32") {
      execSync(`where ${command}`, { stdio: "ignore" });
    } else {
      execSync(`command -v ${command}`, { stdio: "ignore", shell: "/bin/bash" });
    }
    return true;
  } catch {
    return false;
  }
}

function looksBinary(fileContent) {
  return fileContent.includes("\u0000");
}

function sha1(data) {
  return createHash("sha1").update(data).digest("hex").slice(0, 8);
}

function collectRepoFiles() {
  const tracked = execGit(["ls-files"]);
  const untracked = execGit(["ls-files", "-o", "--exclude-standard"]);
  const files = new Set([
    ...tracked.split("\n").map((line) => line.trim()).filter(Boolean),
    ...untracked.split("\n").map((line) => line.trim()).filter(Boolean),
  ]);
  return [...files].filter((file) => {
    if (file === "") return false;
    for (const prefix of SKIP_PATH_PREFIXES) {
      if (file.startsWith(prefix)) return false;
    }
    const extension = path.extname(file).toLowerCase();
    if (SAFE_EXTENSIONS.has(extension)) return false;
    return true;
  });
}

function runGitleaksScan() {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "agentloop-gitleaks-"));
  const reportPath = path.join(tmpDir, "gitleaks-report.json");

  try {
    const result = execSync(
      `gitleaks detect --no-git --redact --source ${JSON.stringify(ROOT_DIR)} --report-format json --report-path ${JSON.stringify(
        reportPath,
      )}`,
      {
        cwd: ROOT_DIR,
        encoding: "utf8",
        stdio: "pipe",
        shell: "/bin/bash",
      },
    );
    void result;
  } catch {
    // gitleaks exits non-zero when findings are found.
  }

  if (!existsSync(reportPath)) {
    rmSync(tmpDir, { recursive: true, force: true });
    return [];
  }

  const output = readFileSync(reportPath, "utf8");
  rmSync(tmpDir, { recursive: true, force: true });

  if (!output.trim()) {
    return [];
  }

  const parsed = JSON.parse(output);
  const findings = Array.isArray(parsed) ? parsed : parsed.Findings || [];
  return findings.map((finding) => ({
    file: finding.File || finding.FilePath || "<unknown>",
    line: finding.StartLine || finding.Line || 0,
    match: finding.Secret || finding.Match || "",
    rule: finding.RuleID || "gitleaks",
    source: "gitleaks",
  }));
}

function runFallbackScan() {
  const results = [];
  const files = collectRepoFiles();

  for (const file of files) {
    let content;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }

    if (looksBinary(content)) continue;

    // Skip obvious placeholders in env-like files to reduce false positives.
    const isPlaceholderLine = (line, rule) =>
      rule.id === "secret_env_assignment" &&
      /(example|placeholder|your_|changeme|replace_|insert_here|xxx+|^\$\{|<|>)/i.test(line);

    const lines = content.split(/\r?\n/);
    for (const rule of FALLBACK_PATTERNS) {
      for (const [lineNumber, line] of lines.entries()) {
        rule.regex.lastIndex = 0;
        if (rule.id === "secret_env_assignment") {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          if (trimmed.length > 200) continue;
          if (!isPlaceholderLine(trimmed, rule) && trimmed.match(rule.regex)) {
            results.push({
              file,
              line: lineNumber + 1,
              match: trimmed,
              rule: rule.id,
              source: "fallback",
            });
          }
          continue;
        }

        let match;
        while ((match = rule.regex.exec(line)) !== null) {
          const candidate = match[0];
          if (!candidate) continue;
          if (isPlaceholderLine(candidate, rule)) continue;
          results.push({
            file,
            line: lineNumber + 1,
            match: candidate,
            rule: rule.id,
            source: "fallback",
          });
        }
      }
    }
  }

  // Coalesce obvious duplicates.
  const unique = new Map();
  for (const result of results) {
    const key = `${result.file}:${result.line}:${result.match}`;
    if (!unique.has(key)) {
      unique.set(key, result);
    }
  }
  return [...unique.values()];
}

function isLikelyRealSecret(result) {
  const value = result.match || "";
  if (result.rule === "secret_env_assignment") {
    const token = value.replace(/^\s*[A-Za-z0-9_]+(?:_KEY|_TOKEN|_SECRET|_PASS(?:WORD)?)\s*=\s*/i, "");
    return token.length >= 20 && !/^\$?\{?[\w.-]+\}?$/.test(token);
  }
  return true;
}

function main() {
  let findings = [];

  if (commandExists("gitleaks")) {
    findings = runGitleaksScan();
  } else {
    findings = runFallbackScan();
  }

  const actionableFindings = findings.filter(isLikelyRealSecret);
  if (actionableFindings.length === 0) {
    console.log("Secret scan passed (no findings).");
    return;
  }

  console.error("\nPotential secret detected. Push blocked.");
  for (const finding of actionableFindings) {
    const lineSuffix =
      finding.line && finding.line > 0 ? `:${finding.line}` : "";
    const snippet = finding.match ? ` :: ${finding.match}` : "";
    console.error(`- [${finding.source}] ${finding.rule}: ${finding.file}${lineSuffix}${snippet}`);
  }
  console.error(
    "\nTo silence suspected placeholders, rotate any real credentials and replace with placeholders before committing.",
  );
  if (actionableFindings[0]?.match) {
    console.error(`Result hash: ${sha1(actionableFindings[0].match)}`);
  }
  process.exit(1);
}

main();
