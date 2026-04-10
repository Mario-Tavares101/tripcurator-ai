/**
 * eval_01.ts — First eval: São Paulo briefing → Claude API → structured JSON validation
 *
 * Usage: npm run eval:01
 * Requires: ANTHROPIC_API_KEY env var
 *
 * Results are written to: evals/results/eval_01_result.json
 */

import Anthropic from '@anthropic-ai/sdk'
import { readFileSync, mkdirSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

// ── Load source files ──────────────────────────────────────────────────────

const tasteMd = readFileSync(resolve(root, 'docs/TASTE.md'), 'utf-8')
const schemaJson = readFileSync(resolve(root, 'docs/ITINERARY_SCHEMA.json'), 'utf-8')
const evalData = JSON.parse(readFileSync(resolve(root, 'evals/eval_01_sao_paulo.json'), 'utf-8'))

// ── Build system prompt (per docs/SYSTEM_PROMPT.md spec) ──────────────────

const outputInstructions = `
=== OUTPUT INSTRUCTIONS ===

You are TripCurator AI, a travel architect that creates deeply curated itineraries. You have the editorial sensibility described above and you must follow it in every recommendation.

TASK: Based on the user's trip briefing, generate a complete itinerary.

PROCESS:
1. Read the briefing carefully.
2. Detect the persona archetype (Disciple, Aesthetic Soul, Deep Diver, Night Wanderer) from the user's language and priorities. Do not ask — infer.
3. Detect the companion type (solo, couple, friends_group, family, family_with_kids).
4. Apply the Companion Filter if relevant.
5. Generate a day-by-day itinerary following the 1-1-1 Rule and Slow Flow principles.
6. Every day MUST include a morning_ritual.
7. Include at least one "happy_accident" buffer block per day.
8. For each recommendation, provide: soul_factor, grit_warning, local_order, the_anchor.
9. Include practical_notes for the whole trip.

CRITICAL RULES:
- Recommend REAL places that you are confident exist. Use specific names, not generic descriptions.
- If you are uncertain whether a place exists, still include it — the backend will validate via Google Places API.
- Do NOT fabricate history or chef names. If you don't know a place's specific story, focus on the neighborhood and cuisine type.
- Follow the 1-1-1 Rule strictly: max 1 major_anchor, 1 culinary_quest, 1 atmospheric_drift per day.
- Include transition_notes between blocks (walking time, driving time, transport mode).
- Budget estimates should be per person in local currency.
- Coordinates should be your best estimate — they will be corrected by Google Places.

OUTPUT FORMAT:
Respond ONLY with a valid JSON object. No markdown, no explanation, no preamble.
The JSON must conform to this schema:
${schemaJson}
`

const systemPrompt = `${tasteMd}\n${outputInstructions}`

// ── Run eval ───────────────────────────────────────────────────────────────

async function runEval() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`EVAL: ${evalData.eval_id}`)
  console.log(`Difficulty: ${evalData.difficulty}`)
  console.log(`Rationale: ${evalData.rationale}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('\nUSER BRIEFING:')
  console.log(evalData.user_briefing)
  console.log('\nExpected persona:       ', evalData.expected_persona)
  console.log('Expected companion type:', evalData.expected_companion_type)
  console.log('Expected budget tier:   ', evalData.expected_budget_tier)
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('Calling Claude API…')

  const client = new Anthropic()

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 16000,
    system: systemPrompt,
    messages: [{ role: 'user', content: evalData.user_briefing }],
  })

  console.log(`\nResponse content blocks: ${response.content.length}`)
  response.content.forEach((b, i) => console.log(`  [${i}] type=${b.type}`))

  // Extract text content block
  const textBlock = response.content.find(b => b.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error(`No text block in response. Block types: ${response.content.map(b => b.type).join(', ')}`)
  }

  console.log(`\nStop reason: ${response.stop_reason}`)
  console.log(
    `Tokens — input: ${response.usage.input_tokens}, output: ${response.usage.output_tokens}`,
  )

  // ── Parse JSON ───────────────────────────────────────────────────────────

  // Strip markdown fences if Claude added them despite instructions
  let rawText = textBlock.text.trim()
  if (rawText.startsWith('```')) {
    rawText = rawText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
  }

  let itinerary: unknown
  try {
    itinerary = JSON.parse(rawText)
  } catch (err) {
    console.error('\n✗ JSON PARSE FAILED')
    console.error('Raw response (first 500 chars):')
    console.error(rawText.slice(0, 500))
    throw err
  }

  // ── Validate structure ────────────────────────────────────────────────────

  const errors: string[] = []

  function check(condition: boolean, message: string) {
    if (!condition) errors.push(message)
  }

  const itin = itinerary as Record<string, unknown>

  check('trip_metadata' in itin, 'Missing: trip_metadata')
  check('traveler_profile' in itin, 'Missing: traveler_profile')
  check('days' in itin && Array.isArray(itin['days']), 'Missing or invalid: days array')

  if (Array.isArray(itin['days'])) {
    const days = itin['days'] as Array<Record<string, unknown>>

    check(days.length === 3, `Expected 3 days, got ${days.length}`)

    days.forEach((day, i) => {
      const label = `Day ${i + 1}`
      check('day_number' in day, `${label}: missing day_number`)
      check('morning_ritual' in day, `${label}: missing morning_ritual`)
      check('blocks' in day && Array.isArray(day['blocks']), `${label}: missing blocks array`)

      if (Array.isArray(day['blocks'])) {
        const blocks = day['blocks'] as Array<Record<string, unknown>>
        const hasHappyAccident = blocks.some(b => b['block_type'] === 'happy_accident')
        check(hasHappyAccident, `${label}: no happy_accident block`)

        blocks.forEach((block, j) => {
          const rec = block['recommendation'] as Record<string, unknown> | undefined
          if (rec) {
            check('soul_factor' in rec, `${label} block ${j + 1}: missing soul_factor`)
            check('grit_warning' in rec, `${label} block ${j + 1}: missing grit_warning`)
          }
        })
      }
    })
  }

  if ('trip_metadata' in itin) {
    const meta = itin['trip_metadata'] as Record<string, unknown>
    check('detected_persona' in meta, 'trip_metadata: missing detected_persona')
    check('companion_type' in meta, 'trip_metadata: missing companion_type')

    if (meta['detected_persona'] === evalData.expected_persona) {
      console.log(`\n✓ Persona correctly detected: ${meta['detected_persona']}`)
    } else {
      console.log(
        `\n~ Persona mismatch: expected ${evalData.expected_persona}, got ${meta['detected_persona']}`,
      )
    }

    if (meta['companion_type'] === evalData.expected_companion_type) {
      console.log(`✓ Companion type correctly detected: ${meta['companion_type']}`)
    } else {
      console.log(
        `~ Companion type mismatch: expected ${evalData.expected_companion_type}, got ${meta['companion_type']}`,
      )
    }
  }

  // ── Results ───────────────────────────────────────────────────────────────

  const passed = errors.length === 0

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  if (passed) {
    console.log('✓ SCHEMA VALIDATION PASSED — all required fields present')
  } else {
    console.log(`✗ SCHEMA VALIDATION FAILED — ${errors.length} issue(s):`)
    errors.forEach(e => console.log(`  • ${e}`))
  }

  // ── Save results ─────────────────────────────────────────────────────────

  const resultsDir = resolve(root, 'evals/results')
  mkdirSync(resultsDir, { recursive: true })

  const result = {
    eval_id: evalData.eval_id as string,
    timestamp: new Date().toISOString(),
    model: 'claude-sonnet-4-6',
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
    validation: {
      passed,
      errors,
      persona_match: (itinerary as Record<string, unknown> & { trip_metadata?: Record<string, unknown> })?.trip_metadata?.['detected_persona'] === evalData.expected_persona,
      companion_match: (itinerary as Record<string, unknown> & { trip_metadata?: Record<string, unknown> })?.trip_metadata?.['companion_type'] === evalData.expected_companion_type,
    },
    itinerary,
  }

  const outPath = resolve(resultsDir, 'eval_01_result.json')
  writeFileSync(outPath, JSON.stringify(result, null, 2))
  console.log(`\n→ Results saved to evals/results/eval_01_result.json`)

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('STRUCTURED JSON RESPONSE:')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
  console.log(JSON.stringify(itinerary, null, 2))
}

runEval().catch(err => {
  console.error('\nFATAL:', err)
  process.exit(1)
})
