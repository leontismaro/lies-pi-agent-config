import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Severity = "info" | "warn" | "error";

type Config = {
	enabled: boolean;
	cleanContext: boolean;
	notify: boolean;
	setStatus: boolean;
	setWidget: boolean;
	language: "en" | "zh";
	aggregateNotify: boolean;
	notifyWindowMs: number;
	showProvider: boolean;
	showModel: boolean;
	showRequestId: boolean;
	showRetryAfter: boolean;
	includeRawSnippet: boolean;
	maxRawChars: number;
};

type ProviderContext = {
	provider?: string;
	model?: string;
	api?: string;
};

type NormalizedError = {
	changed: boolean;
	status?: number;
	title: string;
	meaning: string;
	action: string;
	requestId?: string;
	timestamp?: string;
	retryAfter?: string;
	severity: Severity;
	message: string;
	signature?: string;
};

const DEFAULT_CONFIG: Config = {
	enabled: true,
	cleanContext: true,
	notify: false,
	setStatus: true,
	setWidget: false,
	language: "zh",
	aggregateNotify: true,
	notifyWindowMs: 120000,
	showProvider: true,
	showModel: true,
	showRequestId: true,
	showRetryAfter: true,
	includeRawSnippet: false,
	maxRawChars: 500,
};

const HTML_PATTERN = /<!doctype html|<html[\s>]|<style[\s>]|<body[\s>]/i;
const NORMALIZED_PREFIX = "Provider API Error:";

export default function providerErrorNormalizer(pi: ExtensionAPI) {
	let lastResponse: { status?: number; retryAfter?: string } = {};
	const errorCounts = new Map<string, { count: number; firstSeen: number; lastSeen: number }>();

	pi.on("after_provider_response", (event) => {
		lastResponse = {
			status: typeof event.status === "number" ? event.status : undefined,
			retryAfter: headerValue(event.headers?.["retry-after"]),
		};
	});

	pi.on("message_end", (event, ctx) => {
		const config = loadConfig();
		if (!config.enabled) return;
		const message = event.message;
		if (message.role !== "assistant") return;
		if (message.stopReason !== "error") return;

		const normalized = normalizeProviderError(message.errorMessage ?? "", {
			provider: message.provider,
			model: message.model,
			api: message.api,
		}, config, lastResponse);
		if (!normalized.changed) return;

		const summary = registerErrorOccurrence(normalized, config, errorCounts);
		const finalMessage = withOccurrenceCount(normalized.message, summary.count);

		if (ctx.mode === "tui") {
			if (config.notify && summary.shouldNotify) {
				ctx.ui.notify(summary.text, uiSeverity(normalized.severity));
			}
			if (config.setStatus) {
				ctx.ui.setStatus("provider-error", formatStatus(normalized, config, summary.count));
			}
			if (config.setWidget) {
				ctx.ui.setWidget("provider-error", []);
			}
		}

		lastErrorSignature = normalized.signature;

		return {
			message: {
				...message,
				errorMessage: finalMessage,
			},
		};
	});

	let lastErrorSignature: string | undefined;

	pi.on("context", (event) => {
		const config = loadConfig();
		if (!config.enabled || !config.cleanContext) return;

		let changed = false;
		let previousProviderErrorSignature: string | undefined;
		const messages = event.messages.flatMap((message) => {
			if (message.role !== "assistant" || message.stopReason !== "error") {
				previousProviderErrorSignature = undefined;
				return [message];
			}
			const normalized = normalizeProviderError(message.errorMessage ?? "", {
				provider: message.provider,
				model: message.model,
				api: message.api,
			}, config, {});
			if (!normalized.changed) {
				previousProviderErrorSignature = undefined;
				return [message];
			}
			if (normalized.signature && normalized.signature === previousProviderErrorSignature) {
				changed = true;
				return [];
			}
			previousProviderErrorSignature = normalized.signature;
			if (message.errorMessage === normalized.message) return [message];
			changed = true;
			return [{ ...message, errorMessage: normalized.message }];
		});

		if (!changed) return;
		return { messages };
	});
}

export function normalizeProviderError(raw: string, context: ProviderContext = {}, config: Partial<Config> = {}, response: { status?: number; retryAfter?: string } = {}): NormalizedError {
	const merged = { ...DEFAULT_CONFIG, ...config };
	const error = String(raw ?? "").trim();
	if (!error) return unchanged(error);
	if (error.startsWith(NORMALIZED_PREFIX)) return unchanged(error);

	const status = extractStatus(error) ?? response.status;
	const hasProviderShape = /\b(api|provider|openai|anthropic|gemini|perplexity|exa|axis)\b/i.test(error);
	const hasHtml = HTML_PATTERN.test(error);
	const shouldNormalize = hasHtml || isKnownProviderStatus(status) || /rate limit|too many requests|quota|overloaded|bad gateway|gateway timeout|service unavailable/i.test(error);
	if (!shouldNormalize || !hasProviderShape && !status && !hasHtml) return unchanged(error);

	const requestId = extractField(error, ["request_id", "request-id", "x-request-id", "cf-ray"]);
	const timestamp = extractField(error, ["timestamp", "time"]);
	const retryAfter = response.retryAfter ?? extractField(error, ["retry-after", "retry_after"]);
	const title = titleForStatus(status, error);
	const meaning = meaningForStatus(status, error, merged.language);
	const action = actionForStatus(status, error, retryAfter, merged.language);
	const severity = severityForStatus(status);
	const lines = [`${NORMALIZED_PREFIX} ${title}`, ""];

	if (merged.showProvider && context.provider) lines.push(`Provider: ${context.provider}`);
	if (merged.showModel && context.model) lines.push(`Model: ${context.model}`);
	if (context.api) lines.push(`API: ${context.api}`);
	if (status) lines.push(`Status: ${status}`);
	if (merged.showRetryAfter && retryAfter) lines.push(`Retry-After: ${retryAfter}`);
	if (merged.showRequestId && requestId) lines.push(`Request ID: ${requestId}`);
	if (timestamp) lines.push(`Timestamp: ${timestamp}`);
	lines.push("", formatSemanticMessage(meaning, action, merged.language));

	if (merged.includeRawSnippet) {
		const snippet = stripHtml(error).replace(/\s+/g, " ").trim().slice(0, Math.max(0, merged.maxRawChars));
		if (snippet) lines.push("", `Raw snippet: ${snippet}`);
	}

	return {
		changed: true,
		status,
		title,
		meaning,
		action,
		requestId,
		timestamp,
		retryAfter,
		severity,
		message: lines.join("\n"),
		signature: `${status ?? "unknown"}:${title}:${context.provider ?? ""}:${context.model ?? ""}`,
	};
}

function loadConfig(): Config {
	const path = join(homedir(), ".pi", "provider-errors.json");
	if (!existsSync(path)) return DEFAULT_CONFIG;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
		return { ...DEFAULT_CONFIG, ...parsed };
	} catch {
		return DEFAULT_CONFIG;
	}
}

function unchanged(message: string): NormalizedError {
	return {
		changed: false,
		title: "Unchanged provider error",
		meaning: "No normalization rule matched.",
		action: "Inspect the raw provider error.",
		severity: "error",
		message,
	};
}

function headerValue(value: unknown): string | undefined {
	if (Array.isArray(value)) return value.map(String).join(", ");
	if (typeof value === "string") return value;
	if (typeof value === "number") return String(value);
	return undefined;
}

function extractStatus(error: string): number | undefined {
	const patterns = [
		/\b(?:error|status|http|api error)\D{0,20}(\d{3})\b/i,
		/^\s*(\d{3})\b/,
		/\b(400|401|403|404|408|409|422|429|500|502|503|504|529)\b/,
	];
	for (const pattern of patterns) {
		const match = error.match(pattern);
		if (!match) continue;
		const status = Number(match[1]);
		if (status >= 400 && status <= 599) return status;
	}
	return undefined;
}

function extractField(text: string, names: string[]): string | undefined {
	for (const name of names) {
		const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const htmlPattern = new RegExp(`<span[^>]*>\\s*${escaped}\\s*</span>\\s*<span[^>]*>([^<]+)</span>`, "i");
		const htmlMatch = text.match(htmlPattern);
		if (htmlMatch?.[1]) return decodeEntities(htmlMatch[1].trim());

		const jsonPattern = new RegExp(`"${escaped}"\\s*:\\s*"([^"]+)"`, "i");
		const jsonMatch = text.match(jsonPattern);
		if (jsonMatch?.[1]) return jsonMatch[1].trim();

		const linePattern = new RegExp(`\\b${escaped}\\b\\s*[:=]\\s*([^\\n\\r,;]+)`, "i");
		const lineMatch = text.match(linePattern);
		if (lineMatch?.[1]) return lineMatch[1].trim().replace(/["'}>]+$/g, "");
	}
	return undefined;
}

function titleForStatus(status: number | undefined, error: string): string {
	if (status === 400) return "400 Bad Request";
	if (status === 401) return "401 Authentication Failed";
	if (status === 403) return "403 Permission Denied";
	if (status === 404) return "404 Endpoint or Model Not Found";
	if (status === 408) return "408 Request Timeout";
	if (status === 409) return "409 Request Conflict";
	if (status === 422) return "422 Invalid Request";
	if (status === 429) return "429 Rate Limited";
	if (status === 500) return "500 Provider Server Error";
	if (status === 502) return "502 Bad Gateway";
	if (status === 503) return "503 Service Unavailable";
	if (status === 504) return "504 Gateway Timeout";
	if (status === 529) return "529 Provider Overloaded";
	if (/rate limit|too many requests/i.test(error)) return "Rate Limited";
	if (/overloaded/i.test(error)) return "Provider Overloaded";
	if (/bad gateway/i.test(error)) return "Bad Gateway";
	return "Provider Request Failed";
}

function meaningForStatus(status: number | undefined, error: string, language: Config["language"]): string {
	if (language === "zh") {
		if (status === 400 || status === 422) return "供应商拒绝了请求参数或请求体。";
		if (status === 401) return "供应商拒绝了当前认证凭据。";
		if (status === 403) return "当前账号或密钥没有访问权限。";
		if (status === 404) return "接口、部署名或模型 ID 不存在。";
		if (status === 408) return "供应商没有在超时时间内完成请求。";
		if (status === 409) return "供应商报告请求冲突。";
		if (status === 429) return "触发了供应商限流或额度限制。";
		if (status === 500) return "供应商内部服务错误。";
		if (status === 502) return "上游网关或源站服务失败。";
		if (status === 503) return "供应商服务暂时不可用。";
		if (status === 504) return "网关等待供应商响应超时。";
		if (status === 529 || /overloaded/i.test(error)) return "供应商当前过载。";
		return "供应商返回了 API 错误。";
	}
	if (status === 400 || status === 422) return "The provider rejected the request payload.";
	if (status === 401) return "The provider rejected authentication credentials.";
	if (status === 403) return "The account or key lacks permission for this request.";
	if (status === 404) return "The endpoint, deployment, or model was not found.";
	if (status === 408) return "The provider did not complete the request in time.";
	if (status === 409) return "The provider reported a request conflict.";
	if (status === 429) return "The provider rate limit or quota was exceeded.";
	if (status === 500) return "The provider returned an internal server error.";
	if (status === 502) return "An upstream gateway or origin server failed.";
	if (status === 503) return "The provider service is temporarily unavailable.";
	if (status === 504) return "A gateway timed out waiting for the provider.";
	if (status === 529 || /overloaded/i.test(error)) return "The provider is overloaded.";
	return "The provider returned an API error.";
}

function actionForStatus(status: number | undefined, error: string, retryAfter?: string, language: Config["language"] = "en"): string {
	if (language === "zh") {
		if (status === 400 || status === 422) return "检查请求大小、模型参数和供应商兼容性。";
		if (status === 401 || status === 403) return "检查 API key、登录态、账号权限和模型访问权限。";
		if (status === 404) return "检查 base URL、部署名和模型 ID。";
		if (status === 408 || status === 504) return "重试；如果重复出现，缩小请求或切换供应商/模型。";
		if (status === 409) return "等待冲突的供应商操作结束后重试。";
		if (status === 429 || /rate limit|too many requests/i.test(error)) return retryAfter ? `等待 ${retryAfter} 后重试，或切换供应商/模型。` : "稍后重试、降低请求频率，或切换供应商/模型。";
		if (status === 500 || status === 502 || status === 503 || status === 529 || /bad gateway|overloaded/i.test(error)) return "稍后重试；如果重复出现，切换供应商/模型。";
		return "先重试一次；如果重复出现，检查供应商配置和日志。";
	}
	if (status === 400 || status === 422) return "Review request size, model parameters, and provider compatibility.";
	if (status === 401 || status === 403) return "Check API key, login state, account permissions, and selected model access.";
	if (status === 404) return "Check the configured base URL, deployment name, and model id.";
	if (status === 408 || status === 504) return "Retry; if repeated, reduce request size or switch provider/model.";
	if (status === 409) return "Retry after the conflicting provider operation completes.";
	if (status === 429 || /rate limit|too many requests/i.test(error)) return retryAfter ? `Wait ${retryAfter}, then retry or switch provider/model.` : "Wait before retrying, reduce request rate, or switch provider/model.";
	if (status === 500 || status === 502 || status === 503 || status === 529 || /bad gateway|overloaded/i.test(error)) return "Retry later, or switch provider/model if it repeats.";
	return "Retry once; if repeated, inspect provider configuration and logs.";
}

function formatSemanticMessage(meaning: string, action: string, language: Config["language"]): string {
	if (language === "zh") {
		if (meaning.includes("上游网关") || meaning.includes("供应商服务暂时不可用") || meaning.includes("供应商内部服务错误") || meaning.includes("供应商当前过载") || meaning.includes("网关等待供应商响应超时")) {
			return `${meaning.replace(/[。.]$/, "")}，请稍后重试。`;
		}
		return `${meaning} ${action}`;
	}
	return `${meaning} ${action}`;
}

function severityForStatus(status: number | undefined): Severity {
	if (status === 429 || status === 408 || status === 500 || status === 502 || status === 503 || status === 504 || status === 529) return "warn";
	return "error";
}

function uiSeverity(severity: Severity): "info" | "warning" | "error" {
	return severity === "warn" ? "warning" : severity;
}

function registerErrorOccurrence(normalized: NormalizedError, config: Config, counts: Map<string, { count: number; firstSeen: number; lastSeen: number }>): { text: string; count: number; shouldNotify: boolean } {
	if (!config.aggregateNotify) return { text: `${normalized.title}: ${normalized.action}`, count: 1, shouldNotify: true };
	const now = Date.now();
	const key = normalized.signature ?? `${normalized.status ?? "unknown"}:${normalized.title}`;
	const existing = counts.get(key);
	const isRepeat = Boolean(existing && now - existing.lastSeen <= config.notifyWindowMs);
	const entry = isRepeat && existing
		? { count: existing.count + 1, firstSeen: existing.firstSeen, lastSeen: now }
		: { count: 1, firstSeen: now, lastSeen: now };
	counts.set(key, entry);
	return {
		text: `${normalized.title}: ${normalized.action}`,
		count: entry.count,
		shouldNotify: !isRepeat,
	};
}

function formatStatus(normalized: NormalizedError, config: Config, count: number): string {
	const prefix = config.language === "zh" ? "供应商错误" : "Provider error";
	const countSuffix = count > 1 ? ` ×${count}` : "";
	return `${prefix}: ${normalized.title}${normalized.status ? ` ${normalized.status}` : ""}${countSuffix}`;
}

function withOccurrenceCount(message: string, count: number): string {
	if (count <= 1) return message;
	return message.replace(/^Provider API Error: ([^\n]+)/, `Provider API Error: $1 ×${count}`);
}

function isKnownProviderStatus(status: number | undefined): boolean {
	return status !== undefined && [400, 401, 403, 404, 408, 409, 422, 429, 500, 502, 503, 504, 529].includes(status);
}

function stripHtml(text: string): string {
	return decodeEntities(text)
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<[^>]+>/g, " ");
}

function decodeEntities(text: string): string {
	return text
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}
