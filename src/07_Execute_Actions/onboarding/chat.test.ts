// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins Sloane in conversation (voice.ts sloaneChat) and how the page wires it: talk on the
 * card goes to the page's mind with Sloane's framing and the turns so far, streams back screened by the 14A screen (a
 * refused word stops the model and shows nothing), never carries an action line (a conversation never acts), and ends
 * as `none` with the router's reason when no model answers, so the card says so plainly and offers the ways to get one
 * instead of sending scouts. The card reaches the model only through that Chat (never a Mind), App hands it the picker,
 * the browser's refusal and why the app's own model couldn't start (in place of the site's and the browser's hints,
 * only while that model is what answers, and on a computer still with the line about starting a model server), and
 * the brief's rewording never asks while the model this page, or the app, would answer with is still to be loaded (an
 * answer's stop ends its load, so the 4 s rewording used to kill every load it started).
 * What breaks if it is removed? Small talk could fall back to the scouts and a flat "not yet", a model's reply could be
 * shown unscreened or act, or the rewording could go back to killing the in-page model while it loads.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { AnswerRequest, Mind, Piece } from '../operator.ts'
import { CHAT_MAX, CHAT_TURNS, SCRIPTED_CHOSEN, chatPrompt, chatSoFar, chatWords, phaseLine, sloaneChat, type ChatTurn } from './voice.ts'

const SRC = fileURLToPath(new URL('../..', import.meta.url))
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8')

/** A failure the router would throw (localCompute.ts CognitionError), by its code. */
const failure = (code: string, message: string): Error => Object.assign(new Error(message), { code })

/** A mind that streams `say` word by word, or in the pieces given (noting each request and whether it was stopped), fails, or hangs until stopped. */
function mindOf(say: string | readonly string[] | Error | 'hang', o: { standIn?: string } = {}) {
  const asked: AnswerRequest[] = []
  const seen = { stopped: false, pieces: 0 }
  const mind = {
    answer: async (req: AnswerRequest, onPiece: (p: Piece) => void) => {
      asked.push(req)
      req.signal.addEventListener('abort', () => { seen.stopped = true }, { once: true })
      if (say instanceof Error) throw say
      if (say === 'hang') return new Promise((_, reject) => { req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true }) })
      for (const w of typeof say === 'string' ? say.split(/(?<= )/) : say) {
        if (req.signal.aborted) throw req.signal.reason
        seen.pieces++
        onPiece({ kind: 'text', text: w })
        await Promise.resolve()
      }
      if (req.signal.aborted) throw req.signal.reason
      return { text: typeof say === 'string' ? say : say.join(''), thinking: 0, tokens: 1, reason: 'stop', ...(o.standIn !== undefined && { standIn: o.standIn }) }
    },
  }
  return { mind: mind as unknown as Mind, asked, seen }
}

const you = (text: string): ChatTurn => ({ who: 'you', text })
const live = () => new AbortController().signal

test('sloaneChat: the person\'s words go to the mind with Sloane\'s framing and the turns so far, and the reply streams back', async () => {
  const m = mindOf('Going well, thanks for asking! The streets are calm tonight.')
  const parts: string[] = []
  const turns: ChatTurn[] = [you('hi'), { who: 'sloane', text: 'Hello there.' }, you("how's it going")]
  const r = await sloaneChat(m.mind).reply(turns, live(), (s) => parts.push(s))
  assert.deepEqual(r, { kind: 'said', text: 'Going well, thanks for asking! The streets are calm tonight.' })
  assert.equal(m.asked.length, 1)
  assert.deepEqual(m.asked[0]!.tethers, [], 'nobody is tethered: Sloane speaks as the city\'s guide')
  const prompt = m.asked[0]!.prompt
  assert.equal(prompt, chatPrompt(turns))
  assert.match(prompt, /^You are Sloane, the concierge of Crimson Noir: Agent City/)
  assert.match(prompt, /never write an ACTION line/)
  assert.ok(prompt.endsWith("Person: hi\nSloane: Hello there.\nPerson: how's it going\nSloane:"))
  assert.ok(parts.length > 1, 'the words arrive as they come')
  assert.equal(parts.at(-1), 'Going well, thanks for asking! The streets are calm', 'whole words only while it streams: the last may still be growing')
  // Only the last CHAT_TURNS turns are shown to the model, each cut short.
  const long = Array.from({ length: 20 }, (_, i) => you(`turn ${i} ${'x'.repeat(500)}`))
  const shown = chatPrompt(long)
  assert.equal((shown.match(/^Person: /gm) ?? []).length, CHAT_TURNS)
  assert.doesNotMatch(shown, /turn 11 /)
  assert.match(shown, /Person: turn 12 x{392}\n/, 'each turn cut to 400 characters')
  assert.doesNotMatch(shown, /x{401}/)
})

test('sloaneChat: an action line is cut and the model stopped, a long reply is cut at a sentence, an echoed name is dropped', async () => {
  const acting = mindOf('Sure, I can make it night for you.\nACTION: time 22 and more words after')
  const r = await sloaneChat(acting.mind).reply([you('make it night')], live())
  assert.deepEqual(r, { kind: 'said', text: 'Sure, I can make it night for you.' })
  assert.equal(acting.seen.stopped, true, 'the model is stopped at the action line')
  assert.equal(chatWords('Sloane: Hi there.'), 'Hi there.')
  assert.equal(chatWords('  Two\n\nlines  '), 'Two lines')
  const story = `${'This is a sentence about the city. '.repeat(30)}`
  const rambler = mindOf(story)
  const cut = await sloaneChat(rambler.mind).reply([you('tell me a story')], live())
  assert.equal(cut.kind, 'said')
  const text = cut.kind === 'said' ? cut.text : ''
  assert.ok(text.length <= CHAT_MAX && text.length > CHAT_MAX / 2, String(text.length))
  assert.ok(text.endsWith('city.'), 'at the last sentence end')
  assert.equal(rambler.seen.stopped, true, 'and the model stopped there')
  assert.ok(rambler.seen.pieces < story.split(' ').length)
  assert.match(chatWords('x'.repeat(CHAT_MAX + 50)), /^x{600}…$/, 'no sentence end: cut with an ellipsis')
})

test('sloaneChat: a word the 14A screen refuses stops the model and shows nothing; no model, a timeout, a failure and the scripted provider each say why', async () => {
  const refused = mindOf('Sure, here is a bowl of punch for everyone at the party tonight.')
  const parts: string[] = []
  assert.deepEqual(await sloaneChat(refused.mind).reply([you('party?')], live(), (s) => parts.push(s)), { kind: 'held' })
  assert.equal(refused.seen.stopped, true)
  assert.ok(parts.every((p) => !/punch/.test(p)), 'the refused word is never shown')
  const why = 'no model is answering on this machine (looked for Ollama at http://localhost:11434): start one, or choose one with ask provider <name>'
  assert.deepEqual(await sloaneChat(mindOf(failure('offline', why)).mind).reply([you('hi')], live()), { kind: 'none', why })
  assert.deepEqual(await sloaneChat(mindOf(failure('timeout', 'the model said nothing for 300 s')).mind).reply([you('hi')], live()), { kind: 'slow', why: 'the model said nothing for 300 s' }, 'which wait ran out, in the runtime\'s words')
  assert.deepEqual(await sloaneChat(mindOf(failure('server', 'the server answered 500')).mind).reply([you('hi')], live()), { kind: 'failed', why: 'the server answered 500' })
  assert.deepEqual(await sloaneChat(mindOf('').mind).reply([you('hi')], live()), { kind: 'failed', why: 'the model said nothing' })
  assert.deepEqual(await sloaneChat(mindOf('scripted words', { standIn: 'the model did not answer' }).mind).reply([you('hi')], live()), { kind: 'none', why: 'the model did not answer' })
  const idle = mindOf('hello')
  assert.deepEqual(await sloaneChat(idle.mind, () => false).reply([you('hi')], live()), { kind: 'none', why: SCRIPTED_CHOSEN })
  assert.deepEqual(await sloaneChat(idle.mind, () => { throw new Error('no settings') }).reply([you('hi')], live()), { kind: 'none', why: SCRIPTED_CHOSEN })
  assert.equal(idle.asked.length, 0, 'the scripted provider is never asked to chat')
  // A turn that went (a newer one, the card's host gone): nothing asked, or the ask stopped.
  const gone = new AbortController()
  gone.abort()
  assert.equal((await sloaneChat(idle.mind).reply([you('hi')], gone.signal)).kind, 'failed')
  assert.equal(idle.asked.length, 0)
  const hang = mindOf('hang')
  const stop = new AbortController()
  const pending = sloaneChat(hang.mind).reply([you('hi')], stop.signal)
  await Promise.resolve()
  stop.abort()
  assert.deepEqual(await pending, { kind: 'failed', why: 'stopped' })
  assert.equal(hang.seen.stopped, true)
})

test('sloaneChat shows whole words only while it streams: a word cut in pieces is never shown or screened in part', async () => {
  // A refused word split across pieces: no fragment of it reaches the card, and the reply is held.
  const split = mindOf(['Honestly, you', ' mother', 'f', 'ucker', ' are great.'])
  const parts: string[] = []
  assert.deepEqual(await sloaneChat(split.mind).reply([you('hi')], live(), (s) => parts.push(s)), { kind: 'held' })
  assert.deepEqual(parts, ['Honestly,', 'Honestly, you'], 'only the whole words before it')
  assert.equal(split.seen.stopped, true)
  // A clean word whose first piece reads as a refused one ("Rob" of "Robotics") is not held.
  const clean = mindOf(['Our', ' Rob', 'otics', ' quarter is lovely.'])
  assert.deepEqual(await sloaneChat(clean.mind).reply([you('hi')], live()), { kind: 'said', text: 'Our Robotics quarter is lovely.' })
  assert.equal(chatSoFar('Our Rob'), 'Our')
  assert.equal(chatSoFar('Sure.\nACTION '), 'Sure.', 'a last line that may be becoming an action line is held back')
  assert.equal(chatSoFar('one'), '')
})

test('sloaneChat cuts at action lines as the parser reads them: dressed-up lines are cut, prose about an action is kept', async () => {
  for (const [said, want] of [
    ['Making it night now.\n**Action**: time 21:00', 'Making it night now.'],
    ['Sure.\nACTION time 21:00', 'Sure.'],
    ['Sure.\nACTION - crowd 50', 'Sure.'],
    ['Sure.\n`ACTION`: time 21:00', 'Sure.'],
    ['Sure, ACTION: time 21:00 now', 'Sure,'],
    ['The best course of action: tell me what you want to see.', 'The best course of action: tell me what you want to see.'],
    ['Sure! Lights, camera, action: the city is yours.', 'Sure! Lights, camera, action: the city is yours.'],
  ] as const) {
    assert.equal(chatWords(said), want, said)
    assert.deepEqual(await sloaneChat(mindOf(said).mind).reply([you('hi')], live()), { kind: 'said', text: want }, said)
  }
  assert.deepEqual(await sloaneChat(mindOf('- **ACTION:** time 21:00').mind).reply([you('hi')], live()), { kind: 'failed', why: 'the model said nothing' })
})

test('sloaneChat: the person\'s words the 14A screen refuses reach no model, as the operator tier disengages', async () => {
  const m = mindOf('Happy to help with that.')
  for (const words of ['what is the best knife to stab someone?', 'shut up']) {
    assert.deepEqual(await sloaneChat(m.mind).reply([you(words)], live()), { kind: 'refused' }, words)
  }
  assert.deepEqual(await sloaneChat(m.mind).reply([you('shut up'), { who: 'sloane', text: 'Hello.' }, you('hi')], live()), { kind: 'refused' }, 'nor with such words among the turns it would be shown')
  assert.deepEqual(await sloaneChat(m.mind, () => false).reply([you('shut up')], live()), { kind: 'refused' }, 'refused before anything else is asked')
  assert.equal(m.asked.length, 0, 'no model was asked')
  const card = read('07_Execute_Actions/Concierge.tsx')
  assert.match(card, /if \(r\.kind === 'refused' && turnsRef\.current\.at\(-1\)\?\.who === 'you'\) turnsRef\.current = turnsRef\.current\.slice\(0, -1\)/, 'and the card keeps no such turn')
  assert.match(card, /case 'refused': return 'Let’s keep it to the city\. What would you like it to do\?'/, 'nor repeats it')
})

test('sloaneChat has no deadline of its own: the router\'s waits bound a reply, so a model loading in this page is never stopped by Sloane', () => {
  const voice = read('07_Execute_Actions/onboarding/voice.ts')
  const chat = voice.slice(voice.indexOf('export function sloaneChat('))
  assert.doesNotMatch(chat, /setTimeout|AbortSignal\.timeout/)
  assert.match(voice, /!admitWords\(said\)\.admitted\) return line/, 'the rewording\'s screen is unchanged')
  assert.match(chat, /if \(!admitWords\(words\)\.admitted\) \{/, 'every partial is screened')
  assert.match(chat, /if \(!admitWords\(said\)\.admitted\) return \{ kind: 'held' \}/, 'and the whole reply')
})

test('sloaneChat asks as a conversation (the short talk prompt) and tells the card the request\'s own phase until its first word', async () => {
  // A mind that reports the request's phase as the model in this page does, then hangs until stopped.
  const asked: AnswerRequest[] = []
  const hanging = {
    answer: (req: AnswerRequest) => {
      asked.push(req)
      return new Promise<never>((_, reject) => { req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true }) })
    },
  } as unknown as Mind
  const seen: (string | null)[] = []
  const stop = new AbortController()
  const r = sloaneChat(hanging).reply([you('hire an agent')], stop.signal, undefined, (p) => seen.push(p))
  await Promise.resolve()
  assert.equal(asked.length, 1)
  assert.equal(asked[0].talk, true, 'a conversation, so every provider sends the talk prompt')
  assert.deepEqual(asked[0].tethers, [], 'bound to no one')
  const phase = asked[0].onPhase
  assert.equal(typeof phase, 'function', 'the phase is the request\'s own, so no other answer\'s progress reaches the card')
  for (const p of ['waiting for the model to finish another answer', null, 'loading the model in this page', 'reading the prompt 25%', 'reading the prompt 25%', 'reading the prompt 50%']) phase!(p)
  stop.abort()
  assert.deepEqual(await r, { kind: 'failed', why: 'stopped' })
  assert.deepEqual(seen, ['waiting for the model to finish another answer', null, 'loading the model in this page', 'reading the prompt 25%', 'reading the prompt 50%', null], 'each change once, cleared at the end')

  // The first word clears the phase, and nothing reported after it reaches the card.
  const said: (string | null)[] = []
  const talking = {
    answer: async (req: AnswerRequest, onPiece: (p: Piece) => void) => {
      req.onPhase?.('reading the prompt 90%')
      onPiece({ kind: 'text', text: 'All good here, ' })
      req.onPhase?.('reading the prompt 95%')
      onPiece({ kind: 'text', text: 'the streets are calm.' })
      return { text: 'All good here, the streets are calm.', thinking: 0, tokens: 2, reason: 'stop' }
    },
  } as unknown as Mind
  const done = await sloaneChat(talking).reply([you('how is it going')], live(), undefined, (p) => said.push(p))
  assert.equal(done.kind, 'said')
  assert.deepEqual(said, ['reading the prompt 90%', null])

  // A card line that throws never costs the reply; a mind that reports no phase tells the card nothing.
  const sturdy = await sloaneChat(talkingThrough('Fine, thanks.')).reply([you('hi')], live(), undefined, () => { throw new Error('the card went') })
  assert.deepEqual(sturdy, { kind: 'said', text: 'Fine, thanks.' })
  const plain: (string | null)[] = []
  assert.equal((await sloaneChat(mindOf('Fine.').mind).reply([you('hi')], live(), undefined, (p) => plain.push(p))).kind, 'said')
  assert.deepEqual(plain, [])
})

/** A mind that reports a phase, then says `text` whole. */
function talkingThrough(text: string): Mind {
  return {
    answer: async (req: AnswerRequest, onPiece: (p: Piece) => void) => {
      req.onPhase?.('loading the model in this page')
      onPiece({ kind: 'text', text })
      return { text, thinking: 0, tokens: 1, reason: 'stop' }
    },
  } as unknown as Mind
}

test('the phase line: the prompt read as the conversation with its share, the load as it is, anything else as the runtime says it', () => {
  assert.equal(phaseLine('reading the prompt 42%'), 'Reading the conversation · 42%')
  assert.equal(phaseLine('reading the prompt 100%'), 'Reading the conversation · 100%')
  assert.equal(phaseLine('loading the model in this page'), 'Loading the model in this page…')
  // The model the app runs itself (09_Cognition/nativeMind.ts): its first-run check with its share, its load.
  assert.equal(phaseLine('loading the model in the app'), 'Loading the model inside the app…')
  assert.equal(phaseLine('preparing the model in the app 1%'), 'Preparing the model inside the app · 1%')
  assert.equal(phaseLine('preparing the model in the app 100%'), 'Preparing the model inside the app · 100%')
  assert.equal(phaseLine('waiting for the model to finish another answer'), 'Waiting for the model to finish another answer')
  assert.equal(phaseLine('thinking'), 'Thinking')
  assert.equal(phaseLine(''), '')
})

test('the card: talk goes to the Chat (never a Mind), streams onto the card, is said once whole, and no model is said plainly with the ways to get one', () => {
  const card = read('07_Execute_Actions/Concierge.tsx')
  assert.doesNotMatch(card, /\bMind\b/)
  assert.equal((card.match(/\.answer\(/g) ?? []).length, 2, 'the person\'s own answers only')
  assert.match(card, /chat\.reply\(asking\.turns, ctl\.signal, \(soFar\) => put\(\{ text: soFar \}\), \(phase\) => put\(\{ phase: phase \?\? '' \}\)\)/, 'the reply streams onto the card, and so does what the model is doing before its first word')
  assert.match(card, /\{talking && talk\?\.state === 'waiting' && !talk\.text && talk\.phase && \(\n\s*<p [^>]*data-model-phase>\{phaseLine\(talk\.phase\)\}<\/p>/, 'the wait is shown while nothing is said yet, never under a reply')
  assert.match(card, /why: r\.kind === 'none' \|\| r\.kind === 'failed' \|\| r\.kind === 'slow' \? r\.why : ''/, 'a slow reply says which wait ran out')
  assert.match(card, /if \(!reword \|\| !b \|\| b\.chat\) return/, 'talk is never reworded')
  assert.match(card, /if \(brief\?\.chat\) \{\n\s*talkOn\(brief\.goal\)/, 'talk applies nothing and sends nobody: it is the next turn')
  assert.match(card, /advance\(new FiveWhys\(goalText, \{ chatting \}\), \[\]\)/)
  assert.match(card, /else startGoal\(text, dialogue\.brief\?\.chat === true\)/, 'in a conversation, what maps to nothing is its next turn')
  assert.match(card, /const spoken = talking \? \(talk && talk\.state !== 'waiting' \? talkLine\(talk\) : ''\) : spokenLine\(/, 'said once whole, never as it streams')
  assert.match(card, /const NO_MODEL_LINE = 'No language model is answering this page yet, so I can’t chat\. I can still change the city for you: try “make it night”\.'/)
  assert.match(card, /data-action="model-file"/)
  assert.match(card, /Choose a model file/)
  assert.match(card, /Qwen2\.5 0\.5B Instruct at Q4_K_M, about 0\.4 GB/)
  assert.match(card, /Or start Ollama, LM Studio or a llama\.cpp server on this computer and ask again/)
  assert.match(card, /in OLLAMA_ORIGINS/, 'a page Ollama refuses by default says how to allow it')
  // Where the app runs its own model and it could not start: its reason in place of the site's and the browser's hints
  // only, said only while that model is what answers (the provider auto or native, never another one chosen), and the
  // line about starting a model server kept wherever one can run beside the app (a computer, not a phone or tablet).
  assert.match(card, /const app = talk\?\.state === 'none' && appModel !== null && appModel\.blamed\(\) \? appModel : null/)
  assert.match(card, /\{app \? `\$\{appHint\(app\.why\)\} ` : site \? siteHint\(site, from\) : onPickModel && !noPageModel \? `\$\{SMALL_MODEL_HINT\} ` : noPageModel \? /, 'in place of the site\'s and the browser\'s hints')
  assert.match(card, /\{\(!app \|\| app\.servers\) && \(<>\n\s*Or start Ollama, LM Studio or a llama\.cpp server on this computer and ask again/, 'still said on a computer')
  assert.match(card, /return `The model inside this app couldn’t start: \$\{why\.replace\(\/\[\.\\s\]\+\$\/, ''\)\}\.`/)
  assert.match(card, /const open = view === 'goal' && \(!dialogue\.brief \|\| dialogue\.brief\.chat === true\)/, 'words heard while the conversation is open are its next turn')
  // A second message never cuts short a reply still on its way (a model loading in this page for it would load again):
  // the next turn waits for it, or for the person's own Stop, and the chip opens the conversation as it stands.
  assert.match(card, /if \(dialogue\.brief\?\.chat && replying\) \{\n\s*setDraft\(\(d\) => \(d\.trim\(\) \? d : text\)\)/, 'a heard line waits in the field')
  assert.match(card, /if \(brief\?\.chat && replying\) \{\n\s*setDraft\(brief\.goal\)\n\s*return/, 'however talk arrives')
  assert.match(card, /else if \(dialogue\.brief\?\.chat && replying\) \{[^}]*openGoal\(\)\n\s*setDraft\(said\)/, '"Sloane, …" from the chip too')
  assert.match(card, /disabled=\{replying\}/)
  assert.match(card, /data-action="stop"/)
  assert.match(card, /if \(dialogue\.brief\?\.chat && \(replying \|\| unseen \|\| \(getting !== null && \(job\?\.how === 'tap' \|\| talk\?\.state === 'none'\)\) \|\| \(!whySeen && talk\?\.state === 'none'\)\)\) \{\n\s*open\('goal'\)/, 'a reply that came while the card was away is shown when it opens (and a download tapped there or shown in it, or one that ended short meanwhile, keeps the conversation; the page\'s own download alone does not)')
  assert.match(card, /const refocus = \(\) => \{\n\s*focusNext\.current = true/, 'Stop and Ask again hand focus back to the field')
})

test('App: the card gets Sloane\'s conversation, the picker, the browser\'s refusal and why the app\'s model couldn\'t start; the rewording waits for a model file, or the app\'s model, to be loaded', () => {
  const src = read('App.tsx')
  assert.match(src, /setSloaneTalk\(sloaneChat\(mind, \(\) => local\.settings\(\)\.provider !== 'scripted'\)\)/)
  assert.match(src, /chat=\{sloaneTalk\}\s*onPickModel=\{onModelFile\}\s*noPageModel=\{PAGE_MODEL_REFUSAL\(\)\}/)
  // Why the app's own model couldn't start, as its mind hears it (09_Cognition/nativeMind.ts onFailed): blamed only
  // while it is what answers, the server line kept where the device is no phone or tablet.
  assert.match(src, /siteModel=\{siteModel\}\s*appModel=\{appModel\}/)
  assert.match(src, /onFailed: \(why\) => setAppModel\(\(was\) => why === null \? null : was\?\.why === why \? was : \{\n\s*why,\n\s*servers: !e\.profile\.mobile,\n\s*blamed: \(\) => local\.provider === 'auto' \|\| local\.provider === 'native',\n\s*\}\),/)
  assert.match(src, /setSiteModel\(null\)\n\s*setAppModel\(null\)/, 'a city that goes takes the reason with it')
  // The rewording never asks while the model the app runs itself is still to be loaded (it would be the answer that
  // loads it): asked of that mind (nativeMind.ts cold), the one the router was handed.
  assert.match(src, /native: \(\) => \(appMind = createNativeMind\(\{\n\s*host: shellRunner\(\),/)
  assert.match(src, /const s = local\.settings\(\)\n(\s*\/\/[^\n]*\n)*\s*if \(s\.provider === 'native' \|\| \(s\.provider === 'auto' && s\.found === 'native'\)\) return appMind\.cold\(\)\n\s*if \(s\.provider === 'inpage'\) return inPage\.cold\(true\)/)
  assert.match(src, /if \(s\.provider === 'inpage'\) return inPage\.cold\(true\)/)
  assert.match(src, /if \(s\.provider !== 'auto' \|\| \(!inPage\.cold\(false\) && !\(s\.found === undefined && appMind\.cold\(\)\)\)\) return false/)
  assert.match(src, /inPageMind = inPage\n(\s*\/\/[^\n]*\n)*\s*void appMind\.installed\(\)\.catch\(\(\) => \[\]\)/, 'asked once as the router is built')
  assert.match(src, /return s\.found === undefined \|\| s\.found === 'inpage'/, 'under auto, only while the file is what would answer')
  assert.match(src, /setSloane\(null\)\n\s*setSloaneTalk\(null\)/, 'a city that goes takes the conversation with it')
})

test('the card: the site\'s model is offered when no model answers, got in one tap with progress and Stop, and the last turn is asked again', () => {
  const card = read('07_Execute_Actions/Concierge.tsx')
  assert.match(card, /import type \{ SiteModelFrom, SiteModelHost, SiteModelLine, SiteModelProgress \} from '\.\.\/09_Cognition\/siteModel\.ts'\nimport type \{ SiteJobState \} from '\.\.\/09_Cognition\/siteJob\.ts'/, 'only the types: the card fetches nothing')
  assert.doesNotMatch(card, /\bfetch\s*\(/)
  assert.match(card, /const offering = talk\?\.state === 'none' && siteModel !== null && !noPageModel/, 'offered only when no model answers, where this browser can run one')
  assert.match(card, /siteModel\.offer\(\)\.then\(/, 'the card asks the manifest when it first offers it (the page\'s own start is App\'s)')
  assert.match(card, /data-action="site-model"/)
  assert.match(card, /\{site\.kept \? 'Use the model kept here' : `Get the model · \$\{site\.size\}`\}/, 'the button says the size before anything is downloaded')
  // One job a page (siteJob.ts), whoever started it: the card reads it, the tap starts it, the Stop stops it.
  assert.match(card, /const job = useSyncExternalStore\(siteModel\?\.job\.subscribe \?\? NO_SUBSCRIBE, siteModel\?\.job\.state \?\? NO_JOB, NO_JOB\)/)
  assert.match(card, /const getting: SiteModelProgress \| null = job\?\.phase === 'running' \? job : null/)
  assert.match(card, /const gotWhy = job\?\.phase === 'failed' \? job\.why : ''/)
  assert.match(card, /const getSite = \(\) => \{\n\s*if \(!siteModel \|\| getting\) return\n\s*refocusKeys\(\)\n\s*void siteModel\.job\.start\('tap'\)/)
  assert.match(card, /const stopGetting = \(\) => \{\n\s*if \(siteModel\?\.job\.stop\('person'\)\) refocusKeys\(\)/, 'a Stop after the hand-off does nothing: siteJob.ts stop refuses it, and the copy runs to its end')
  assert.doesNotMatch(card, /getCtl|handed\.current/, 'the card holds no download of its own: a card that goes leaves the page\'s job running (the city\'s end stops it)')
  assert.match(card, /role="progressbar"/)
  assert.match(card, /\{getting\.step === 'download' && <button type="button" onClick=\{stopGetting\} className=\{link\} aria-label=\{`Stop getting \$\{SLOANE\.name\}’s model`\} data-action="stop-model">Stop<\/button>\}/, 'Stop while it downloads, named apart from the reply\'s Stop; the copy into the page runs to its end')
  // Each job's end is met once, whoever started it: a conversation still on the card is asked again.
  assert.match(card, /if \(!job \|\| job\.phase === 'running' \|\| job\.id === endMet\.current\) return\n\s*endMet\.current = job\.id\n\s*meetEnd\(job\)\n\s*\}, \[job\]\)/)
  assert.match(card, /if \(onChat\.current && talk\?\.state === 'none' && turnsRef\.current\.at\(-1\)\?\.who === 'you'\) \{\n\s*setStarting\(true\)\n\s*askTurns\(turnsRef\.current\)/, 'the last turn is asked again once the model is kept, only while the card is still on that conversation and it found no model (a reply on its way, stopped or held is left alone)')
  assert.match(card, /if \(end\.how === 'tap'\) refocusAtEnd\(\)/, 'only the visitor\'s own tap brings focus back to the field')
  assert.match(card, /useEffect\(\(\) => \{ onChat\.current = dialogue\.brief\?\.chat === true \}\)/, 'read when the download ends, not from the render that started it')
  assert.match(card, /\}, \[offering, fetchingSite, noneOf, siteModel\]\)/, 'the offer is asked again at each conversation with no model and after each try, so "kept" is never stale and a site out of reach once is asked again')
  assert.match(card, /downloaded once from this site, checked against the copy this page was built for, and kept in this browser \(Apache-2\.0\)/)
  // The Windows app's model is beside the app already: the card says it is copied from the app, not downloaded.
  assert.match(card, /const from: SiteModelFrom = siteModel\?\.from \?\? 'site'/)
  assert.match(card, /it came with this app, and is checked against the copy the app was built for and kept in this page \(Apache-2\.0\)/)
  assert.match(card, /const verb = from === 'site' \? 'Downloading' : `Copying from \$\{copiedFrom\(from\)\}`/)
  // The NixOS package's model is on this machine too: copied from the launcher that serves it, kept in the browser.
  assert.match(card, /return from === 'launcher' \? 'the launcher' : 'the app'/)
  assert.match(card, /it came with this package and is served by its launcher on this machine, checked against the copy this page was built for, and kept in this browser \(Apache-2\.0\)/)
  assert.equal(card.match(/from === 'site' \? (?:'Downloading the model'|`Downloading \$\{SLOANE\.name\}’s model`) : `Copying (?:the|\$\{SLOANE\.name\}’s) model from \$\{copiedFrom\(from\)\}`/g)?.length, 2, 'both bars name where it is copied from')
  assert.equal(card.match(/\{gettingLine\(getting, from\)\}/g)?.length, 2, 'the conversation and the card\'s foot both say where it comes from')
  assert.match(card, /<p role="status"[^>]*data-site-why>/, 'why it ended short is said on the card, and announced')
  assert.match(card, /const whySeen = !\(job\?\.phase === 'failed' && job\.how === 'tap' && job\.id !== whySeenId\)/, 'only a tapped try that ended short keeps the conversation open for its reason')
  assert.match(card, /const refocusKeys = \(\) => \{\n\s*if \(family !== 'touch'\) refocus\(\)/, 'focus goes back to the field after the offer, Stop or the end of a download, never on touch')
  assert.match(card, /if \(!a \|\| a === document\.body \|\| cardRef\.current\?\.contains\(a\)\) refocusKeys\(\)/, 'a download that ends never takes focus from a control elsewhere')
  // Shown wherever Sloane is: her chip carries a hairline of it that keeps the chip's size (its line and Stop are on the
  // card), and the card's other views carry it at their foot.
  assert.match(card, /const bar = getting && \(\n\s*<span role="progressbar" aria-label=\{stripLine\(getting\)\}[^>]*\n\s*className=\{`pointer-events-none absolute inset-x-4 bottom-0 [^`]*`\} data-site-bar=\{getting\.step\}>/, 'the chip\'s hairline, drawn over the pill')
  assert.match(card, /\{pending \? \(\n\s*<button ref=\{chipRef\}[^\n]*\n\s*\{ask\}\n\s*\{bar\}\n\s*<\/button>\n\s*\) : \(\n\s*<div ref=\{chipRef\}[^\n]*\n\s*\{buttons\}\n\s*\{bar\}/, 'the chip\'s buttons are the same elements with or without it (no focus lost, no entry played again)')
  assert.doesNotMatch(card, /const pill = [^\n]*getting/, 'the chip keeps its size while it downloads (the touch buttons below keep their room)')
  assert.match(card, /\{getting && !\(talking && talk\?\.state === 'none'\) && \(\n\s*<div className=\{`[^`]*`\} data-site-strip=\{getting\.step\}>/, 'the card\'s foot, where the conversation does not show it already')
})

test('App: the site\'s model is fetched from the page\'s own folder only, after the browser, the device and the storage have said yes, and kept as a picked file is', () => {
  const src = read('App.tsx')
  assert.match(src, /const siteFetch: SiteFetch = \(path, init\) => window\.fetch\(siteUrl\(path, window\.location\.href\), init\)/)
  const get = src.slice(src.indexOf('const siteJob = createSiteJob(async (how, onProgress, signal) => {'), src.indexOf('const siteHost = Object.freeze<SiteModelHost>({'))
  assert.ok(get.length > 100, 'the job\'s work is found')
  const order = ['PAGE_MODEL_REFUSAL()', 'if (keeping || fetching)', 'fetching = true', 'await keptSite()', 'await inPage.installed()', 'await siteRefusal()', 'fetchSiteModel(source.fetch, pin,', 'return keepPicked([file],']
  const at = order.map((n) => get.indexOf(n))
  at.forEach((i, k) => assert.ok(i >= 0, `${order[k]} is in the job's work`))
  for (let k = 1; k < at.length; k++) assert.ok(at[k - 1] < at[k], `${order[k - 1]} comes before ${order[k]}`)
  const refusal = src.slice(src.indexOf('const siteRefusal = async (): Promise<string | null> => {'), src.indexOf('const siteJob = createSiteJob('))
  assert.match(refusal, /fits\(\[\{ name: pin\.file, bytes: pin\.bytes \}\], env, placement\(env\)\)/, 'the device\'s limits')
  assert.match(refusal, /roomRefusal\(pin\.bytes, room\)/, 'and the storage\'s room')
  // One source a build: the Windows app's own model through the shell, else the NixOS launcher's beside its page, else
  // the web copy's site.
  assert.match(src, /const shellFetch = shellModelFetch\(APP_MODEL\)\n\s*const source = shellFetch \? appSource\(shellFetch\) : launcherServes\(window\.location\.href\) \? launcherSource : webSource\n/)
  assert.match(src, /const siteEnd = new AbortController\(\)\n\s*const pin = source\.pin\n/)
  const manifest = src.slice(src.indexOf('const manifestOffer = '), src.indexOf('const webSource = Object.freeze<ModelSource>({'))
  const web = src.slice(src.indexOf('const webSource = Object.freeze<ModelSource>({'), src.indexOf('const appSource = '))
  const app = src.slice(src.indexOf('const appSource = '), src.indexOf('const launcherSource = '))
  const launcher = src.slice(src.indexOf('const launcherSource = '), src.indexOf('/** `make()` the first time it is asked for'))
  assert.ok(manifest.length > 100 && web.length > 100 && app.length > 100 && launcher.length > 100, 'the three sources and the manifest\'s offer are found')
  assert.match(manifest, /const r = await siteFetch\(SITE_MANIFEST, \{ cache: 'no-cache', signal \}\)\n\s*if \(r\.ok\) return parseManifest\(await r\.text\(\), pin\)/, 'the manifest must name the source\'s own pin')
  assert.match(manifest, /if \(r\.status === 404 \|\| r\.status === 410\) return null\n\s*throw new Error/, 'only a definite answer is kept for the visit: a 429 or a 5xx is asked again')
  assert.match(web, /pin: SITE_MODEL,\n\s*fetch: siteFetch,/)
  assert.match(web, /served: \(\) => \/\^https\?:\$\/\.test\(window\.location\.protocol\) && document\.querySelector\('link\[rel="manifest"\]'\) !== null,\n\s*offer: manifestOffer\(SITE_MODEL, 'the site'\),\n\s*online: true,/, 'only the web copy is served the site\'s model, over the connection')
  assert.match(app, /pin: APP_MODEL,\n\s*fetch,\n\s*served: \(\) => true,/)
  assert.match(app, /offer: \(\) => shellModel\(APP_MODEL\),\n\s*online: false,/, 'the shell says whether the app carries it; the copy never leaves the machine')
  assert.match(launcher, /from: 'launcher',\n\s*pin: APP_MODEL,\n\s*fetch: siteFetch,\n\s*served: \(\) => launcherServes\(window\.location\.href\),\n\s*offer: manifestOffer\(APP_MODEL, 'the launcher'\),\n\s*online: false,/, 'the desktop\'s model from the launcher\'s own origin on 127.0.0.1; the connection has no say')
  assert.match(launcher, /coming: "the launcher's model is being copied into this page",/)
  assert.match(src, /offered \?\?= source\.offer\(siteEnd\.signal\)\.catch\(\(\) => \{ offered = null; return null \}\)/, 'the offer is asked once a visit')
  assert.match(src, /if \(PAGE_MODEL_REFUSAL\(\) !== null \|\| !source\.served\(\)\) return null/, 'no offer (and no request) where the browser cannot run it, or on a page the source does not serve')
  assert.match(get, /\}, AbortSignal\.any\(\[signal, siteEnd\.signal\]\), source\.from\)/, 'the words say where it came from')
  assert.match(get, /onProgress\(\{ step: 'keep', done: 0, total: file\.size \}\)\n\s*return keepPicked\(\[file\], \(done, total\) => onProgress\(\{ step: 'keep', done, total \}\), how === 'tap'\)/, 'the card is told of the hand-off to the copy in the same turn as the last stop check; only a tap sets the provider')
  assert.match(src, /AbortSignal\.any\(\[signal, siteEnd\.signal\]\)/, 'the Stop and the city\'s end both stop the download')
  assert.match(get, /signal\.throwIfAborted\(\)\n\s*siteEnd\.signal\.throwIfAborted\(\)\n\s*\} finally \{/, 'a stop as the last bytes come keeps nothing')
  assert.match(src, /if \(fetching\) throw new Error\(`\$\{source\.coming\}: wait for it to finish, or stop it on Sloane's card`\)/, 'a pick, a drop or the console waits for the site\'s model (or the app\'s), in its own words')
  assert.match(src, /coming: 'the model this site serves is on its way to this page',/)
  assert.match(src, /coming: "the app's model is being copied into this page",/)
  assert.ok(src.indexOf('const source = shellFetch ? appSource(shellFetch) : launcherServes(window.location.href) ? launcherSource : webSource') < src.indexOf('let keeping = false'), 'the source is known before a pick can ask it')
  assert.match(src, /unModel = \(\) => \{\n\s*modelFileRef\.current = null\n\s*siteAutoRef\.current = null\n\s*siteJob\.stop\('page'\)\n\s*siteEnd\.abort\(\)/, 'the city\'s end stops the job (and the page\'s own start) first')
  assert.match(src, /noPageModel=\{PAGE_MODEL_REFUSAL\(\)\}\s*siteModel=\{siteModel\}/)
  assert.match(src, /setSloaneTalk\(null\)\n\s*setSiteModel\(null\)/)
})

test('App: the page gets the site\'s model by itself once the city is on screen, through siteAuto.ts createSiteAuto, with the page\'s own facts', () => {
  const src = read('App.tsx')
  // The steps and their order are siteAuto.ts's (siteAuto.test.ts drives them); App hands it the page.
  const auto = src.slice(src.indexOf('const siteAuto = createSiteAuto({'), src.indexOf('siteAutoRef.current = siteAuto'))
  assert.ok(auto.length > 100, 'the page\'s own start is found')
  assert.match(auto, /seen: \(\) => \(document\.hidden \? new Promise<void>\(/, 'a page in the background waits until it is seen')
  assert.match(auto, /siteEnd\.signal\.addEventListener\('abort', done, \{ once: true \}\)/, 'or until the city ends')
  assert.match(auto, /ended: \(\) => \(siteEnd\.signal\.aborted \? 'the city ended' : lockedRef\.current !== null \? 'the city halted' : null\)/, 'a halted city starts nothing')
  assert.match(auto, /served: source\.served,\n\s*facts: siteFacts,\n\s*offer: \(\) => siteHost\.offer\(\),\n\s*refusal: siteRefusal,/)
  // The connection has a say only where the copy uses it (the site's); the app's own file never leaves the machine.
  assert.match(auto, /link: \(\) => \(source\.online \? readLink\(navigator\) : null\),/)
  assert.match(auto, /onLink: \(changed\) => \{\n\s*const l = source\.online \? connection\(\) : undefined\n\s*l\?\.addEventListener\?\.\('change', changed\)\n\s*return \(\) => l\?\.removeEventListener\?\.\('change', changed\)/)
  assert.match(auto, /offline: \(\) => source\.online && navigator\.onLine === false,\n\s*record: autoRecord,\n\s*job: siteJob,\n\s*say: \(line\) => e\.toast\(MODEL_FILE, line\),/)
  assert.match(src.slice(src.indexOf('const siteAuto = createSiteAuto({'), src.indexOf('siteAutoRef.current = siteAuto')), /\}, pin, 'Sloane', source\.from\)\n\s*$/, 'the source\'s pin and words')
  // The facts: read with no request and no look at a model server.
  const facts = src.slice(src.indexOf('const siteFacts = async (): Promise<AutoFacts> => {'), src.indexOf('const autoChoice = (): string | null => {'))
  assert.ok(facts.length > 100, 'the facts are found')
  assert.doesNotMatch(facts, /\bfetch\(|siteFetch|offer\(|installed\(|look\(/, 'no request: no manifest, no model server')
  assert.match(facts, /own: chosen !== null && chosen !== pin\.file \? chosen : \(kept\.find\(\(m\) => m\.name !== pin\.file\)\?\.name \?\? null\)/, 'a model file of the visitor\'s own, chosen or only kept')
  assert.match(facts, /busy: keeping \? '[^']+' : fetching \? `\$\{source\.coming\} already` : null/, 'a pick, a drop or a download under way')
  assert.match(facts, /kept: kept\.some\(\(m\) => m\.name === pin\.file && m\.bytes === pin\.bytes\)/)
  assert.match(facts, /lasting: caps\.opfs && \(await navigator\.storage\.getDirectory\(\)\.then\(\(\) => true, \(\) => false\)\)/, 'the storage must answer, not only exist')
  assert.match(facts, /remembers: autoRecord\.remembers\(\),\n(?:\s*\/\/[^\n]*\n)*\s*link: source\.online \? readLink\(navigator\) : null,/)
  assert.match(src, /const autoRecord = createAutoRecord\(autoStore\(\), autoLocks\(\)\)/)
  // The job's work: a tap holds the page's lock, and the page's own download is not kept over a choice made meanwhile.
  assert.match(src, /const release = how === 'tap' \? await autoRecord\.claim\(\) : noop\n\s*try \{\n\s*return await siteWork\(how, onProgress, signal\)\n\s*\} finally \{\n\s*release\(\)/)
  assert.match(src, /const other = how === 'auto' \? autoChoice\(\) : null\n\s*if \(other !== null\) throw new SiteJobHeld\('choice', other\)\n[^\n]*\n[^\n]*\n\s*onProgress\(\{ step: 'keep'/, 'checked in the same turn as the hand-off to the copy')
  // A halt stops the job and the start, as the city's end does.
  assert.match(src, /e\.onHalt = \(reason\) => \{\n(?:\s*\/\/[^\n]*\n)*\s*if \(haltClass\(reason\) === 'gpu-reset'\) inPage\.noteGpuReset\(\)\n\s*stopSite\(\)/)
  assert.match(src, /stopSite = \(\) => \{\n\s*siteJob\.stop\('page'\)\n\s*siteEnd\.abort\(\)/)
  // Once the city is on screen and standing: never under the boot veil or over a halted city.
  assert.match(src, /useEffect\(\(\) => \{\n\s*if \(!veilDone \|\| locked !== null \|\| siteModel === null\) return\n\s*void siteAutoRef\.current\?\.\(\)\.then\(/)
  assert.match(src, /\}, \[veilDone, locked, siteModel\]\)/)
})
