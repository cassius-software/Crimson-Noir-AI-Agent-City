// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins Sloane in conversation (voice.ts sloaneChat) and how the page wires it: talk on the
 * card goes to the page's mind with Sloane's framing and the turns so far, streams back screened by the 14A screen (a
 * refused word stops the model and shows nothing), never carries an action line (a conversation never acts), and ends
 * as `none` with the router's reason when no model answers, so the card says so plainly and offers the ways to get one
 * instead of sending scouts. The card reaches the model only through that Chat (never a Mind), App hands it the picker
 * and the browser's refusal, and the brief's rewording never asks while the model this page would answer with is still to
 * be loaded (an answer's stop ends its load, so the 4 s rewording used to kill every load it started).
 * What breaks if it is removed? Small talk could fall back to the scouts and a flat "not yet", a model's reply could be
 * shown unscreened or act, or the rewording could go back to killing the in-page model while it loads.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { AnswerRequest, Mind, Piece } from '../operator.ts'
import { CHAT_MAX, CHAT_TURNS, SCRIPTED_CHOSEN, chatPrompt, chatSoFar, chatWords, phaseLine, sloaneChat, type ChatTurn, type PhaseSource } from './voice.ts'

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

test('sloaneChat asks as a conversation (the short talk prompt) and tells the card what the model is doing until its first word', async () => {
  // The host's phase: one listener at a time, told the phase it is in at once, then each change.
  let heard: ((p: string | null) => void) | null = null
  let unheard = 0
  const phases: PhaseSource = (listen) => {
    heard = listen
    listen('loading the model in this page')
    return () => { heard = null; unheard++ }
  }
  const m = mindOf('hang')
  const seen: (string | null)[] = []
  const stop = new AbortController()
  const r = sloaneChat(m.mind, () => true, phases).reply([you('hire an agent')], stop.signal, undefined, (p) => seen.push(p))
  await Promise.resolve()
  assert.equal(m.asked.length, 1)
  assert.equal(m.asked[0].talk, true, 'a conversation, so every provider sends the talk prompt')
  assert.deepEqual(m.asked[0].tethers, [], 'bound to no one')
  heard!('reading the prompt 25%')
  heard!('reading the prompt 25%')
  heard!('reading the prompt 50%')
  stop.abort()
  assert.deepEqual(await r, { kind: 'failed', why: 'stopped' })
  assert.deepEqual(seen, ['loading the model in this page', 'reading the prompt 25%', 'reading the prompt 50%', null], 'each change once, cleared at the end')
  assert.equal(heard, null)
  assert.equal(unheard, 1, 'the listener is let go')

  // The first word clears the phase, and nothing the host says after it reaches the card.
  const said: (string | null)[] = []
  let late: ((p: string | null) => void) | null = null
  const talking = mindOf('All good here, the streets are calm.')
  const done = await sloaneChat(talking.mind, () => true, (listen) => { late = listen; listen('reading the prompt 90%'); return () => {} })
    .reply([you('how is it going')], live(), () => { late?.('generating') }, (p) => said.push(p))
  assert.equal(done.kind, 'said')
  assert.deepEqual(said, ['reading the prompt 90%', null])

  // A host whose phase source or card line throws never costs the reply.
  const sturdy = await sloaneChat(mindOf('Fine, thanks.').mind, () => true, () => { throw new Error('no phases') })
    .reply([you('hi')], live(), undefined, () => { throw new Error('the card went') })
  assert.deepEqual(sturdy, { kind: 'said', text: 'Fine, thanks.' })
  // No phase source at all: the reply as before, the card told only that nothing is pending.
  const plain: (string | null)[] = []
  assert.equal((await sloaneChat(mindOf('Fine.').mind).reply([you('hi')], live(), undefined, (p) => plain.push(p))).kind, 'said')
  assert.deepEqual(plain, [])
})

test('the phase line: the prompt read as the conversation with its share, the load as it is, anything else as the runtime says it', () => {
  assert.equal(phaseLine('reading the prompt 42%'), 'Reading the conversation · 42%')
  assert.equal(phaseLine('reading the prompt 100%'), 'Reading the conversation · 100%')
  assert.equal(phaseLine('loading the model in this page'), 'Loading the model in this page…')
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
  assert.match(card, /const open = view === 'goal' && \(!dialogue\.brief \|\| dialogue\.brief\.chat === true\)/, 'words heard while the conversation is open are its next turn')
  // A second message never cuts short a reply still on its way (a model loading in this page for it would load again):
  // the next turn waits for it, or for the person's own Stop, and the chip opens the conversation as it stands.
  assert.match(card, /if \(dialogue\.brief\?\.chat && replying\) \{\n\s*setDraft\(\(d\) => \(d\.trim\(\) \? d : text\)\)/, 'a heard line waits in the field')
  assert.match(card, /if \(brief\?\.chat && replying\) \{\n\s*setDraft\(brief\.goal\)\n\s*return/, 'however talk arrives')
  assert.match(card, /else if \(dialogue\.brief\?\.chat && replying\) \{[^}]*openGoal\(\)\n\s*setDraft\(said\)/, '"Sloane, …" from the chip too')
  assert.match(card, /disabled=\{replying\}/)
  assert.match(card, /data-action="stop"/)
  assert.match(card, /if \(dialogue\.brief\?\.chat && \(replying \|\| unseen \|\| getting !== null \|\| \(!whySeen && talk\?\.state === 'none'\)\)\) \{\n\s*open\('goal'\)/, 'a reply that came while the card was away is shown when it opens (and a download under way, or one that ended short meanwhile, keeps the conversation)')
  assert.match(card, /const refocus = \(\) => \{\n\s*focusNext\.current = true/, 'Stop and Ask again hand focus back to the field')
})

test('App: the card gets Sloane\'s conversation, the picker and the browser\'s refusal; the rewording waits for a model file to be loaded', () => {
  const src = read('App.tsx')
  assert.match(src, /setSloaneTalk\(sloaneChat\(mind, \(\) => local\.settings\(\)\.provider !== 'scripted', \(heard\) => \{\n\s*phaseHeard\.add\(heard\)\n\s*heard\(modelPhase\)\n\s*return \(\) => \{ phaseHeard\.delete\(heard\) \}\n\s*\}\)\)/, 'the conversation hears the model\'s phase, starting with the one it is in')
  assert.match(src, /modelPhase = text\n\s*for \(const heard of phaseHeard\) heard\(text\)/, 'every phase reaches every listener')
  assert.match(src, /chat=\{sloaneTalk\}\s*onPickModel=\{onModelFile\}\s*noPageModel=\{PAGE_MODEL_REFUSAL\(\)\}/)
  assert.match(src, /if \(s\.provider === 'inpage'\) return inPage\.cold\(true\)/)
  assert.match(src, /if \(s\.provider !== 'auto' \|\| !inPage\.cold\(false\)\) return false/)
  assert.match(src, /return s\.found === undefined \|\| s\.found === 'inpage'/, 'under auto, only while the file is what would answer')
  assert.match(src, /setSloane\(null\)\n\s*setSloaneTalk\(null\)/, 'a city that goes takes the conversation with it')
})

test('the card: the site\'s model is offered when no model answers, got in one tap with progress and Stop, and the last turn is asked again', () => {
  const card = read('07_Execute_Actions/Concierge.tsx')
  assert.match(card, /import type \{ SiteModelHost, SiteModelLine, SiteModelProgress \} from '\.\.\/09_Cognition\/siteModel\.ts'/, 'only the types: the card fetches nothing')
  assert.doesNotMatch(card, /\bfetch\s*\(/)
  assert.match(card, /const offering = talk\?\.state === 'none' && siteModel !== null && !noPageModel/, 'offered only when no model answers, where this browser can run one')
  assert.match(card, /siteModel\.offer\(\)\.then\(/, 'the manifest is asked when the card first offers it, never at boot')
  assert.match(card, /data-action="site-model"/)
  assert.match(card, /\{site\.kept \? 'Use the model kept here' : `Get the model · \$\{site\.size\}`\}/, 'the button says the size before anything is downloaded')
  assert.match(card, /siteModel\.get\(\(p\) => \{\n\s*if \(ctl\.signal\.aborted\) return\n\s*if \(p\.step === 'keep'\) handed\.current = true\n\s*setGetting\(p\)\n\s*\}, ctl\.signal\)/)
  assert.match(card, /role="progressbar"/)
  assert.match(card, /\{getting\.step === 'download' && <button type="button" onClick=\{stopGetting\} className=\{link\} data-action="stop-model">Stop<\/button>\}/, 'Stop while it downloads; the copy into the page runs to its end')
  assert.match(card, /if \(onChat\.current && turnsRef\.current\.at\(-1\)\?\.who === 'you'\) \{\n\s*setStarting\(true\)\n\s*askTurns\(turnsRef\.current\)/, 'the last turn is asked again once the model is kept, while the card is still on that conversation')
  assert.match(card, /useEffect\(\(\) => \{ onChat\.current = dialogue\.brief\?\.chat === true \}\)/, 'read when the download ends, not from the render that started it')
  assert.match(card, /useEffect\(\(\) => \(\) => getCtl\.current\?\.abort\(\), \[\]\)/, 'a card that goes stops its download')
  assert.match(card, /\}, \[offering, fetchingSite, noneOf, siteModel\]\)/, 'the offer is asked again at each conversation with no model and after each try, so "kept" is never stale and a site out of reach once is asked again')
  assert.match(card, /downloaded once from this site, checked against the copy this page was built for, and kept in this browser \(Apache-2\.0\)/)
  assert.match(card, /<p role="status"[^>]*data-site-why>/, 'why it ended short is said on the card, and announced')
  assert.match(card, /const refocusKeys = \(\) => \{\n\s*if \(family !== 'touch'\) refocus\(\)/, 'focus goes back to the field after the offer, Stop or the end of a download, never on touch')
  assert.match(card, /if \(!a \|\| a === document\.body \|\| cardRef\.current\?\.contains\(a\)\) refocusKeys\(\)/, 'a download that ends never takes focus from a control elsewhere')
  assert.match(card, /if \(p\.step === 'keep'\) handed\.current = true/, 'the hand-off to the copy is noted at once')
  assert.match(card, /const stopGetting = \(\) => \{\n(?:\s*\/\/.*\n)*\s*if \(handed\.current\) return/, 'a Stop after the hand-off does nothing: the copy runs to its end')
})

test('App: the site\'s model is fetched from the page\'s own folder only, after the browser, the device and the storage have said yes, and kept as a picked file is', () => {
  const src = read('App.tsx')
  assert.match(src, /const siteFetch: SiteFetch = \(path, init\) => window\.fetch\(siteUrl\(path, window\.location\.href\), init\)/)
  const get = src.slice(src.indexOf('get: async (onProgress, signal) => {'), src.indexOf('setSiteModel(siteHost)'))
  assert.ok(get.length > 100, 'the host\'s get is found')
  const order = ['PAGE_MODEL_REFUSAL()', 'if (keeping || fetching)', 'fetching = true', 'await keptSite()', 'await inPage.installed()', 'fits([{ name: SITE_MODEL.file, bytes: SITE_MODEL.bytes }]', 'roomRefusal(SITE_MODEL.bytes, room)', 'fetchSiteModel(siteFetch, SITE_MODEL,', 'return keepPicked([file],']
  const at = order.map((n) => get.indexOf(n))
  at.forEach((i, k) => assert.ok(i >= 0, `${order[k]} is in get`))
  for (let k = 1; k < at.length; k++) assert.ok(at[k - 1] < at[k], `${order[k - 1]} comes before ${order[k]}`)
  assert.match(src, /offered \?\?= siteFetch\(SITE_MANIFEST, \{ cache: 'no-cache', signal: siteEnd\.signal \}\)/, 'the manifest is asked once a visit')
  assert.match(src, /if \(PAGE_MODEL_REFUSAL\(\) !== null \|\| !\/\^https\?:\$\/\.test\(window\.location\.protocol\) \|\| !document\.querySelector\('link\[rel="manifest"\]'\)\) return null/, 'no offer (and no request) where the browser cannot run it, off a web server, or on any page but the web copy')
  assert.match(src, /if \(r\.status === 404 \|\| r\.status === 410\) return null\n\s*throw new Error/, 'only a definite answer is kept for the visit: a 429 or a 5xx is asked again')
  assert.match(get, /onProgress\(\{ step: 'keep', done: 0, total: file\.size \}\)\n\s*return keepPicked\(\[file\],/, 'the card is told of the hand-off to the copy in the same turn as the last stop check')
  assert.match(src, /AbortSignal\.any\(\[signal, siteEnd\.signal\]\)/, 'the card\'s Stop and the city\'s end both stop the download')
  assert.match(get, /signal\.throwIfAborted\(\)\n\s*siteEnd\.signal\.throwIfAborted\(\)\n\s*\} finally \{/, 'a stop as the last bytes come keeps nothing')
  assert.match(src, /if \(fetching\) throw new Error\('the model this site serves is on its way to this page/, 'a pick, a drop or the console waits for the site\'s model')
  assert.match(src, /unModel = \(\) => \{\n\s*modelFileRef\.current = null\n\s*siteEnd\.abort\(\)/)
  assert.match(src, /noPageModel=\{PAGE_MODEL_REFUSAL\(\)\}\s*siteModel=\{siteModel\}/)
  assert.match(src, /setSloaneTalk\(null\)\n\s*setSiteModel\(null\)/)
})
