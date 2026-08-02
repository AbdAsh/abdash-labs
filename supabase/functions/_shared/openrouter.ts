export interface Message { role: 'system' | 'user' | 'assistant'; content: string }

const BASE = 'https://openrouter.ai/api/v1/chat/completions'

function headers() {
  return {
    Authorization: `Bearer ${Deno.env.get('OPENROUTER_API_KEY')}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://labs.abdash.net',
    'X-Title': 'abdash labs',
  }
}

export async function chatStream(
  messages: Message[], model = Deno.env.get('MODEL_CHEAP')!,
): Promise<ReadableStream<Uint8Array>> {
  const res = await fetch(BASE, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ model, messages, stream: true }),
  })
  if (!res.ok || !res.body) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`)
  return res.body
}

/** Structured output with one retry. The retry re-sends the raw text and the
 *  parse error, which recovers far more often than a bare repeat of the prompt. */
export async function chatJSON<T>(
  messages: Message[], schema: object, model = Deno.env.get('MODEL_QUALITY')!,
): Promise<T> {
  const call = async (msgs: Message[]): Promise<string> => {
    const res = await fetch(BASE, {
      method: 'POST', headers: headers(),
      body: JSON.stringify({
        model, messages: msgs,
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
