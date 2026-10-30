import type { Config } from './config.ts';

// OpenAI-compatible chat completion (DeepSeek by default). Used only while designing a
// workflow, never while a workflow runs.

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

export async function chatJson(llm: Config['llm'], messages: ChatMessage[]): Promise<string> {
  if (!llm.apiKey) throw new Error('LLM_API_KEY is not set');
  const res = await fetch(`${llm.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${llm.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: llm.model,
      messages,
      temperature: 0,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`LLM request failed (${res.status}) ${(await res.text()).slice(0, 300)}`);
  const body: any = await res.json();
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('LLM returned no content');
  return content;
}
