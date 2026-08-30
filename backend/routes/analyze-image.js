import { Hono } from 'hono'
import { chatCompletion } from '../harness/llmClient.js'
import { CategoryService } from '../../src/services/CategoryService.js'
import { statusForError } from '../../src/repositories/errors.js'

const analyzeImage = new Hono()

analyzeImage.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  if (!body.imageBase64) return c.json({ error: 'imageBase64 is required' }, 400)

  try {
    const categories = await new CategoryService().list()
    const catList = categories.map(cat =>
      `- ${cat.name} (categoryId: ${cat.id}): ${(cat.requiredKeysConfig || [])
        .map(cfg => `${cfg.key} [${cfg.type}]`).join(', ') || 'no required characteristics'}`
    ).join('\n')

    const mimeType = body.mimeType || 'image/jpeg'
    const dataUrl = `data:${mimeType};base64,${body.imageBase64}`

    const response = await chatCompletion({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Identify the physical part in this image. Existing categories:\n${catList}\n\n` +
                `Respond with ONLY a JSON object: { "name": string, "categoryId": string|null, ` +
                `"attrs": { [key]: string }, "quantity": number|null, "reasoning": string }. ` +
                `Match categoryId exactly against the list above if a clear match exists, else null. ` +
                `For attrs, use every requiredKeysConfig key of the matched category, spelled exactly, ` +
                `filling values you can see and leaving unreadable ones as "". No prose, JSON only.`,
            },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    })

    const parsed = JSON.parse(response.content.replace(/```json|```/g, '').trim())
    return c.json({ success: true, result: parsed })
  } catch (err) {
    console.error('[analyze-image]', err)
    return c.json({ error: err.message ?? 'Analysis failed' }, statusForError(err))
  }
})

export default analyzeImage