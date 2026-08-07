export interface Message { role: 'system' | 'user' | 'assistant'; content: string }

const BASE = 'https://openrouter.ai/api/v1/chat/completions'

/**
 * Accepts either name.
 *
 * `OPENROUTER_API_KEY` is the convention here, but `OPENROUTER_KEY` is what the
 * provider's own dashboard suggests and what ends up in most `.env` files, so
 * the two get mixed up when secrets are set by hand. The failure mode is
 * miserable: a missing key produces a 401 from OpenRouter reading "Missing
 * Authentication header", which points at the request rather than at the
 * configuration and sends you looking in the wrong place.
 *
 * Missing entirely still throws — naming both spellings, so the fix is obvious.
 */
function apiKey(): string {
  const key = Deno.env.get('OPENROUTER_API_KEY') ?? Deno.env.get('OPENROUTER_KEY')
  if (!key) {
    throw new Error(
      'No OpenRouter key is configured. Set OPENROUTER_API_KEY (or OPENROUTER_KEY) ' +
        'as an Edge Function secret.',
    )
  }
  return key
}

/** Falls back rather than sending `undefined` as the model, which OpenRouter
 *  rejects with a message about the model rather than about the missing config. */
function model(envVar: string, fallback: string): string {
  return Deno.env.get(envVar) || fallback
}

function headers() {
  return {
    Authorization: `Bearer ${apiKey()}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://labs.abdash.net',
    'X-Title': 'abdash labs',
  }
}

export async function chatStream(
  messages: Message[], chatModel = model('MODEL_CHEAP', 'openai/gpt-4o-mini'),
): Promise<ReadableStream<Uint8Array>> {
  const res = await fetch(BASE, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ model: chatModel, messages, stream: true }),
  })
  if (!res.ok || !res.body) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`)
  return res.body
}

/** Structured output with one retry. The retry re-sends the raw text and the
 *  parse error, which recovers far more often than a bare repeat of the prompt. */
export async function chatJSON<T>(
  messages: Message[], schema: object, jsonModel = model('MODEL_QUALITY', 'openai/gpt-4.1'),
): Promise<T> {
  const call = async (msgs: Message[]): Promise<string> => {
    const res = await fetch(BASE, {
      method: 'POST', headers: headers(),
      body: JSON.stringify({
        model: jsonModel, messages: msgs,
        response_format: { type: 'json_schema', json_schema: { name: 'out', strict: true, schema } },
      }),
    })
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`)
    const body = await res.json()
    return body.choices[0].message.content as string
  }

  const first = await call(messages)
  try { return JSON.parse(first) as T }
  catch (e) {
    const repaired = await call([
      ...messages,
      { role: 'assistant', content: first },
      { role: 'user', content: `That was not valid JSON (${String(e)}). Return only valid JSON matching the schema.` },
    ])
    return JSON.parse(repaired) as T
  }
}
