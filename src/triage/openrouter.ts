export interface OpenRouterConfig {
  apiKey: string;
  textModel: string;
  visionModel: string;
  timeoutMs: number;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  costUsd: number | null;
}

export interface CompletionResult<T> {
  data: T;
  usage: Usage;
  model: string;
}

interface ChatMessageContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

export interface ChatMessage {
  role: "system" | "user";
  content: string | ChatMessageContentPart[];
}

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Models wrap JSON in prose or fences often enough that parsing the raw string
 * is unreliable. Pull out the first balanced object rather than trusting the
 * whole response to be valid JSON.
 */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    if (start === -1) throw new Error(`No JSON object in model response: ${text.slice(0, 200)}`);
    let depth = 0;
    for (let i = start; i < candidate.length; i += 1) {
      if (candidate[i] === "{") depth += 1;
      else if (candidate[i] === "}") {
        depth -= 1;
        if (depth === 0) return JSON.parse(candidate.slice(start, i + 1));
      }
    }
    throw new Error(`Unbalanced JSON in model response: ${text.slice(0, 200)}`);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Providers behind OpenRouter rate-limit independently and transiently. */
function isRetryable(message: string): boolean {
  return /\b(429|408|500|502|503|504)\b/.test(message) || /rate.?limit|overloaded|timeout/i.test(message);
}

export async function complete<T>(
  config: OpenRouterConfig,
  options: {
    model: string;
    messages: ChatMessage[];
    maxTokens?: number;
    temperature?: number;
    reasoningEffort?: "low" | "medium" | "high";
  }
): Promise<CompletionResult<T>> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await attemptComplete<T>(config, options);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === 3 || !isRetryable(lastError.message)) throw lastError;
      await sleep(attempt * 2000);
    }
  }
  throw lastError ?? new Error("OpenRouter call failed");
}

async function attemptComplete<T>(
  config: OpenRouterConfig,
  options: {
    model: string;
    messages: ChatMessage[];
    maxTokens?: number;
    temperature?: number;
    reasoningEffort?: "low" | "medium" | "high";
  }
): Promise<CompletionResult<T>> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
      // OpenRouter attributes traffic with these; harmless but useful in usage
      // dashboards when several tools share one key.
      "x-title": "gumtree-keyword-watcher"
    },
    body: JSON.stringify({
      model: options.model,
      messages: options.messages,
      // Reasoning models spend the token budget thinking before they emit any
      // content, so a tight cap returns an empty message rather than an error.
      // deepseek-v4-flash silently produced no content at 1200.
      max_tokens: options.maxTokens ?? 4000,
      temperature: options.temperature ?? 0,
      // Only sent when a caller opts in: on non-reasoning models it is wasted,
      // and it skews short vision replies into spending their budget thinking.
      ...(options.reasoningEffort ? { reasoning: { effort: options.reasoningEffort } } : {}),
      response_format: { type: "json_object" },
      usage: { include: true }
    }),
    signal: AbortSignal.timeout(config.timeoutMs)
  });

  if (!response.ok) {
    throw new Error(`OpenRouter ${options.model} returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }

  const body = await response.json();
  if (body.error) {
    throw new Error(`OpenRouter ${options.model} error: ${JSON.stringify(body.error).slice(0, 300)}`);
  }

  const choice = body.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    const reason = choice?.finish_reason;
    throw new Error(
      `OpenRouter ${options.model} returned no content` +
        (reason === "length"
          ? " (hit max_tokens — reasoning consumed the budget; raise maxTokens)"
          : reason
            ? ` (finish_reason=${reason})`
            : "")
    );
  }

  return {
    data: extractJson(content) as T,
    model: body.model ?? options.model,
    usage: {
      promptTokens: body.usage?.prompt_tokens ?? 0,
      completionTokens: body.usage?.completion_tokens ?? 0,
      // OpenRouter reports real spend when `usage.include` is set, which beats
      // estimating from a price list that changes under us.
      costUsd: typeof body.usage?.cost === "number" ? body.usage.cost : null
    }
  };
}
