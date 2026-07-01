import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type ExtensionAPI = any;
type ExtensionContext = any;

const TOOL_MAP: Record<string, string> = {
  glob: "find",
  webfetch: "ext:pi-web-access/fetch_content",
  mem_search: "ext:gentle-engram/mem_search",
  mem_get_observation: "ext:gentle-engram/mem_get_observation",
  mem_save: "ext:gentle-engram/mem_save",
  mem_update: "ext:gentle-engram/mem_update",
};

interface PatchStats {
  scanned: number;
  patched: number;
  errors: string[];
}

function agentHome(): string {
  return process.env.GENTLE_PI_AGENT_HOME ?? join(homedir(), ".pi", "agent");
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseCsv(value: string): string[] {
  return stripQuotes(value)
    .split(",")
    .map((item) => stripQuotes(item).trim())
    .filter(Boolean);
}

function mapTools(tools: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tool of tools) {
    const normalized = TOOL_MAP[tool] ?? tool;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function leadingSpaces(line: string): number {
  return line.length - line.trimStart().length;
}

function rewriteToolsInFrontmatter(frontmatter: string): { text: string; changed: boolean } {
  const lines = frontmatter.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(\s*)tools\s*:\s*(.*)$/.exec(lines[i]);
    if (!match) continue;

    const indent = match[1] ?? "";
    const baseIndent = leadingSpaces(lines[i]);
    const inlineValue = match[2] ?? "";
    let end = i + 1;
    let tools: string[] = [];

    if (inlineValue.trim().length > 0) {
      tools = parseCsv(inlineValue);
    } else {
      while (end < lines.length) {
        const line = lines[end];
        if (line.trim().length === 0) {
          end += 1;
          continue;
        }
        const item = /^\s*-\s*(.+?)\s*$/.exec(line);
        if (item && leadingSpaces(line) > baseIndent) {
          tools.push(stripQuotes(item[1] ?? ""));
          end += 1;
          continue;
        }
        break;
      }
    }

    const mapped = mapTools(tools);
    if (mapped.length === 0) return { text: frontmatter, changed: false };

    const replacement = `${indent}tools: ${mapped.join(", ")}`;
    const nextLines = [...lines.slice(0, i), replacement, ...lines.slice(end)];
    const next = nextLines.join("\n");
    return { text: next, changed: next !== frontmatter };
  }

  return { text: frontmatter, changed: false };
}

function rewriteAgentMarkdown(content: string): { text: string; changed: boolean } {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { text: content, changed: false };
  const closeIndex = normalized.indexOf("\n---\n", 4);
  if (closeIndex < 0) return { text: content, changed: false };

  const frontmatter = normalized.slice(4, closeIndex);
  const body = normalized.slice(closeIndex + "\n---\n".length);
  const rewritten = rewriteToolsInFrontmatter(frontmatter);
  if (!rewritten.changed) return { text: content, changed: false };
  return { text: `---\n${rewritten.text}\n---\n${body}`, changed: true };
}

function patchAgentTools(): PatchStats {
  const dir = join(agentHome(), "agents");
  const stats: PatchStats = { scanned: 0, patched: 0, errors: [] };
  if (!existsSync(dir)) return stats;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    stats.scanned += 1;
    const path = join(dir, entry.name);
    try {
      const before = readFileSync(path, "utf8");
      const after = rewriteAgentMarkdown(before);
      if (!after.changed) continue;
      writeFileSync(path, after.text, "utf8");
      stats.patched += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stats.errors.push(`${entry.name}: ${message}`);
    }
  }
  return stats;
}

function maybeNotify(ctx: ExtensionContext | undefined, stats: PatchStats, reason: string, noisy = false): void {
  if (!ctx?.hasUI) return;
  if (stats.errors.length > 0) {
    ctx.ui.notify(
      `sdd-tintinweb-fix failed during ${reason}: ${stats.errors.slice(0, 3).join("; ")}`,
      "warning",
    );
    return;
  }
  if (noisy || stats.patched > 0) {
    ctx.ui.notify(
      `sdd-tintinweb-fix ${reason}: patched ${stats.patched}/${stats.scanned} agent file(s).`,
      "info",
    );
  }
}

export default function (pi: ExtensionAPI) {
  const patch = (ctx?: ExtensionContext, reason = "patch", noisy = false) => {
    const stats = patchAgentTools();
    maybeNotify(ctx, stats, reason, noisy);
    return stats;
  };

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    patch(ctx, "session_start");
  });

  pi.on("tool_call", async (_event: unknown, ctx: ExtensionContext) => {
    patch(ctx, "tool_call");
    return undefined;
  });

  pi.on("before_agent_start", async (_event: unknown, ctx: ExtensionContext) => {
    patch(ctx, "before_agent_start");
    return undefined;
  });

  pi.registerCommand("gentle-ai:fix-tintinweb-tools", {
    description: "Rewrite agent tools frontmatter for @tintinweb/pi-subagents compatibility.",
    handler: async (_args: string, ctx: ExtensionContext) => {
      patch(ctx, "manual", true);
    },
  });
}
