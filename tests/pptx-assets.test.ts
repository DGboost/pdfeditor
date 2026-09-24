import assert from 'node:assert/strict'
import test from 'node:test'
import { captureAssets, restoreAssets } from '../vendor/pptist/src/embed/assets'
import { ownMediaURL, releaseMediaURLs } from '../vendor/pptist/src/embed/hostEvents'
import type { Slide } from '../vendor/pptist/src/types/slides'

test('PPTX checkpoints deduplicate cached media and preserve undo-restorable URLs until disposal', async () => {
  const first = ownMediaURL(new Blob(['video'], { type: 'video/mp4' }))
  const duplicate = ownMediaURL(new Blob(['video'], { type: 'video/mp4' }))
  const different = ownMediaURL(new Blob(['other'], { type: 'video/mp4' }))
  const payload = { slides: [{ elements: [
    { type: 'video', src: first },
    { type: 'video', src: duplicate },
    { type: 'video', src: different },
  ] }] as Slide[] }
  try {
    await captureAssets(payload)
    // A checkpoint omitting a deleted element must not invalidate undo's media.
    await captureAssets({ slides: [] })
    const captured = await captureAssets(payload)
    assert.equal(captured.assets.length, 2)
    const sources = captured.payload.slides[0].elements.map(element => 'src' in element ? element.src : '')
    assert.equal(sources[0], sources[1])
    assert.notEqual(sources[0], sources[2])
    const restored = restoreAssets(captured.payload, captured.assets)
    const contents = await Promise.all(restored.slides[0].elements.map(async element =>
      'src' in element ? (await fetch(element.src)).text() : '',
    ))
    assert.deepEqual(contents, ['video', 'video', 'other'])
    assert.equal(await (await fetch(first)).text(), 'video')
    const original = payload.slides[0].elements[0]
    assert.ok('src' in original)
    assert.equal(original.src, first)
  }
  finally { releaseMediaURLs() }
  await assert.rejects(fetch(first))
  await assert.rejects(captureAssets(payload))
})
