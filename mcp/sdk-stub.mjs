import process from 'node:process';

export class McpError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'McpError';
    this.code = code || 'E_UNKNOWN';
    if (data !== undefined) {
      this.data = data;
    }
  }
}

function defaultLogger() {
  return {
    info: (msg) => console.log(msg),
    warn: (msg) => console.warn(msg),
    error: (msg) => console.error(msg)
  };
}

export class Server {
  constructor(metadata = {}) {
    this.metadata = metadata;
    this.tools = new Map();
  }

  tool(name, _definition, handler) {
    if (typeof name !== 'string') {
      throw new Error('Tool name must be a string');
    }
    if (typeof handler !== 'function') {
      throw new Error('Tool handler must be a function');
    }
    this.tools.set(name, { handler });
  }

  async invokeTool(name, input, context = {}) {
    const entry = this.tools.get(name);
    if (!entry) throw new Error(`Tool not registered: ${name}`);
    const logger = context.logger || defaultLogger();
    return entry.handler({ input }, { logger });
  }

  async listen() {
    console.log('[Stub MCP] Server metadata:', JSON.stringify(this.metadata));
    console.log('[Stub MCP] Registered tools:', Array.from(this.tools.keys()).join(', '));
    console.log('[Stub MCP] Waiting for stdin (no-op stub). Press Ctrl+C to exit.');
    process.stdin.resume();
  }
}
