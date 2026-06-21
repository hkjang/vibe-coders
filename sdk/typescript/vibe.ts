// vibe-coders TypeScript SDK — a tiny, dependency-free client for the AI Gateway.
// Works in Node 18+ and modern browsers (uses the global fetch). Read-only lookups go through
// the Gateway MCP server (/mcp/gateway); chat/app/workflow go through the /v1 API.
//
// Usage:
//   import { VibeClient } from "./vibe";
//   const vibe = new VibeClient({ baseURL: "https://gw.example.com", apiKey: process.env.VIBE_API_KEY! });
//   const out = await vibe.chat("코드 리뷰 해줘", { model: "vibe/auto" });

export interface VibeOptions {
  baseURL?: string; // default http://localhost:8080
  apiKey: string;
}

export interface ChatOptions {
  model?: string; // default "vibe/auto"
  skill?: string; // sets the X-Skill header
  maxTokens?: number;
}

export class VibeError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "VibeError";
  }
}

export class VibeClient {
  private baseURL: string;
  private apiKey: string;

  constructor(opts: VibeOptions) {
    this.baseURL = (opts.baseURL ?? "http://localhost:8080").replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}`, ...(extra ?? {}) };
  }

  private async req(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<any> {
    const res = await fetch(this.baseURL + path, {
      method,
      headers: this.headers(extraHeaders),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new VibeError(res.status, text || `HTTP ${res.status}`);
    return text ? JSON.parse(text) : {};
  }

  /** Run a chat completion through the gateway. Returns the assistant message text. */
  async chat(prompt: string, opts: ChatOptions = {}): Promise<string> {
    const body = {
      model: opts.model ?? "vibe/auto",
      messages: [{ role: "user", content: prompt }],
      stream: false,
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    };
    const extra = opts.skill ? { "X-Skill": opts.skill } : undefined;
    const out = await this.req("POST", "/v1/chat/completions", body, extra);
    return out?.choices?.[0]?.message?.content ?? "";
  }

  /** List available models (the OpenAI-compatible /v1/models response). */
  async models(): Promise<any> {
    return this.req("GET", "/v1/models");
  }

  /** Run an AI work app, returning its execution plan + run id. */
  async runApp(appId: string): Promise<any> {
    return this.req("POST", `/v1/apps/${encodeURIComponent(appId)}/run`, {});
  }

  /** Execute a workflow chain server-side. */
  async runWorkflow(workflowId: string, input: string): Promise<any> {
    return this.req("POST", `/v1/workflows/${encodeURIComponent(workflowId)}/run`, { execute: true, input });
  }

  /** Call a read-only Gateway MCP tool (e.g. gateway_check_quota) and return its parsed JSON text. */
  async mcpTool(tool: string, args: Record<string, unknown> = {}): Promise<any> {
    const out = await this.req("POST", "/mcp/gateway", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: args },
    });
    if (out?.error) throw new VibeError(0, out.error.message ?? "mcp error");
    const text: string | undefined = out?.result?.content?.[0]?.text;
    if (!text) return out?.result ?? {};
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  }

  quota(): Promise<any> {
    return this.mcpTool("gateway_check_quota");
  }
  usage(window = "30d"): Promise<any> {
    return this.mcpTool("gateway_get_usage_summary", { window });
  }
  routePreview(model: string, prompt: string): Promise<any> {
    return this.mcpTool("gateway_route_preview", { model, prompt });
  }

  /** Build an MCP client config block (Claude/Cursor/Roo/Cline) for this gateway. */
  mcpConfig(): Record<string, unknown> {
    return {
      mcpServers: {
        "vibe-gateway": {
          url: this.baseURL + "/mcp/gateway",
          headers: { Authorization: "Bearer ${VIBE_API_KEY}" },
        },
      },
    };
  }
}
