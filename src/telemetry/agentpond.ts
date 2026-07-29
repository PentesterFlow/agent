type ModelResult = {
  finishReason: string;
  message: {
    content: string;
    toolCalls?: unknown[];
  };
};

type ModelSpanOptions = {
  messageCount: number;
  model: string;
  provider: string;
  streaming: boolean;
  toolCount: number;
};

type AgentPondRuntime = {
  forceFlush: () => Promise<void>;
  spanStatusCode: {
    ERROR: number;
    OK: number;
  };
  tracer: {
    startActiveSpan<T>(
      name: string,
      options: { attributes: Record<string, boolean | number | string> },
      callback: (span: {
        end(): void;
        recordException(error: Error): void;
        setAttribute(name: string, value: string): void;
        setStatus(status: { code: number; message?: string }): void;
      }) => Promise<T>,
    ): Promise<T>;
  };
};

let runtimePromise: Promise<AgentPondRuntime> | undefined;

async function startRuntime(): Promise<AgentPondRuntime> {
  const [
    { createFilesSpanExporterFromRuntimeEnv },
    { trace, SpanStatusCode },
    { NodeSDK },
    { BatchSpanProcessor },
  ] = await Promise.all([
    import('@agentpond/files-sdk/otel'),
    import('@opentelemetry/api'),
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/sdk-trace-base'),
  ]);

  const processor = new BatchSpanProcessor(createFilesSpanExporterFromRuntimeEnv());
  const sdk = new NodeSDK({ spanProcessors: [processor] });
  sdk.start();

  return {
    forceFlush: () => processor.forceFlush(),
    spanStatusCode: SpanStatusCode,
    tracer: trace.getTracer('pentesterflow'),
  };
}

function getRuntime(): Promise<AgentPondRuntime> {
  runtimePromise ??= startRuntime();
  return runtimePromise;
}

/**
 * Trace one provider request when the operator explicitly enables AgentPond.
 * Only structural metadata is recorded so prompts, responses, targets, and
 * credentials remain out of the trace.
 */
export async function traceModelRequest<T extends ModelResult>(
  options: ModelSpanOptions,
  operation: () => Promise<T>,
): Promise<T> {
  if (process.env.AGENTPOND_ENABLED !== 'true') return operation();

  const runtime = await getRuntime();
  return runtime.tracer.startActiveSpan(
    `${options.provider}.chat`,
    {
      attributes: {
        'input.mime_type': 'application/json',
        'input.value': JSON.stringify({
          messageCount: options.messageCount,
          streaming: options.streaming,
          toolCount: options.toolCount,
        }),
        'llm.model_name': options.model,
        'llm.provider': options.provider,
        'openinference.span.kind': 'LLM',
      },
    },
    async (span) => {
      try {
        const result = await operation();
        span.setAttribute('output.mime_type', 'application/json');
        span.setAttribute(
          'output.value',
          JSON.stringify({
            contentCharacters: result.message.content.length,
            finishReason: result.finishReason,
            toolCallCount: result.message.toolCalls?.length ?? 0,
          }),
        );
        span.setStatus({ code: runtime.spanStatusCode.OK });
        return result;
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        span.recordException(normalized);
        span.setStatus({ code: runtime.spanStatusCode.ERROR, message: normalized.message });
        throw error;
      } finally {
        span.end();
        await runtime.forceFlush();
      }
    },
  );
}
