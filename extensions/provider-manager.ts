import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ============================================================================
// Types
// ============================================================================

interface ModelConfig {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  compat?: {
    supportsDeveloperRole?: boolean;
    supportsReasoningEffort?: boolean;
  };
}

type ProviderApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";

interface Provider {
  baseUrl: string;
  api: ProviderApi;
  apiKey: string;
  models: ModelConfig[];
  compat?: {
    supportsDeveloperRole?: boolean;
    supportsReasoningEffort?: boolean;
  };
}

interface ModelsConfig {
  providers: Record<string, Provider>;
}

// ============================================================================
// Constants
// ============================================================================

const CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "models.json");
const BACKUP_DIR = path.join(os.homedir(), ".pi", "agent", "backups");
const MAX_BACKUPS = 10;

function resolveBackupFilePath(input: string): string {
  const backupRoot = path.resolve(BACKUP_DIR);
  const resolvedPath = path.resolve(backupRoot, input);
  const relativePath = path.relative(backupRoot, resolvedPath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("Path must stay within ~/.pi/agent/backups");
  }

  return resolvedPath;
}

const KEY_METHOD_ENV = "Environment Variable (Recommended)";
const KEY_METHOD_DIRECT = "Direct Input";
const OPENAI_COMPATIBLE_APIS = new Set<ProviderApi>([
  "openai-completions",
  "openai-responses",
]);
const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

function isOpenAICompatibleApi(api: string): boolean {
  return OPENAI_COMPATIBLE_APIS.has(api as ProviderApi);
}

function parseConfigEnvVarNames(config: string): string[] {
  const names: string[] = [];
  let index = 0;

  while (index < config.length) {
    const dollarIndex = config.indexOf("$", index);
    if (dollarIndex < 0) {
      break;
    }

    const nextChar = config[dollarIndex + 1];
    if (nextChar === "$" || nextChar === "!") {
      index = dollarIndex + 2;
      continue;
    }

    if (nextChar === "{") {
      const endIndex = config.indexOf("}", dollarIndex + 2);
      if (endIndex < 0) {
        index = dollarIndex + 1;
        continue;
      }

      const name = config.slice(dollarIndex + 2, endIndex);
      if (ENV_VAR_NAME_RE.test(name) && !names.includes(name)) {
        names.push(name);
      }
      index = endIndex + 1;
      continue;
    }

    const match = config.slice(dollarIndex + 1).match(ENV_VAR_NAME_PREFIX_RE);
    if (match) {
      const name = match[0];
      if (!names.includes(name)) {
        names.push(name);
      }
      index = dollarIndex + 1 + name.length;
      continue;
    }

    index = dollarIndex + 1;
  }

  return names;
}

function resolveConfigValue(config: string): { value?: string; missingEnvVars: string[]; error?: string } {
  if (config.startsWith("!")) {
    try {
      const value = execSync(config.slice(1), {
        encoding: "utf-8",
        timeout: 10000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return { value: value || undefined, missingEnvVars: [] };
    } catch (error: any) {
      return { missingEnvVars: [], error: error.message || "Command failed" };
    }
  }

  let value = "";
  const missingEnvVars: string[] = [];
  let index = 0;

  while (index < config.length) {
    const dollarIndex = config.indexOf("$", index);
    if (dollarIndex < 0) {
      value += config.slice(index);
      break;
    }

    value += config.slice(index, dollarIndex);
    const nextChar = config[dollarIndex + 1];

    if (nextChar === "$" || nextChar === "!") {
      value += nextChar;
      index = dollarIndex + 2;
      continue;
    }

    if (nextChar === "{") {
      const endIndex = config.indexOf("}", dollarIndex + 2);
      if (endIndex < 0) {
        value += "$";
        index = dollarIndex + 1;
        continue;
      }

      const name = config.slice(dollarIndex + 2, endIndex);
      if (ENV_VAR_NAME_RE.test(name)) {
        const envValue = process.env[name];
        if (envValue === undefined) {
          missingEnvVars.push(name);
        } else {
          value += envValue;
        }
      } else {
        value += config.slice(dollarIndex, endIndex + 1);
      }
      index = endIndex + 1;
      continue;
    }

    const match = config.slice(dollarIndex + 1).match(ENV_VAR_NAME_PREFIX_RE);
    if (match) {
      const name = match[0];
      const envValue = process.env[name];
      if (envValue === undefined) {
        missingEnvVars.push(name);
      } else {
        value += envValue;
      }
      index = dollarIndex + 1 + name.length;
      continue;
    }

    value += "$";
    index = dollarIndex + 1;
  }

  return {
    value: missingEnvVars.length === 0 ? value : undefined,
    missingEnvVars: [...new Set(missingEnvVars)],
  };
}

function formatApiKeyStatus(apiKey: string): string {
  const envVars = parseConfigEnvVarNames(apiKey);
  if (envVars.length > 0) {
    return `${apiKey} (env)`;
  }
  if (apiKey.startsWith("!")) {
    return "!command";
  }
  return "***";
}

function providerEndpoint(baseUrl: string, endpoint: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${endpoint.replace(/^\/+/, "")}`;
}

function previewText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 160);
}

async function readJsonResponse(response: Response, url: string): Promise<any> {
  const text = await response.text();
  const contentType = response.headers.get("content-type") || "";

  if (!response.ok) {
    const preview = previewText(text);
    throw new Error(
      `HTTP ${response.status} from ${url}` +
      (preview ? `: ${preview}` : "")
    );
  }

  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error(`Empty response from ${url}`);
  }

  if (trimmed.startsWith("<") || contentType.toLowerCase().includes("text/html")) {
    throw new Error(
      `Expected JSON from ${url}, but received HTML. ` +
      `Check the provider base URL; it should point to an API root such as https://host/v1. ` +
      `Response starts with: ${previewText(trimmed)}`
    );
  }

  try {
    return JSON.parse(trimmed);
  } catch (error: any) {
    throw new Error(
      `Invalid JSON from ${url}` +
      (contentType ? ` (content-type: ${contentType})` : "") +
      `: ${error.message}`
    );
  }
}

async function fetchProviderModels(provider: Provider): Promise<any[]> {
  const apiKeyResult = resolveConfigValue(provider.apiKey);
  if (!apiKeyResult.value) {
    const detail = apiKeyResult.missingEnvVars.length > 0
      ? `Environment variable ${apiKeyResult.missingEnvVars.join(", ")} is not set`
      : `Failed to resolve API key${apiKeyResult.error ? `: ${apiKeyResult.error}` : ""}`;
    throw new Error(detail);
  }

  const url = providerEndpoint(provider.baseUrl, "models");
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKeyResult.value}` },
    signal: AbortSignal.timeout(10000),
  });
  const data = await readJsonResponse(response, url);
  const models = data.data || [];

  if (!Array.isArray(models)) {
    throw new Error(`Invalid /models response from ${url}: expected data array`);
  }

  return models;
}

// ============================================================================
// Configuration Management
// ============================================================================

function backupConfig(): void {
  if (!fs.existsSync(CONFIG_PATH)) {
    return;
  }

  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "-")
    .slice(0, 19);
  const backupPath = path.join(BACKUP_DIR, `models.json.backup.${timestamp}`);

  fs.copyFileSync(CONFIG_PATH, backupPath);

  const backups = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith("models.json.backup."))
    .sort()
    .reverse();

  for (let i = MAX_BACKUPS; i < backups.length; i++) {
    fs.unlinkSync(path.join(BACKUP_DIR, backups[i]));
  }
}

function loadConfig(): ModelsConfig | null {
  if (!fs.existsSync(CONFIG_PATH)) {
    return { providers: {} };
  }
  try {
    const content = fs.readFileSync(CONFIG_PATH, "utf-8");
    const config = JSON.parse(content);
    return config;
  } catch (error) {
    return null;
  }
}

function saveConfig(config: ModelsConfig): boolean {
  try {
    backupConfig();

    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
    return true;
  } catch (error) {
    return false;
  }
}

function loadConfigOrNotify(ctx: any): ModelsConfig | null {
  const config = loadConfig();
  if (config === null) {
    ctx.ui.notify("Failed to load models.json", "error");
    return null;
  }
  return config;
}

function providerNames(config: ModelsConfig): string[] {
  return Object.keys(config.providers);
}

async function selectProviderName(
  ctx: any,
  config: ModelsConfig,
  prompt: string,
  emptyMessage = "No providers configured",
  emptySeverity: "info" | "error" = "info"
): Promise<string | null> {
  const providers = providerNames(config);
  if (providers.length === 0) {
    ctx.ui.notify(emptyMessage, emptySeverity);
    return null;
  }

  const providerName = await ctx.ui.select(prompt, providers);
  if (!providerName) {
    ctx.ui.notify("Cancelled", "info");
    return null;
  }

  return providerName;
}

async function selectProvider(
  ctx: any,
  config: ModelsConfig,
  prompt: string,
  emptyMessage = "No providers configured",
  emptySeverity: "info" | "error" = "info"
): Promise<{ name: string; provider: Provider } | null> {
  const name = await selectProviderName(ctx, config, prompt, emptyMessage, emptySeverity);
  return name ? { name, provider: config.providers[name] } : null;
}

async function selectModelId(
  ctx: any,
  provider: Provider,
  providerName: string,
  prompt: string
): Promise<string | null> {
  if (provider.models.length === 0) {
    ctx.ui.notify(`No models in provider "${providerName}"`, "info");
    return null;
  }

  const modelId = await ctx.ui.select(prompt, provider.models.map((m) => m.id));
  if (!modelId) {
    ctx.ui.notify("Cancelled", "info");
    return null;
  }

  return modelId;
}

function cloneModelConfig(sourceModel: ModelConfig, newModelId: string): ModelConfig {
  return {
    ...sourceModel,
    id: newModelId,
    name: newModelId,
  };
}

function formatModelLine(model: ModelConfig, indent = "", includeCompat = true): string {
  let output = `${indent}• ${model.id}`;
  if (model.name && model.name !== model.id) {
    output += ` (${model.name})`;
  }
  if (model.reasoning) {
    output += " [reasoning]";
  }
  if (includeCompat && model.compat) {
    output += " [compat]";
  }
  return output;
}

function notifySaveResult(ctx: any, config: ModelsConfig, successMessage: string): void {
  if (saveConfig(config)) {
    ctx.ui.notify(successMessage, "success");
  } else {
    ctx.ui.notify("Failed to save configuration", "error");
  }
}

function fetchErrorMessage(error: any): string {
  return error?.message || String(error);
}

function notifyModelFetchError(ctx: any, error: any, timeoutMessage = "Request timeout"): void {
  if (error?.name === "AbortError") {
    ctx.ui.notify(timeoutMessage, "error");
  } else {
    ctx.ui.notify(`Failed to fetch models: ${fetchErrorMessage(error)}`, "error");
  }
}

// ============================================================================
// Provider Testing
// ============================================================================

async function testProviderConnection(
  baseUrl: string,
  apiKey: string,
  api: string
): Promise<{ success: boolean; message: string; details?: string }> {
  try {
    const url = new URL(baseUrl);
    let testResults: string[] = [];

    if (isOpenAICompatibleApi(api)) {
      // Test /models endpoint
      try {
        const modelsResponse = await fetch(providerEndpoint(baseUrl, "models"), {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(5000),
        });

        if (modelsResponse.ok) {
          testResults.push("✓ /models endpoint: OK");
        } else if (modelsResponse.status === 401 || modelsResponse.status === 403) {
          return {
            success: false,
            message: "Authentication failed",
            details: `HTTP ${modelsResponse.status}: Check your API key`,
          };
        } else if (modelsResponse.status === 404) {
          testResults.push("✗ /models endpoint: Not found (might not be supported)");
        } else {
          testResults.push(`⚠ /models endpoint: HTTP ${modelsResponse.status}`);
        }
      } catch (error: any) {
        if (error.name === "AbortError") {
          return {
            success: false,
            message: "Connection timeout",
            details: "Server did not respond within 5 seconds",
          };
        }
        return {
          success: false,
          message: "Network error",
          details: error.message || "Cannot reach server",
        };
      }

      // Test /chat/completions endpoint
      try {
        const chatResponse = await fetch(providerEndpoint(baseUrl, "chat/completions"), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "test",
            messages: [{ role: "user", content: "test" }],
            max_tokens: 1,
          }),
          signal: AbortSignal.timeout(5000),
        });

        if (chatResponse.ok) {
          testResults.push("✓ /chat/completions: OK");
        } else if (chatResponse.status === 404) {
          testResults.push("✓ /chat/completions: Endpoint available (test model not found)");
        } else if (chatResponse.status === 401 || chatResponse.status === 403) {
          return {
            success: false,
            message: "Authentication failed on chat endpoint",
            details: `HTTP ${chatResponse.status}: Check your API key`,
          };
        } else {
          testResults.push(`⚠ /chat/completions: HTTP ${chatResponse.status}`);
        }
      } catch (error: any) {
        if (error.name === "AbortError") {
          testResults.push("⚠ /chat/completions: Timeout");
        } else {
          testResults.push("⚠ /chat/completions: Error");
        }
      }

      const hasModels = testResults.some((r) => r.includes("✓ /models"));
      const hasChat = testResults.some((r) => r.includes("✓ /chat/completions"));

      if (hasModels && hasChat) {
        return { success: true, message: "All tests passed", details: testResults.join("\n") };
      } else if (hasModels || hasChat) {
        return { success: true, message: "Partially working", details: testResults.join("\n") };
      } else {
        return { success: false, message: "Connection issues", details: testResults.join("\n") };
      }
    }

    return { success: true, message: `URL valid: ${url.origin}` };
  } catch (error: any) {
    return { success: false, message: error.message || "Connection failed" };
  }
}

// ============================================================================
// Model Info Fetching (OpenRouter)
// ============================================================================

interface ModelInfo {
  contextWindow?: number;
  maxTokens?: number;
}

function applyModelInfo(modelConfig: ModelConfig, modelInfo: ModelInfo | null): void {
  if (!modelInfo) return;
  if (modelInfo.contextWindow) {
    modelConfig.contextWindow = modelInfo.contextWindow;
  }
  if (modelInfo.maxTokens) {
    modelConfig.maxTokens = modelInfo.maxTokens;
  }
}

function createModelConfig(modelId: string, name = modelId, modelInfo: ModelInfo | null = null): ModelConfig {
  const modelConfig: ModelConfig = { id: modelId, name };
  applyModelInfo(modelConfig, modelInfo);
  return modelConfig;
}

async function promptOptionalNumber(ctx: any, prompt: string, defaultValue = ""): Promise<number | undefined> {
  const input = await ctx.ui.input(prompt, defaultValue);
  if (!input) return undefined;
  const value = parseInt(input, 10);
  return isNaN(value) ? undefined : value;
}

async function promptCompatibility(ctx: any): Promise<ModelConfig["compat"]> {
  const supportsDeveloperRole = await ctx.ui.confirm(
    "Does it support developer role?",
    "Developer role"
  );
  const supportsReasoningEffort = await ctx.ui.confirm(
    "Does it support reasoning_effort parameter?",
    "Reasoning effort"
  );
  return { supportsDeveloperRole, supportsReasoningEffort };
}

async function fetchModelInfoFromOpenRouter(modelId: string): Promise<ModelInfo | null> {
  try {
    const response = await fetch("https://openrouter.ai/api/v1/models", {
      signal: AbortSignal.timeout(3000),
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    const models = data.data || [];

    // Try exact match first
    let model = models.find((m: any) => m.id === modelId);

    // Try fuzzy match if exact match fails
    if (!model) {
      const normalizedId = modelId.toLowerCase().replace(/[:\-_]/g, "");
      model = models.find((m: any) => {
        const normalizedModelId = m.id.toLowerCase().replace(/[:\-_]/g, "");
        return (
          normalizedModelId.includes(normalizedId) ||
          normalizedId.includes(normalizedModelId)
        );
      });
    }

    if (model) {
      return {
        contextWindow: model.context_length,
        maxTokens: model.top_provider?.max_completion_tokens ||
                   model.max_completion_tokens ||
                   4096,
      };
    }

    return null;
  } catch (error) {
    // Silently fail - network issues shouldn't block the user
    return null;
  }
}

// __CONTINUE_HERE__

// ============================================================================
// Provider Command Handlers
// ============================================================================

async function handleProviderAdd(ctx: any): Promise<void> {
  const name = await ctx.ui.input("Provider name:", "");
  if (!name) {
    ctx.ui.notify("Provider name is required", "error");
    return;
  }

  const baseUrl = await ctx.ui.input("Base URL:", "http://localhost:11434/v1");
  if (!baseUrl) {
    ctx.ui.notify("Base URL is required", "error");
    return;
  }

  const api = await ctx.ui.select("API type:", [
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
  ]);

  if (!api) {
    ctx.ui.notify("Cancelled", "info");
    return;
  }

  const keyMethod = await ctx.ui.select("API Key method:", [
    KEY_METHOD_ENV,
    KEY_METHOD_DIRECT,
  ]);

  if (!keyMethod) {
    ctx.ui.notify("Cancelled", "info");
    return;
  }

  let apiKey: string;
  if (keyMethod === KEY_METHOD_ENV) {
    const envVar = await ctx.ui.input(
      "Environment variable name:",
      `${name.toUpperCase()}_API_KEY`
    );
    if (!envVar) {
      ctx.ui.notify("Cancelled", "info");
      return;
    }
    apiKey = `\${${envVar}}`;
    ctx.ui.notify(`Remember to set: export ${envVar}=your-api-key`, "info");
  } else {
    apiKey = await ctx.ui.input("API Key:", "sk-any");
    if (!apiKey) {
      ctx.ui.notify("API Key is required", "error");
      return;
    }
    ctx.ui.notify(
      "⚠️  API key will be stored in plaintext. Consider using environment variables.",
      "warning"
    );
  }

  const config = loadConfig();
  if (config === null) {
    ctx.ui.notify(
      "Failed to load models.json. File may be corrupted. Use /provider doctor to diagnose.",
      "error"
    );
    return;
  }

  if (config.providers[name]) {
    const ok = await ctx.ui.confirm(
      `Provider "${name}" already exists. Overwrite?`,
      "Overwrite?"
    );
    if (!ok) return;
  }

  config.providers[name] = {
    baseUrl,
    api: api as any,
    apiKey,
    models: [],
  };

  notifySaveResult(ctx, config, `✓ Provider "${name}" added successfully`);
}

async function handleProviderList(ctx: any): Promise<void> {
  const config = loadConfigOrNotify(ctx);
  if (config === null) return;

  const providers = providerNames(config);

  if (providers.length === 0) {
    ctx.ui.notify("No providers configured", "info");
    return;
  }

  let output = "Configured Providers:\n\n";
  for (const name of providers) {
    const p = config.providers[name];
    output += `• ${name}\n`;
    output += `  URL: ${p.baseUrl}\n`;
    output += `  API: ${p.api}\n`;
    output += `  Key: ${formatApiKeyStatus(p.apiKey)}\n`;
    output += `  Models: ${p.models.length}\n\n`;
  }

  ctx.ui.notify(output, "info");
}

async function handleProviderRemove(ctx: any): Promise<void> {
  const config = loadConfigOrNotify(ctx);
  if (config === null) return;

  const name = await selectProviderName(ctx, config, "Select provider to remove:");
  if (!name) return;

  const ok = await ctx.ui.confirm(
    `Delete provider "${name}" and all its models?`,
    "Confirm deletion"
  );

  if (!ok) return;

  delete config.providers[name];

  notifySaveResult(ctx, config, `✓ Provider "${name}" removed`);
}

async function handleProviderTest(ctx: any): Promise<void> {
  const config = loadConfigOrNotify(ctx);
  if (config === null) return;

  const selected = await selectProvider(ctx, config, "Select provider to test:");
  if (!selected) return;

  const { name, provider } = selected;
  ctx.ui.notify(`Testing ${name}...\nURL: ${provider.baseUrl}`, "info");

  const apiKeyResult = resolveConfigValue(provider.apiKey);
  if (!apiKeyResult.value) {
    const detail = apiKeyResult.missingEnvVars.length > 0
      ? `Environment variable ${apiKeyResult.missingEnvVars.join(", ")} is not set`
      : `Failed to resolve API key${apiKeyResult.error ? `: ${apiKeyResult.error}` : ""}`;
    ctx.ui.notify(detail, "error");
    return;
  }

  const result = await testProviderConnection(provider.baseUrl, apiKeyResult.value, provider.api);

  if (result.success) {
    let message = `✓ ${result.message}`;
    if (result.details) {
      message += `\n\n${result.details}`;
    }
    ctx.ui.notify(message, "success");
  } else {
    let message = `✗ ${result.message}`;
    if (result.details) {
      message += `\n\n${result.details}`;
    }
    ctx.ui.notify(message, "error");
  }
}

async function handleProviderDoctor(ctx: any): Promise<void> {
  ctx.ui.notify("Running diagnostics...", "info");

  const config = loadConfig();

  if (config === null) {
    let backupList = "";
    if (fs.existsSync(BACKUP_DIR)) {
      const backups = fs
        .readdirSync(BACKUP_DIR)
        .filter((f) => f.startsWith("models.json.backup."))
        .sort()
        .reverse()
        .slice(0, 5);

      if (backups.length > 0) {
        backupList = "\n\nAvailable backups:\n" + backups.map((b) => `  ${b}`).join("\n");
        backupList += `\n\nTo restore: cp ~/.pi/agent/backups/<backup-file> ~/.pi/agent/models.json`;
      }
    }

    ctx.ui.notify("✗ models.json is corrupted or invalid JSON" + backupList, "error");
    return;
  }

  let report = "Configuration Health Check:\n\n";
  report += `✓ models.json is valid JSON\n`;
  report += `✓ Location: ${CONFIG_PATH}\n`;

  if (fs.existsSync(BACKUP_DIR)) {
    const backups = fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith("models.json.backup."))
      .sort()
      .reverse();

    if (backups.length > 0) {
      report += `✓ Backups: ${backups.length} (keeping ${MAX_BACKUPS} most recent)\n`;
      report += `  Latest: ${backups[0]}\n`;
      report += `  Location: ${BACKUP_DIR}\n`;
    }
  }

  const providerCount = Object.keys(config.providers).length;
  report += `\nProviders: ${providerCount}\n`;

  for (const [name, provider] of Object.entries(config.providers)) {
    report += `\n• ${name}\n`;

    const envVars = parseConfigEnvVarNames(provider.apiKey);
    if (envVars.length > 0) {
      const missingEnvVars = envVars.filter((envVar) => process.env[envVar] === undefined);
      if (missingEnvVars.length === 0) {
        report += `  ✓ API key (${envVars.join(", ")}) is set\n`;
      } else {
        report += `  ✗ API key (${missingEnvVars.join(", ")}) is NOT set\n`;
      }
    } else if (provider.apiKey.startsWith("!")) {
      report += `  ✓ API key is loaded from shell command\n`;
    } else {
      report += `  ⚠️  API key is stored in plaintext\n`;
    }

    report += `  Models: ${provider.models.length}\n`;
  }

  ctx.ui.notify(report, "info");
}

async function handleProviderExport(ctx: any): Promise<void> {
  const config = loadConfigOrNotify(ctx);
  if (config === null) return;

  const providerName = await selectProviderName(ctx, config, "Select provider to export:");
  if (!providerName) return;

  const fileName = await ctx.ui.input(
    "Export file name under ~/.pi/agent/backups:",
    `${providerName}-export.json`
  );

  if (!fileName) {
    ctx.ui.notify("Cancelled", "info");
    return;
  }

  const exportData = {
    provider: providerName,
    config: config.providers[providerName],
    exportedAt: new Date().toISOString(),
    version: "1.0",
  };

  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const exportPath = resolveBackupFilePath(fileName);
    fs.writeFileSync(exportPath, JSON.stringify(exportData, null, 2), "utf-8");
    ctx.ui.notify(`✓ Exported provider "${providerName}" to ${exportPath}`, "success");
  } catch (error: any) {
    ctx.ui.notify(`Failed to export: ${error.message}`, "error");
  }
}

async function handleProviderImport(ctx: any): Promise<void> {
  const fileName = await ctx.ui.input("Import file name under ~/.pi/agent/backups:", "");

  if (!fileName) {
    ctx.ui.notify("Cancelled", "info");
    return;
  }

  let importPath: string;
  try {
    importPath = resolveBackupFilePath(fileName);
  } catch (error: any) {
    ctx.ui.notify(error.message, "error");
    return;
  }

  if (!fs.existsSync(importPath)) {
    ctx.ui.notify(`File not found: ${importPath}`, "error");
    return;
  }

  try {
    const content = fs.readFileSync(importPath, "utf-8");
    const importData = JSON.parse(content);

    if (!importData.provider || !importData.config) {
      ctx.ui.notify("Invalid export file format", "error");
      return;
    }

    const config = loadConfigOrNotify(ctx);
    if (config === null) return;

    let providerName = importData.provider;

    // Check if provider already exists
    if (config.providers[providerName]) {
      const overwrite = await ctx.ui.confirm(
        `Provider "${providerName}" already exists. Overwrite?`,
        "Overwrite?"
      );

      if (!overwrite) {
        // Ask for new name
        const newName = await ctx.ui.input("Enter new provider name:", `${providerName}-imported`);
        if (!newName) {
          ctx.ui.notify("Cancelled", "info");
          return;
        }
        providerName = newName;
      }
    }

    config.providers[providerName] = importData.config;

    notifySaveResult(
      ctx,
      config,
      `✓ Imported provider "${providerName}" with ${importData.config.models.length} model(s)`
    );
  } catch (error: any) {
    ctx.ui.notify(`Failed to import: ${error.message}`, "error");
  }
}

async function handleProviderSync(ctx: any): Promise<void> {
  const config = loadConfigOrNotify(ctx);
  if (config === null) return;

  const selected = await selectProvider(ctx, config, "Select provider to sync:");
  if (!selected) return;

  const { name: providerName, provider } = selected;

  if (!isOpenAICompatibleApi(provider.api)) {
    ctx.ui.notify("Sync is only supported for OpenAI-compatible APIs", "error");
    return;
  }

  ctx.ui.notify(`Syncing models from ${providerName}...`, "info");

  try {
    const remoteModels = await fetchProviderModels(provider);

    if (remoteModels.length === 0) {
      ctx.ui.notify("No models found on remote", "info");
      return;
    }

    const remoteModelIds = new Set(remoteModels.map((m: any) => m.id));
    const localModelIds = new Set(provider.models.map((m) => m.id));

    // Find models to add (in remote but not local)
    const toAdd = remoteModels
      .filter((m: any) => !localModelIds.has(m.id))
      .map((m: any) => m.id);

    // Find models to remove (in local but not remote)
    const toRemove = provider.models
      .filter((m) => !remoteModelIds.has(m.id))
      .map((m) => m.id);

    if (toAdd.length === 0 && toRemove.length === 0) {
      ctx.ui.notify("✓ All models are in sync", "success");
      return;
    }

    // Show sync plan
    let syncPlan = `Sync plan for "${providerName}":\n\n`;
    if (toAdd.length > 0) {
      syncPlan += `+ Add ${toAdd.length} model(s):\n`;
      syncPlan += toAdd.slice(0, 5).map((id) => `  + ${id}`).join("\n");
      if (toAdd.length > 5) {
        syncPlan += `\n  ... and ${toAdd.length - 5} more`;
      }
      syncPlan += "\n\n";
    }
    if (toRemove.length > 0) {
      syncPlan += `- Remove ${toRemove.length} model(s):\n`;
      syncPlan += toRemove.slice(0, 5).map((id) => `  - ${id}`).join("\n");
      if (toRemove.length > 5) {
        syncPlan += `\n  ... and ${toRemove.length - 5} more`;
      }
      syncPlan += "\n\n";
    }

    ctx.ui.notify(syncPlan, "info");

    const proceed = await ctx.ui.confirm("Apply sync changes?", "Sync confirmation");

    if (!proceed) {
      ctx.ui.notify("Sync cancelled", "info");
      return;
    }

    // Apply changes
    // Remove deleted models
    for (const modelId of toRemove) {
      const index = provider.models.findIndex((m) => m.id === modelId);
      if (index >= 0) {
        provider.models.splice(index, 1);
      }
    }

    // Add new models with OpenRouter info
    if (toAdd.length > 0) {
      ctx.ui.notify(`Fetching model info from OpenRouter for ${toAdd.length} new model(s)...`, "info");

      for (const modelId of toAdd) {
        const modelInfo = await fetchModelInfoFromOpenRouter(modelId);
        provider.models.push(createModelConfig(modelId, modelId, modelInfo));
      }
    }

    notifySaveResult(
      ctx,
      config,
      `✓ Synced successfully\n  + Added: ${toAdd.length}\n  - Removed: ${toRemove.length}\n  = Total: ${provider.models.length} models`
    );
  } catch (error: any) {
    notifyModelFetchError(ctx, error);
  }
}

async function handleProviderClearModels(ctx: any): Promise<void> {
  const config = loadConfigOrNotify(ctx);
  if (config === null) return;

  const selected = await selectProvider(ctx, config, "Select provider to clear models from:");
  if (!selected) return;

  const { name: providerName, provider } = selected;

  if (provider.models.length === 0) {
    ctx.ui.notify(`Provider "${providerName}" has no models`, "info");
    return;
  }

  const modelCount = provider.models.length;

  const ok = await ctx.ui.confirm(
    `Delete all ${modelCount} model(s) from provider "${providerName}"?\nThis action cannot be undone.`,
    "Clear all models"
  );

  if (!ok) {
    ctx.ui.notify("Cancelled", "info");
    return;
  }

  provider.models = [];

  notifySaveResult(
    ctx,
    config,
    `✓ Cleared ${modelCount} model(s) from provider "${providerName}"`
  );
}

// __CONTINUE_HERE_2__

async function handleProviderImportModels(ctx: any): Promise<void> {
  const config = loadConfigOrNotify(ctx);
  if (config === null) return;

  const selected = await selectProvider(
    ctx,
    config,
    "Select provider to import models from:",
    "No providers configured. Add one first with /provider add",
    "error"
  );
  if (!selected) return;

  const { name: providerName, provider } = selected;

  if (!isOpenAICompatibleApi(provider.api)) {
    ctx.ui.notify("Model import is only supported for OpenAI-compatible APIs", "error");
    return;
  }

  ctx.ui.notify(`Fetching models from ${providerName}...`, "info");

  try {
    const models = await fetchProviderModels(provider);

    if (models.length === 0) {
      ctx.ui.notify("No models found", "info");
      return;
    }

    const existingIds = new Set(provider.models.map((m) => m.id));

    // Store full model objects with metadata
    const modelsWithMetadata = models
      .filter((m: any) => !existingIds.has(m.id))
      .map((m: any) => ({
        id: m.id,
        metadata: {
          owned_by: m.owned_by,
          created: m.created,
          object: m.object,
        },
      }));

    let newModels = modelsWithMetadata.map((m: any) => m.id).sort();

    if (newModels.length === 0) {
      ctx.ui.notify("All available models are already imported", "info");
      return;
    }

    // Add keyword filter
    const filterKeyword = await ctx.ui.input(
      "Filter by keyword (optional, press Enter to skip):",
      ""
    );

    if (filterKeyword && filterKeyword.trim()) {
      const keyword = filterKeyword.trim().toLowerCase();
      const filteredModels = newModels.filter((m: string) =>
        m.toLowerCase().includes(keyword)
      );

      if (filteredModels.length === 0) {
        ctx.ui.notify(`No models match keyword "${keyword}"`, "info");
        return;
      }

      ctx.ui.notify(
        `Filtered from ${newModels.length} to ${filteredModels.length} model(s) matching "${keyword}"`,
        "info"
      );
      newModels = filteredModels;
    }

    // Display models with metadata
    const displayModels = newModels.slice(0, 10).map((modelId: string) => {
      const modelData = modelsWithMetadata.find((m: any) => m.id === modelId);
      let display = `  • ${modelId}`;

      if (modelData?.metadata) {
        const meta = modelData.metadata;
        const parts: string[] = [];

        if (meta.owned_by && meta.owned_by !== "system") {
          parts.push(meta.owned_by);
        }

        if (parts.length > 0) {
          display += ` (${parts.join(", ")})`;
        }
      }

      return display;
    });

    ctx.ui.notify(
      `Found ${newModels.length} new model(s):\n\n${displayModels.join("\n")}` +
      (newModels.length > 10 ? `\n  ... and ${newModels.length - 10} more` : ""),
      "info"
    );

    // Import mode selection
    const importMode = await ctx.ui.select("Import mode:", [
      "Import all",
      "Tag mode (y/n/s)",
      "Cancel",
    ]);

    if (!importMode || importMode === "Cancel") {
      ctx.ui.notify("Import cancelled", "info");
      return;
    }

    let selectedModels: string[] = [];

    if (importMode === "Import all") {
      selectedModels = newModels;
    } else {
      // Tag mode: y/n/s
      ctx.ui.notify(
        "Tag mode: y=yes (import), n=no (skip), s=skip remaining\n" +
        "Press Enter after each choice",
        "info"
      );

      for (let i = 0; i < newModels.length; i++) {
        const modelId = newModels[i];
        const choice = await ctx.ui.select(
          `${modelId} (${i + 1}/${newModels.length}):`,
          ["y - Import this model", "n - Skip this model", "s - Skip remaining"]
        );

        if (!choice) {
          break;
        }

        if (choice.startsWith("s")) {
          // Skip remaining
          break;
        }

        if (choice.startsWith("y")) {
          selectedModels.push(modelId);
        }
        // If 'n', just continue to next
      }
    }

    if (selectedModels.length === 0) {
      ctx.ui.notify("No models selected", "info");
      return;
    }

    // Configuration mode
    const configMode = await ctx.ui.select(
      `Configure ${selectedModels.length} selected model(s):`,
      [
        "Use OpenRouter defaults (auto-fetch for each)",
        "Use defaults (no config)",
        "Batch config (same for all)",
        "Individual config (one by one)",
      ]
    );

    if (!configMode) {
      ctx.ui.notify("Import cancelled", "info");
      return;
    }

    const modelConfigs: ModelConfig[] = [];

    if (configMode === "Use OpenRouter defaults (auto-fetch for each)") {
      // Fetch info from OpenRouter for each model
      ctx.ui.notify(`Fetching model info from OpenRouter for ${selectedModels.length} model(s)...`, "info");

      for (const modelId of selectedModels) {
        const modelInfo = await fetchModelInfoFromOpenRouter(modelId);
        const modelConfig = createModelConfig(modelId, modelId, modelInfo);

        if (modelInfo) {
          ctx.ui.notify(
            `✓ ${modelId}: ${modelInfo.contextWindow || "N/A"}k context, ${modelInfo.maxTokens || "N/A"} max tokens`,
            "success"
          );
        } else {
          ctx.ui.notify(`⚠ ${modelId}: info not found, using defaults`, "warning");
        }

        modelConfigs.push(modelConfig);
      }
    } else if (configMode === "Use defaults (no config)") {
      // Import with defaults
      for (const modelId of selectedModels) {
        modelConfigs.push(createModelConfig(modelId));
      }
    } else if (configMode === "Batch config (same for all)") {
      // Batch configuration
      let batchConfig: Partial<ModelConfig> = {};

      const reasoning = await ctx.ui.confirm(
        "Do these models support reasoning?",
        "Reasoning support"
      );

      if (reasoning) {
        batchConfig.reasoning = true;
      }

      const contextWindow = await promptOptionalNumber(
        ctx,
        "Context window (optional, e.g., 128000):"
      );
      if (contextWindow !== undefined) {
        batchConfig.contextWindow = contextWindow;
      }

      const maxTokens = await promptOptionalNumber(
        ctx,
        "Max output tokens (optional, e.g., 4096):"
      );
      if (maxTokens !== undefined) {
        batchConfig.maxTokens = maxTokens;
      }

      for (const modelId of selectedModels) {
        modelConfigs.push({
          id: modelId,
          name: modelId,
          ...batchConfig,
        });
      }
    } else {
      // Individual configuration
      for (const modelId of selectedModels) {
        ctx.ui.notify(`Configuring: ${modelId}`, "info");

        const modelName = await ctx.ui.input("Model name (optional):", modelId);

        const reasoning = await ctx.ui.confirm(
          "Does this model support reasoning?",
          "Reasoning support"
        );

        const contextWindow = await promptOptionalNumber(
          ctx,
          "Context window (optional, e.g., 128000):"
        );

        const maxTokens = await promptOptionalNumber(
          ctx,
          "Max output tokens (optional, e.g., 4096):"
        );

        const modelConfig = createModelConfig(modelId, modelName || modelId);

        if (reasoning) {
          modelConfig.reasoning = true;
        }

        if (contextWindow !== undefined) {
          modelConfig.contextWindow = contextWindow;
        }

        if (maxTokens !== undefined) {
          modelConfig.maxTokens = maxTokens;
        }

        modelConfigs.push(modelConfig);
      }
    }

    // Add all configured models
    for (const modelConfig of modelConfigs) {
      provider.models.push(modelConfig);
    }

    notifySaveResult(
      ctx,
      config,
      `✓ Successfully imported ${selectedModels.length} model(s) to provider "${providerName}"`
    );
  } catch (error: any) {
    notifyModelFetchError(ctx, error);
  }
}

// __CONTINUE_HERE_3__

// ============================================================================
// Model Command Handlers
// ============================================================================

async function handleModelAdd(ctx: any): Promise<void> {
  const config = loadConfigOrNotify(ctx);
  if (config === null) return;

  const selected = await selectProvider(
    ctx,
    config,
    "Select provider:",
    "No providers configured. Add one first with /provider add",
    "error"
  );
  if (!selected) return;

  const { name: providerName, provider } = selected;

  let modelId = "";
  let discoveredModels: string[] = [];

  // For OpenAI-compatible APIs, offer to fetch models
  if (isOpenAICompatibleApi(provider.api)) {
    const addMethod = await ctx.ui.select("How to add model?", [
      "Fetch from provider (discover available models)",
      "Enter manually",
    ]);

    if (!addMethod) {
      ctx.ui.notify("Cancelled", "info");
      return;
    }

    if (addMethod.startsWith("Fetch from provider")) {
      // Fetch models from provider
      ctx.ui.notify(`Fetching models from ${provider.baseUrl}...`, "info");

      try {
        const models = await fetchProviderModels(provider);

        if (models.length === 0) {
          ctx.ui.notify("No models found, falling back to manual input", "warning");
        } else {
          discoveredModels = models.map((m: any) => m.id).sort();

          const selectedModel = await ctx.ui.select(
            `Select model from ${providerName} (${discoveredModels.length} available):`,
            discoveredModels
          );

          if (!selectedModel) {
            ctx.ui.notify("Cancelled", "info");
            return;
          }

          modelId = selectedModel;
        }
      } catch (error: any) {
        if (error.name === "AbortError") {
          ctx.ui.notify("Request timeout, falling back to manual input", "warning");
        } else {
          ctx.ui.notify(`Failed to fetch models: ${error.message}`, "error");
          return;
        }
      }
    }
  }

  // Manual input fallback (or for non-OpenAI APIs)
  if (!modelId) {
    const inputModelId = await ctx.ui.input("Model ID:", "");
    if (!inputModelId) {
      ctx.ui.notify("Model ID is required", "error");
      return;
    }
    modelId = inputModelId;
  }

  const modelName = await ctx.ui.input("Model Name (optional):", modelId);

  // Fetch model info from OpenRouter
  ctx.ui.notify("Fetching model info from OpenRouter...", "info");
  const modelInfo = await fetchModelInfoFromOpenRouter(modelId);

  let suggestedContext: string | undefined;
  let suggestedMaxTokens: string | undefined;

  if (modelInfo) {
    ctx.ui.notify(
      `✓ Found model info:\n  Context: ${modelInfo.contextWindow || "N/A"}\n  Max output: ${modelInfo.maxTokens || "N/A"}`,
      "success"
    );
    suggestedContext = modelInfo.contextWindow?.toString();
    suggestedMaxTokens = modelInfo.maxTokens?.toString();
  } else {
    ctx.ui.notify("⚠ Model info not found in OpenRouter, using manual input", "warning");
  }

  const addAdvanced = await ctx.ui.confirm(
    "Configure advanced options (reasoning, compat, context window)?",
    "Advanced options"
  );

  const modelConfig = createModelConfig(modelId, modelName || modelId);

  if (addAdvanced) {
    const reasoning = await ctx.ui.confirm(
      "Does this model support reasoning?",
      "Reasoning support"
    );
    if (reasoning) {
      modelConfig.reasoning = true;
    }

    const needCompat = await ctx.ui.confirm(
      "Does this model have compatibility issues (e.g., no developer role)?",
      "Compatibility settings"
    );

    if (needCompat) {
      modelConfig.compat = await promptCompatibility(ctx);
    }

    const contextWindow = await promptOptionalNumber(
      ctx,
      suggestedContext
        ? `Context window (${suggestedContext}):`
        : "Context window (optional, e.g., 128000):",
      suggestedContext || ""
    );
    if (contextWindow !== undefined) {
      modelConfig.contextWindow = contextWindow;
    }

    const maxTokens = await promptOptionalNumber(
      ctx,
      suggestedMaxTokens
        ? `Max output tokens (${suggestedMaxTokens}):`
        : "Max output tokens (optional, e.g., 4096):",
      suggestedMaxTokens || ""
    );
    if (maxTokens !== undefined) {
      modelConfig.maxTokens = maxTokens;
    }
  } else if (modelInfo) {
    // Auto-fill with OpenRouter data if user skips advanced options
    applyModelInfo(modelConfig, modelInfo);
  }

  // Re-load provider (config might have been updated in scope)
  const currentProvider = config.providers[providerName];
  const existingIndex = currentProvider.models.findIndex((m) => m.id === modelId);

  if (existingIndex >= 0) {
    const ok = await ctx.ui.confirm(
      `Model "${modelId}" already exists. Overwrite?`,
      "Overwrite?"
    );
    if (!ok) return;
    currentProvider.models[existingIndex] = modelConfig;
  } else {
    currentProvider.models.push(modelConfig);
  }

  notifySaveResult(ctx, config, `✓ Model "${modelId}" added to provider "${providerName}"`);
}

async function handleModelList(ctx: any, providerName?: string): Promise<void> {
  const config = loadConfigOrNotify(ctx);
  if (config === null) return;

  if (providerName) {
    const provider = config.providers[providerName];
    if (!provider) {
      ctx.ui.notify(`Provider "${providerName}" not found`, "error");
      return;
    }

    if (provider.models.length === 0) {
      ctx.ui.notify(`No models configured for provider "${providerName}"`, "info");
      return;
    }

    let output = `Models for "${providerName}":\n\n`;
    for (const model of provider.models) {
      output += `${formatModelLine(model)}\n`;
    }
    ctx.ui.notify(output, "info");
  } else {
    let output = "All Models:\n\n";
    let hasModels = false;

    for (const [name, provider] of Object.entries(config.providers)) {
      if (provider.models.length > 0) {
        hasModels = true;
        output += `${name}:\n`;
        for (const model of provider.models) {
          output += `${formatModelLine(model, "  ", false)}\n`;
        }
        output += "\n";
      }
    }

    if (!hasModels) {
      ctx.ui.notify("No models configured", "info");
      return;
    }

    ctx.ui.notify(output, "info");
  }
}

async function handleModelRemove(ctx: any): Promise<void> {
  const config = loadConfigOrNotify(ctx);
  if (config === null) return;

  const selected = await selectProvider(ctx, config, "Select provider:");
  if (!selected) return;

  const { name: providerName, provider } = selected;
  const modelId = await selectModelId(ctx, provider, providerName, "Select model to remove:");
  if (!modelId) return;

  const ok = await ctx.ui.confirm(
    `Delete model "${modelId}" from provider "${providerName}"?`,
    "Confirm deletion"
  );

  if (!ok) return;

  const index = provider.models.findIndex((m) => m.id === modelId);

  if (index < 0) {
    ctx.ui.notify(`Model "${modelId}" not found in provider "${providerName}"`, "error");
    return;
  }

  provider.models.splice(index, 1);

  notifySaveResult(
    ctx,
    config,
    `✓ Model "${modelId}" removed from provider "${providerName}"`
  );
}

async function handleModelClone(ctx: any): Promise<void> {
  const config = loadConfigOrNotify(ctx);
  if (config === null) return;

  const providers = providerNames(config);
  const source = await selectProvider(ctx, config, "Select source provider:");
  if (!source) return;

  const { name: sourceProviderName, provider: sourceProvider } = source;
  const sourceModelId = await selectModelId(ctx, sourceProvider, sourceProviderName, "Select model to clone:");
  if (!sourceModelId) return;

  const sourceModel = sourceProvider.models.find((m) => m.id === sourceModelId);
  if (!sourceModel) {
    ctx.ui.notify("Model not found", "error");
    return;
  }

  // Select target provider
  const targetProviderName = await ctx.ui.select(
    "Select target provider:",
    [...providers, "[Same provider]"]
  );

  if (!targetProviderName || targetProviderName === "[Same provider]") {
    // Clone within same provider
    const newModelId = await ctx.ui.input("New model ID:", sourceModelId);
    if (!newModelId) {
      ctx.ui.notify("Model ID is required", "error");
      return;
    }

    if (sourceProvider.models.some((m) => m.id === newModelId)) {
      ctx.ui.notify(`Model "${newModelId}" already exists in provider "${sourceProviderName}"`, "error");
      return;
    }

    sourceProvider.models.push(cloneModelConfig(sourceModel, newModelId));

    notifySaveResult(
      ctx,
      config,
      `✓ Cloned "${sourceModelId}" to "${newModelId}" in provider "${sourceProviderName}"`
    );
  } else {
    // Clone to different provider
    const targetProvider = config.providers[targetProviderName];

    const newModelId = await ctx.ui.input("New model ID:", sourceModelId);
    if (!newModelId) {
      ctx.ui.notify("Model ID is required", "error");
      return;
    }

    if (targetProvider.models.some((m) => m.id === newModelId)) {
      ctx.ui.notify(`Model "${newModelId}" already exists in provider "${targetProviderName}"`, "error");
      return;
    }

    targetProvider.models.push(cloneModelConfig(sourceModel, newModelId));

    notifySaveResult(
      ctx,
      config,
      `✓ Cloned "${sourceModelId}" from "${sourceProviderName}" to "${newModelId}" in "${targetProviderName}"`
    );
  }
}

async function handleModelEdit(ctx: any): Promise<void> {
  const config = loadConfigOrNotify(ctx);
  if (config === null) return;

  const selected = await selectProvider(ctx, config, "Select provider:");
  if (!selected) return;

  const { name: providerName, provider } = selected;
  const modelId = await selectModelId(ctx, provider, providerName, "Select model to edit:");
  if (!modelId) return;

  const modelIndex = provider.models.findIndex((m) => m.id === modelId);
  if (modelIndex < 0) {
    ctx.ui.notify(`Model "${modelId}" not found`, "error");
    return;
  }

  const model = provider.models[modelIndex];

  // Show current configuration
  let currentConfig = `Current configuration for "${model.id}":\n\n`;
  currentConfig += `  ID: ${model.id}\n`;
  currentConfig += `  Name: ${model.name || model.id}\n`;
  currentConfig += `  Reasoning: ${model.reasoning ? "Yes" : "No"}\n`;
  currentConfig += `  Context window: ${model.contextWindow || "Not set"}\n`;
  currentConfig += `  Max tokens: ${model.maxTokens || "Not set"}\n`;
  if (model.compat) {
    currentConfig += `  Compatibility:\n`;
    currentConfig += `    Developer role: ${model.compat.supportsDeveloperRole ? "Yes" : "No"}\n`;
    currentConfig += `    Reasoning effort: ${model.compat.supportsReasoningEffort ? "Yes" : "No"}\n`;
  }
  ctx.ui.notify(currentConfig, "info");

  // Edit loop
  while (true) {
    const action = await ctx.ui.select("What to edit?", [
      "Model name",
      "Reasoning support",
      "Context window",
      "Max output tokens",
      "Compatibility settings",
      "Done (save changes)",
    ]);

    if (!action || action === "Done (save changes)") {
      break;
    }

    if (action === "Model name") {
      const newName = await ctx.ui.input("Model name:", model.name || model.id);
      if (newName) {
        model.name = newName;
        ctx.ui.notify(`✓ Name updated to: ${newName}`, "success");
      }
    } else if (action === "Reasoning support") {
      const reasoning = await ctx.ui.confirm(
        "Does this model support reasoning?",
        "Reasoning support"
      );
      model.reasoning = reasoning;
      ctx.ui.notify(`✓ Reasoning support: ${reasoning ? "Yes" : "No"}`, "success");
    } else if (action === "Context window") {
      const contextInput = await ctx.ui.input(
        "Context window (e.g., 128000, or empty to clear):",
        model.contextWindow?.toString() || ""
      );
      if (contextInput === "") {
        delete model.contextWindow;
        ctx.ui.notify("✓ Context window cleared", "success");
      } else if (contextInput) {
        const contextWindow = parseInt(contextInput, 10);
        if (isNaN(contextWindow)) {
          ctx.ui.notify("Invalid number, not changed", "warning");
        } else {
          model.contextWindow = contextWindow;
          ctx.ui.notify(`✓ Context window: ${contextWindow}`, "success");
        }
      }
    } else if (action === "Max output tokens") {
      const maxInput = await ctx.ui.input(
        "Max output tokens (e.g., 4096, or empty to clear):",
        model.maxTokens?.toString() || ""
      );
      if (maxInput === "") {
        delete model.maxTokens;
        ctx.ui.notify("✓ Max tokens cleared", "success");
      } else if (maxInput) {
        const maxTokens = parseInt(maxInput, 10);
        if (isNaN(maxTokens)) {
          ctx.ui.notify("Invalid number, not changed", "warning");
        } else {
          model.maxTokens = maxTokens;
          ctx.ui.notify(`✓ Max output tokens: ${maxTokens}`, "success");
        }
      }
    } else if (action === "Compatibility settings") {
      model.compat = await promptCompatibility(ctx);
      ctx.ui.notify("✓ Compatibility settings updated", "success");
    }
  }

  // Save changes
  notifySaveResult(ctx, config, `✓ Model "${modelId}" updated successfully`);
}

// __CONTINUE_HERE_4__

// ============================================================================
// Main Extension Entry Point
// ============================================================================

export default function (pi: ExtensionAPI) {
  // Register /provider command
  pi.registerCommand("provider", {
    description: "Manage custom providers in models.json",
    handler: async (args, ctx) => {
      const parts = args?.trim().split(/\s+/) || [];
      const [action] = parts;

      switch (action) {
        case "add":
          return handleProviderAdd(ctx);
        case "list":
          return handleProviderList(ctx);
        case "remove":
          return handleProviderRemove(ctx);
        case "test":
          return handleProviderTest(ctx);
        case "doctor":
          return handleProviderDoctor(ctx);
        case "import-models":
          return handleProviderImportModels(ctx);
        case "clear-models":
          return handleProviderClearModels(ctx);
        case "export":
          return handleProviderExport(ctx);
        case "import":
          return handleProviderImport(ctx);
        case "sync":
          return handleProviderSync(ctx);
        default:
          ctx.ui.notify(
            "Provider Management Commands:\n\n" +
            "/provider add - Add provider (interactive)\n" +
            "/provider list - List all providers\n" +
            "/provider remove - Remove provider (interactive)\n" +
            "/provider test - Test provider connection (interactive)\n" +
            "/provider doctor - Run diagnostics\n" +
            "/provider import-models - Import models from provider (interactive)\n" +
            "/provider clear-models - Clear all models from provider (interactive)\n" +
            "/provider export - Export provider config to JSON file\n" +
            "/provider import - Import provider config from JSON file\n" +
            "/provider sync - Sync models with provider (add new, remove deleted)\n\n" +
            "APIs: openai-completions, openai-responses, anthropic-messages, google-generative-ai",
            "info"
          );
      }
    },
  });

  // Register /add-model command
  pi.registerCommand("add-model", {
    description: "Manage models for custom providers",
    handler: async (args, ctx) => {
      const parts = args?.trim().split(/\s+/) || [];
      const [action, ...rest] = parts;

      switch (action) {
        case "add":
          return handleModelAdd(ctx);
        case "list":
          return handleModelList(ctx, rest[0]);
        case "remove":
          return handleModelRemove(ctx);
        case "edit":
          return handleModelEdit(ctx);
        case "clone":
          return handleModelClone(ctx);
        default:
          ctx.ui.notify(
            "Model Management Commands:\n\n" +
            "/add-model add - Add model (interactive)\n" +
            "/add-model list [provider] - List models\n" +
            "/add-model remove - Remove model (interactive)\n" +
            "/add-model edit - Edit model configuration (interactive)\n" +
            "/add-model clone - Clone model to same or different provider",
            "info"
          );
      }
    },
  });

  // Session start notification
  pi.on("session_start", async (_event, ctx) => {
    const config = loadConfig();

    if (config === null) {
      ctx.ui.notify(
        "⚠️  Provider Manager: models.json is corrupted\n" +
        "Run /provider doctor for diagnostics",
        "warning"
      );
      return;
    }

    const providerCount = Object.keys(config.providers).length;
    if (providerCount > 0) {
      ctx.ui.notify(
        `Provider Manager: ${providerCount} custom provider(s) loaded\n` +
        "Use /provider or /add-model to manage configurations",
        "info"
      );
    }
  });
}
