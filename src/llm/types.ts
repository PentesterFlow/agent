// Core LLM types. The shape lets sessions, tool calls, and message
// lists round-trip through saved session files.

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface FunctionCall {
  name: string;
  /** JSON-encoded arguments object, exactly as the model produced it. */
  arguments: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: FunctionCall;
  provider?: {
    gemini?: {
      thoughtSignature?: string;
    };
  };
}

export interface Message {
  role: Role;
  content: string;
  toolCalls?: ToolCall[];
  toolCallID?: string;
  name?: string;
}

export interface ToolFunction {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolSpec {
  type: 'function';
  function: ToolFunction;
}

export interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: ToolSpec[];
  stream?: boolean;
}

export interface ChatResponse {
  message: Message;
  finishReason: string;
}

/**
 * Parse a FunctionCall's `arguments` string back into an object. Returns
 * an empty object when arguments is empty; throws on malformed JSON so
 * the caller can surface the error to the user.
 */
export function parsedArgs(call: FunctionCall): Record<string, unknown> {
  if (!call.arguments) return {};
  return JSON.parse(call.arguments) as Record<string, unknown>;
}
