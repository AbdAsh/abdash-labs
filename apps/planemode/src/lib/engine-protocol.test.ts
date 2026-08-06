import { describe, it, expect } from 'vitest'
import { describeEngineError, isFatal, parseLoadProgress } from './engine-protocol'

/**
 * The strings below are copied verbatim from `@mlc-ai/web-llm@0.2.84`'s
 * `fetchTensorCacheInternal` and `asyncLoadWebGPUPipelines`. If a version bump
 * changes them these tests fail, which is the point: silently falling back to
 * "preparing" would put the progress bar back to being a spinner.
 */
describe('parseLoadProgress', () => {
  it('reads a fetch report as a download, with WebLLM’s own byte count', () => {
    const p = parseLoadProgress(
      'Fetching param cache[12/38]: 245MB fetched. 34% completed, 12 secs elapsed.' +
        ' It can take a while when we first visit this page to populate the cache.' +
        ' Later refreshes will become faster.',
      0.34,
    )

    expect(p.stage).toBe('downloading')
    expect(p.bytes).toBe(245 * 1024 * 1024)
    expect(p.fraction).toBeCloseTo(0.34)
  })

  // The distinction the whole screen rests on. WebLLM emits this phase after the
  // download finishes AND on every cached start, where nothing is fetched at
  // all. Calling it a download would tell a returning visitor they are paying
  // for the model twice.
  it('reads a cache-load report as loading, not downloading', () => {
    const p = parseLoadProgress('Loading model from cache[38/38]: 671MB loaded. 100% completed, 3 secs elapsed.', 1)

    expect(p.stage).toBe('loading')
    expect(p.stage).not.toBe('downloading')
    expect(p.bytes).toBe(671 * 1024 * 1024)
  })

  it('reads shader compilation as its own stage with no byte count', () => {
    const p = parseLoadProgress('Loading GPU shader modules[42/119]: 35% completed, 8 secs elapsed.', 0.35)

    expect(p.stage).toBe('compiling')
    expect(p.bytes).toBeNull()
  })

  it('reads the completion sentence as finished and pins the fraction to 1', () => {
    const p = parseLoadProgress('Finish loading on WebGPU - Apple M2', 1)

    expect(p.stage).toBe('finished')
    expect(p.fraction).toBe(1)
  })

  it('treats the opening report and anything unrecognised as preparing', () => {
    expect(parseLoadProgress('Start to fetch params', 0).stage).toBe('preparing')
    expect(parseLoadProgress('Something new in a future version', 0.5).stage).toBe('preparing')
  })

  it('keeps an unrecognised sentence rather than inventing one', () => {
    expect(parseLoadProgress('Something new in a future version', 0.5).text).toBe(
      'Something new in a future version',
    )
  })

  it('never reports a fraction outside 0..1, whatever WebLLM says', () => {
    // `fetchedBytes / totalBytes` is NaN before totalBytes is summed.
    expect(parseLoadProgress('Start to fetch params', Number.NaN).fraction).toBe(0)
    expect(parseLoadProgress('Start to fetch params', -1).fraction).toBe(0)
    expect(parseLoadProgress('Start to fetch params', 4).fraction).toBe(1)
  })

  it('falls back to a placeholder sentence for an empty report', () => {
    expect(parseLoadProgress('', 0).text).toBe('Starting…')
  })
})

describe('describeEngineError', () => {
  // The same failure reaches us worded differently depending on whether it came
  // from WebLLM, from TVM's runtime, or straight out of the WebGPU device.
  it.each([
    ['DeviceLostError: Device was lost.', 'gpu'],
    ['Device was lost', 'gpu'],
    ['Device lost, calling Instance.dispose()', 'gpu'],
    ['GPUDevice lost: destroyed', 'gpu'],
    ['Error: WebGPU adapter lost during reload', 'gpu'],
    ['RuntimeError: Out of memory', 'memory'],
    ['Buffer size 2147483648 exceeds the limit maxStorageBufferBindingSize', 'memory'],
    ['QuotaExceededError: Failed to execute ‘put’ on ‘Cache’', 'storage'],
    ['TypeError: Failed to fetch', 'network'],
    ['ContextWindowSizeExceededError: prompt tokens exceed context window', 'context'],
  ])('classifies %s as %s', (raw, kind) => {
    expect(describeEngineError(raw).kind).toBe(kind)
  })

  // A message that names a cause and stops there passes for an explanation and
  // still leaves the visitor with a dead app and nothing to press. Every branch,
  // including the one for failures this build has never seen, has to end with
  // something to do.
  it.each([
    'Device was lost',
    'Out of memory',
    'QuotaExceededError',
    'Failed to fetch',
    'ContextWindowSizeExceededError',
    'Kernel launch failed: wgsl compile of fused_dequant',
    '',
  ])('gives %s an actionable sentence, not just a diagnosis', (raw) => {
    const { message } = describeEngineError(raw)

    expect(message.length).toBeGreaterThan(40)
    // An imperative aimed at the reader, not a restatement of the fault.
    expect(message).toMatch(/\b(try|free|delete|close|reconnect|start|reload|choose)\b/i)
  })

  // Flattening an unknown error into "something went wrong" loses the only
  // clue anyone has when a new failure mode appears in the wild.
  it('keeps the original text for an unrecognised failure', () => {
    const { kind, message } = describeEngineError('Kernel launch failed: wgsl compile of fused_dequant')

    expect(kind).toBe('unknown')
    expect(message).toContain('wgsl compile of fused_dequant')
  })

  it('survives an empty message', () => {
    expect(describeEngineError('').kind).toBe('unknown')
    expect(describeEngineError('').message).not.toMatch(/undefined|null/)
  })

  it('marks GPU and memory failures fatal, and the recoverable ones not', () => {
    expect(isFatal('gpu')).toBe(true)
    expect(isFatal('memory')).toBe(true)
    expect(isFatal('network')).toBe(false)
    expect(isFatal('storage')).toBe(false)
    expect(isFatal('context')).toBe(false)
    expect(isFatal('unknown')).toBe(false)
  })
})
