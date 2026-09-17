/**
 * TS port of `tests/helpers.py`'s `MCPClient`: exercises the real JSON-RPC wire contract over a
 * real HTTP connection (not the tool handlers directly), matching how the Python integration
 * suite this phase ports drives the server. Used only by this package's own tests.
 */

export type JsonRpcResult = Record<string, unknown>;

export class McpTestClient {
  private sequence = 0;

  constructor(private readonly baseUrl: string) {}

  async request(method: string, params: unknown): Promise<JsonRpcResult> {
    this.sequence += 1;
    const response = await fetch(`${this.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-11-25",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.sequence, method, params }),
    });
    if (response.status !== 200) {
      throw new Error(
        `MCP request ${method} failed: ${String(response.status)} ${await response.text()}`,
      );
    }
    const payload = (await response.json()) as { result?: JsonRpcResult; error?: unknown };
    if (payload.error !== undefined) {
      throw new Error(`MCP request ${method} returned an error: ${JSON.stringify(payload.error)}`);
    }
    if (payload.result === undefined) {
      throw new Error(`MCP request ${method} returned no result`);
    }
    return payload.result;
  }

  async initialize(): Promise<JsonRpcResult> {
    return this.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    allowError = false,
  ): Promise<JsonRpcResult> {
    const result = await this.request("tools/call", { name, arguments: args });
    if (!allowError && result["isError"] === true) {
      throw new Error(`Tool ${name} returned an error result: ${JSON.stringify(result)}`);
    }
    return result;
  }

  async data(name: string, args: Record<string, unknown>): Promise<JsonRpcResult> {
    const result = await this.call(name, args);
    return result["structuredContent"] as JsonRpcResult;
  }

  async wait(jobId: string, timeoutMs = 60_000): Promise<JsonRpcResult> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = await this.data("get_job", { job_id: jobId });
      if (["succeeded", "failed", "cancelled"].includes(job["status"] as string)) {
        if (job["status"] !== "succeeded") {
          throw new Error(`Job ${jobId} did not succeed: ${JSON.stringify(job)}`);
        }
        return job;
      }
      if (Date.now() > deadline) {
        throw new Error(`Job ${jobId} did not finish within ${String(timeoutMs)}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
