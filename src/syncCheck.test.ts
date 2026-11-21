// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the check that everything published comes from one commit
 * (tools/build/sync.mjs, .github/workflows/sync.yml): the web copy by its build.json, the downloads by the release's
 * record, each required target, the tag, each recorded file's bytes, and the UEFI disk images by the GUID baked into
 * them. It holds the verdict over plain facts (in sync; behind with something on its way; behind with nothing on its
 * way, which is red; a source that could not be read, which is red too), with the afternoon of 21 November 2026 as a
 * case: the web copy, the downloads and main at three commits behind green runs. It holds the reading against
 * stand-ins for GitHub and for the site, the disk GUID against the script that bakes it, and the workflow: what
 * starts it, that it can write nothing, and that a pull request's run reports without turning red for what it finds.
 * What breaks if it is removed? The check could call drift in sync, or cry drift while a publish is simply under
 * way, and the first anyone knew would be a red run nobody trusts or a green one that should have been red.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Computed specifiers: the scripts are tooling under tools/, outside the page's build, loaded as the test's own modules.
const SYNC: string = '../tools/build/sync.mjs'
const CURRENT: string = '../tools/build/current.mjs'
const MATRIX: string = '../tools/build/matrix.mjs'
const s = await import(SYNC)
const c = await import(CURRENT)
const m = await import(MATRIX)
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const WORKFLOW = read('.github/workflows/sync.yml')
const IDS: readonly string[] = m.IDS
const REPO = 'cassius-software/Crimson-Noir-AI-Agent-City'
const SITE = 'https://cassius-software.github.io/Crimson-Noir-AI-Agent-City/'

interface FileRecord { name: string; sha256: string; size: number }
interface Target { commit: string; files: FileRecord[] }
interface State { schema: number; tag: string; tagAt?: string; commit?: string; time?: string; targets: Record<string, Target> }
interface Run { workflow: string; created: string; sha: string }
interface Facts {
  now: string
  tip?: string
  green: { sha: string; ci: string; at: string } | { error: string } | null
  web: { stamp: Record<string, unknown> | null; probe: string } | { error: string }
  release: { state: State; staged: boolean; tag: string | null; assets: { name: string; size: number; digest: string | null }[] } | { error: string } | null
  media: Record<string, string | null>
  runs: Run[]
  served: string | null
  runsError?: string
}
interface Verdict { status: string; problems: string[]; waiting: string[]; warnings: string[]; rows: string[][] }

const commitOf = (n: number) => createHash('sha1').update(`commit ${n}`).digest('hex')
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const [C1, C2, C3] = [commitOf(1), commitOf(2), commitOf(3)]
const at = (hhmm: string) => `2026-11-21T${hhmm}:00Z`
const cacheOf = (commit: string) => `agent-city-1.0.0-stable-beta-${sha256(commit).slice(0, 12)}`
const stampOf = (commit: string) => ({ schema: 1, commit, version: '1.0.0-stable-beta', build: sha256(commit).slice(0, 12), cache: cacheOf(commit), ci: '', run: '' })

/** One file for each target, as the release would hold it for a commit, and the two disk images under their names. */
function filesOf(id: string, commit: string): FileRecord[] {
  const name = id === 'uefi-x64' ? 'crimson_noir_os.img' : id === 'uefi-arm64' ? 'crimson_noir_os-aarch64.img' : `${id}.bin`
  return [{ name, sha256: sha256(`${id} ${commit}`), size: 1000 + id.length }]
}

/** A release that holds `commit` whole, with every target at it unless `targets` says otherwise. */
function releaseAt(commit: string, targets: Record<string, string | null> = {}) {
  const state: State = { schema: 1, tag: 'current', tagAt: commit, commit, time: at('16:28'), targets: {} }
  for (const id of IDS) {
    const built = id in targets ? targets[id] : commit
    if (built) state.targets[id] = { commit: built, files: filesOf(id, built) }
  }
  const assets = IDS.flatMap((id) => state.targets[id]?.files ?? []).map((f) => ({ name: f.name, size: f.size, digest: `sha256:${f.sha256}` as string | null }))
  return { state, staged: false, tag: commit as string | null, assets }
}

const mediaOf = (rel: { state: State }) => Object.fromEntries(Object.entries(s.MEDIA as Record<string, { arch: string }>)
  .filter(([id]) => rel.state.targets[id]).map(([id, { arch }]) => [id, s.mediaGuid(rel.state.targets[id].commit, arch) as string]))

/** Everything in sync at `commit`, an hour after its ci passed, with nothing running: the base every case alters. */
function inSync(commit = C2): Facts & { release: ReturnType<typeof releaseAt>; web: { stamp: Record<string, unknown> | null; probe: string } } {
  const release = releaseAt(commit)
  return {
    now: at('18:00'),
    green: { sha: commit, ci: 'https://github.com/x/y/actions/runs/1', at: at('17:00') },
    web: { stamp: stampOf(commit), probe: cacheOf(commit) },
    release,
    media: mediaOf(release),
    runs: [],
    served: at('17:05'),
  }
}
const judge = (f: Facts): Verdict => s.verdict(f)

test('in sync: the web copy, the release\'s record, every target, the tag, the bytes and the disk images all name the newest commit ci passed on', () => {
  const v = judge(inSync())
  assert.deepEqual([v.status, v.problems, v.waiting, v.warnings], ['in-sync', [], [], []])
  // The summary's rows: main, the web copy, the release, each target of the build matrix in its order, the tag.
  assert.deepEqual(v.rows.map((r) => r[0].trim().replace(' (best effort)', '')), ['main, newest commit ci passed on', 'web copy', 'downloads (the current release)', ...IDS, 'tag current'])
  assert.ok(v.rows.slice(1).every((r) => r[1] === C2 && r[2] === 'same commit'), 'every row at the one commit')
  assert.ok(v.rows.some((r) => r[0] === '  ios-ipa (best effort)'))
  // The limits the header and the workflow's words give, in minutes.
  assert.deepEqual(s.GRACE, { start: 10, web: 45, current: 180, served: 15, ci: 100 })
  assert.ok(Object.isFrozen(s.GRACE))
})

test('21 November 2026: ci passed on a commit, the web copy took it and the downloads did not; settling for ten minutes, then red, naming the downloads, each required target and the tag', () => {
  // 17:01:52 ci passed on C2. The web copy was published from it at 17:03; the release stayed at C1 behind a green run.
  const then = (now: string): Facts => {
    const release = releaseAt(C1)
    return { now, green: { sha: C2, ci: 'ci', at: '2026-11-21T17:01:52Z' }, web: { stamp: stampOf(C2), probe: cacheOf(C2) }, release, media: mediaOf(release), runs: [], served: '2026-11-21T17:03:39Z' }
  }
  const soon = judge(then(at('17:04')))
  assert.equal(soon.status, 'settling')
  assert.deepEqual(soon.problems, [])
  assert.ok(soon.waiting.every((w) => w.endsWith('(ci passed 2 min ago)')), soon.waiting.join('\n'))
  const later = judge(then(at('17:30')))
  assert.equal(later.status, 'drift')
  const required = IDS.filter((id) => !(c.BEST_EFFORT as string[]).includes(id))
  assert.deepEqual(later.problems, [
    `the downloads are built from ${C1.slice(0, 7)}, not ${C2.slice(0, 7)}: Actions > current > Run workflow, on main`,
    ...required.map((id) => `${id} is built from ${C1.slice(0, 7)}, not ${C2.slice(0, 7)}: Actions > current > Run workflow, on main`),
  ])
  assert.deepEqual(later.warnings, [`ios-ipa is built from ${C1.slice(0, 7)}, not ${C2.slice(0, 7)} (best effort: it never turns a publish red)`])
  assert.deepEqual(later.waiting, [], 'nothing was on its way: that was the fault')
  assert.deepEqual(later.rows.find((r) => r[0] === 'web copy'), ['web copy', C2, 'same commit'])
  assert.deepEqual(later.rows.find((r) => r[0] === 'downloads (the current release)'), ['downloads (the current release)', C1, 'another commit'])
  // And the hour before, the other way about: the downloads at the new commit, the web copy's deploy skipped.
  const release = releaseAt(C2)
  const web: Facts = { now: at('17:00'), green: { sha: C2, ci: 'ci', at: at('16:05') }, web: { stamp: stampOf(C1), probe: cacheOf(C1) }, release, media: mediaOf(release), runs: [], served: at('16:21') }
  const skipped = judge(web)
  assert.equal(skipped.status, 'drift')
  assert.deepEqual(skipped.problems, [`the web copy is built from ${C1.slice(0, 7)}, not ${C2.slice(0, 7)}: Actions > web > Run workflow, on main`])
  assert.deepEqual(judge({ ...web, tip: C2 }).problems, skipped.problems, 'main\'s tip is that commit: a run by hand mends it')
  // Main's tip is a newer commit ci did not pass on: web.yml publishes the tip alone, by hand too, so the advice
  // would publish an untested commit. Red all the same, with that said in the advice's place.
  const untested = judge({ ...web, tip: C3 })
  assert.equal(untested.status, 'drift')
  assert.deepEqual(untested.problems, [`the web copy is built from ${C1.slice(0, 7)}, not ${C2.slice(0, 7)}: ci has not passed on main's tip (${C3.slice(0, 7)}), the one commit web.yml publishes, so the web copy follows when ci passes there (a web run by hand would publish that tip untested)`])
})

test('behind is not drift while something can still mend it: a publisher\'s run that has not ended, a web copy published minutes ago, ci still running on a newer commit; each only for so long', () => {
  const behindRelease = (runs: Run[], now = at('18:00')): Verdict => {
    const release = releaseAt(C1)
    return judge({ ...inSync(), now, release, media: mediaOf(release), runs })
  }
  assert.equal(behindRelease([{ workflow: 'current', created: at('17:10'), sha: C2 }]).status, 'settling')
  assert.ok(behindRelease([{ workflow: 'current', created: at('17:10'), sha: C2 }]).waiting.every((w) => w.endsWith('(a current run has not ended)')))
  assert.equal(behindRelease([{ workflow: 'current', created: at('15:01'), sha: C2 }]).status, 'settling', '179 minutes: still a run')
  assert.equal(behindRelease([{ workflow: 'current', created: at('15:00'), sha: C2 }]).status, 'drift', '180 minutes: a run that hung mends nothing')
  assert.equal(behindRelease([{ workflow: 'web', created: at('17:55'), sha: C2 }]).status, 'drift', 'a web run does not publish the downloads')
  assert.equal(behindRelease([{ workflow: 'ci', created: at('17:55'), sha: C3 }]).status, 'drift', 'the downloads do not wait for main\'s tip')

  const behindWeb = (over: Partial<Facts>): Verdict => judge({ ...inSync(), web: { stamp: stampOf(C1), probe: cacheOf(C1) }, served: at('16:00'), ...over })
  assert.equal(behindWeb({}).status, 'drift')
  assert.equal(behindWeb({ runs: [{ workflow: 'web', created: at('17:16'), sha: C2 }] }).status, 'settling', '44 minutes')
  assert.equal(behindWeb({ runs: [{ workflow: 'web', created: at('17:15'), sha: C2 }] }).status, 'drift', '45 minutes')
  assert.equal(behindWeb({ runs: [{ workflow: 'current', created: at('17:55'), sha: C2 }] }).status, 'drift', 'a current run does not publish the web copy')
  // The host may serve the copy before for ten minutes after a publish: fifteen are allowed.
  const served = behindWeb({ served: at('17:46') })
  assert.equal(served.status, 'settling')
  assert.match(served.waiting[0], /\(a web run ended 14 min ago, and the host may serve the copy before for ten\)$/)
  assert.equal(behindWeb({ served: at('17:45') }).status, 'drift')
  assert.equal(behindWeb({ served: null }).status, 'drift')
  // web.yml publishes main's tip alone, so while ci runs on a newer commit the web copy waits for that one.
  const tip = behindWeb({ runs: [{ workflow: 'ci', created: at('17:30'), sha: C3 }] })
  assert.equal(tip.status, 'settling')
  assert.match(tip.waiting[0], new RegExp(`\\(ci is still running on ${C3.slice(0, 7)}, and the web copy waits for main's tip\\)$`))
  assert.equal(behindWeb({ runs: [{ workflow: 'ci', created: at('16:20'), sha: C3 }] }).status, 'drift', '100 minutes: that ci hung')
  assert.equal(behindWeb({ runs: [{ workflow: 'ci', created: at('17:30'), sha: C2 }] }).status, 'drift', 'a second ci run on the very commit is not a newer one')
  // Both behind, one on its way: red for the other.
  const release = releaseAt(C1)
  const half = judge({ ...inSync(), web: { stamp: stampOf(C1), probe: cacheOf(C1) }, served: at('16:00'), release, media: mediaOf(release), runs: [{ workflow: 'current', created: at('17:30'), sha: C2 }] })
  assert.equal(half.status, 'drift')
  assert.equal(half.problems.length, 1)
  assert.match(half.problems[0], /^the web copy is built from /)
  assert.ok(half.waiting.length > 0)
  // Just after ci passed, both are simply on their way.
  const fresh = judge({ ...inSync(), now: at('17:09'), web: { stamp: stampOf(C1), probe: cacheOf(C1) }, served: at('16:00'), release, media: mediaOf(release) })
  assert.equal(fresh.status, 'settling')
  assert.equal(judge({ ...inSync(), now: at('17:10'), web: { stamp: stampOf(C1), probe: cacheOf(C1) }, served: at('16:00'), release, media: mediaOf(release) }).status, 'drift', 'ten minutes with no run begun')
})

test('a web copy without its stamp, or whose build.txt and build.json name two builds, is behind; a missing release too', () => {
  const none = judge({ ...inSync(), web: { stamp: null, probe: cacheOf(C1) }, served: at('16:00') })
  assert.equal(none.status, 'drift')
  assert.match(none.problems[0], /^the web copy has no build\.json, so it was published before copies were stamped with their commit \(or not by web\.yml\): Actions > web > Run workflow, on main$/)
  assert.deepEqual(none.rows.find((r) => r[0] === 'web copy'), ['web copy', '', 'no build.json'])
  // The stamp at the right commit and build.txt still at the build before: the host served one of them from its
  // keep. Settling just after a publish; red when it stays.
  const two = { ...inSync(), web: { stamp: stampOf(C2), probe: cacheOf(C1) } }
  assert.equal(judge({ ...two, served: at('17:50') }).status, 'settling')
  const stayed = judge(two)
  assert.equal(stayed.status, 'drift')
  assert.match(stayed.problems[0], new RegExp(`^the web copy's build\\.txt names ${cacheOf(C1)} and its build\\.json ${cacheOf(C2)}: two publishes at once`))
  const gone = judge({ ...inSync(), release: null, media: {} })
  assert.equal(gone.status, 'drift')
  assert.deepEqual(gone.problems, ['there is no `current` release: Actions > current > Run workflow, on main'])
})

test('inside the release: one required target behind is red and named; the iOS build behind or missing is a warning; a staged record is a publish under way; the tag must be where the record says', () => {
  const oneBehind = releaseAt(C2, { 'linux-arm64': C1 })
  const v = judge({ ...inSync(), release: oneBehind, media: mediaOf(oneBehind) })
  assert.equal(v.status, 'drift')
  assert.deepEqual(v.problems, [`linux-arm64 is built from ${C1.slice(0, 7)}, not ${C2.slice(0, 7)}: Actions > current > Run workflow, on main`])
  const missing = releaseAt(C2, { 'uefi-arm64': null })
  assert.deepEqual(judge({ ...inSync(), release: missing, media: mediaOf(missing) }).problems, ['uefi-arm64 has no files on the release: Actions > current > Run workflow, on main'])

  for (const built of [C1, null]) {
    const ios = releaseAt(C2, { 'ios-ipa': built })
    const w = judge({ ...inSync(), release: ios, media: mediaOf(ios) })
    assert.equal(w.status, 'in-sync', 'best effort, as in build-matrix.yml and current.mjs')
    assert.equal(w.warnings.length, 1)
    assert.match(w.warnings[0], /^ios-ipa (is built from [0-9a-f]{7}, not [0-9a-f]{7}|has no files on the release) \(best effort: it never turns a publish red\)$/)
  }
  assert.deepEqual(c.BEST_EFFORT, ['ios-ipa'], 'the one target that may trail')

  const staged = { ...releaseAt(C2), staged: true }
  const under = judge({ ...inSync(), release: staged, runs: [{ workflow: 'current', created: at('17:40'), sha: C2 }] })
  assert.equal(under.status, 'settling')
  assert.match(under.waiting[0], /^a publish is under way or stopped half way \(current\.next\.json is on the release\) \(a current run has not ended\)$/)
  assert.equal(judge({ ...inSync(), release: staged }).status, 'drift', 'no run: the publish stopped half way')

  const tagBehind = { ...releaseAt(C2), tag: C1 }
  const t = judge({ ...inSync(), release: tagBehind })
  assert.equal(t.status, 'drift')
  assert.deepEqual(t.problems, [`the tag current is at ${C1.slice(0, 7)}, and the release's record says ${C2.slice(0, 7)}: Actions > current > Run workflow, on main`])
  assert.deepEqual(t.rows.at(-1), ['tag current', C1, 'another commit'])
  assert.match(judge({ ...inSync(), release: { ...releaseAt(C2), tag: null } }).problems[0], /^the tag current is at nothing, /)

  const noRecord = releaseAt(C2)
  delete noRecord.state.commit
  assert.match(judge({ ...inSync(), release: noRecord }).problems[0], /^the release has no record of the commit it holds \(current\.json\)/)
})

test('the bytes: a recorded file missing from the release, or there with another size or SHA-256, is red even when every commit agrees; not judged while a publish replaces files', () => {
  const swapped = releaseAt(C2)
  swapped.assets[3] = { ...swapped.assets[3], digest: `sha256:${sha256('something else')}` }
  const v = judge({ ...inSync(), release: swapped })
  assert.equal(v.status, 'drift')
  assert.deepEqual(v.problems, [`${swapped.assets[3].name} (${IDS[3]}) on the release is not the file its record names (size or SHA-256 differs)`])
  const resized = releaseAt(C2)
  resized.assets[0] = { ...resized.assets[0], size: 1 }
  assert.match(judge({ ...inSync(), release: resized }).problems[0], /is not the file its record names/)
  const lost = releaseAt(C2)
  const [gone] = lost.assets.splice(5, 1)
  assert.deepEqual(judge({ ...inSync(), release: lost }).problems, [`${gone.name} (${IDS[5]}) is in the release's record and not on the release`])
  // GitHub gives no digest for some old assets: the size alone is held then.
  const bare = releaseAt(C2)
  bare.assets = bare.assets.map((a) => ({ ...a, digest: null }))
  assert.equal(judge({ ...inSync(), release: bare }).status, 'in-sync')
  // Mid-publish (a staged record), files and record disagree by design: only "under way" is said.
  const mid = { ...swapped, staged: true }
  const w = judge({ ...inSync(), release: mid, runs: [{ workflow: 'current', created: at('17:40'), sha: C2 }] })
  assert.equal(w.status, 'settling')
  assert.deepEqual(w.problems, [])
})

test('the UEFI disk images say their commit themselves: the GUID in the image must be the one the recorded commit bakes; an image that could not be read is a warning', () => {
  const wrong = { ...inSync(), media: { ...inSync().media, 'uefi-x64': s.mediaGuid(C1, '') as string } }
  const v = judge(wrong)
  assert.equal(v.status, 'drift')
  assert.deepEqual(v.problems, [`crimson_noir_os.img carries the disk GUID ${s.mediaGuid(C1, '')}, which is not the one ${C2.slice(0, 7)} bakes (${s.mediaGuid(C2, '')}): the image is not the commit its record names`])
  // The architecture is part of the identity: the x86-64 GUID on the aarch64 image is not that commit's aarch64 image.
  const crossed = judge({ ...inSync(), media: { ...inSync().media, 'uefi-arm64': s.mediaGuid(C2, '') as string } })
  assert.equal(crossed.status, 'drift')
  assert.match(crossed.problems[0], /^crimson_noir_os-aarch64\.img carries the disk GUID /)
  const unread = judge({ ...inSync(), media: { 'uefi-x64': null, 'uefi-arm64': inSync().media['uefi-arm64'] } })
  assert.equal(unread.status, 'in-sync')
  assert.deepEqual(unread.warnings, ['crimson_noir_os.img: its disk GUID could not be read, so the image was not asked which commit it is'])
  // A target with no files is said once, as missing, not again as an unread image.
  const missing = releaseAt(C2, { 'uefi-arm64': null })
  assert.deepEqual(judge({ ...inSync(), release: missing, media: mediaOf(missing) }).warnings, [])

  // The GUID is build-image.sh's: the same words hashed, the same digits taken, for each architecture's image name.
  const sh = read('crimson_noir_os/tools/build-image.sh')
  assert.match(sh, /hex=\$\(printf '%s' "crimson-noir-media:\$arch_id\$id" \| sha256sum \| cut -c1-64\)/)
  assert.match(sh, /disk_guid=\$\(guid "\$\(echo "\$hex" \| cut -c1-32\)"\)/)
  assert.match(sh, /sgdisk -o -U "\$disk_guid" /)
  assert.match(sh, /x86_64-unknown-uefi\) boot=BOOTX64\.EFI; arch_id="" ;;/)
  assert.match(sh, /aarch64-unknown-uefi\) boot=BOOTAA64\.EFI; arch_id="aarch64:" ;;/)
  assert.deepEqual(s.MEDIA, { 'uefi-x64': { file: 'crimson_noir_os.img', arch: '' }, 'uefi-arm64': { file: 'crimson_noir_os-aarch64.img', arch: 'aarch64:' } })
  assert.deepEqual(Object.keys(s.MEDIA), IDS.filter((id) => id.startsWith('uefi-')), 'every UEFI target of the build matrix, and no other')
  const h = sha256(`crimson-noir-media:aarch64:${C2}`)
  assert.equal(s.mediaGuid(C2, 'aarch64:'), `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`)
  // The image published for ad3b3b9 on 21 November 2026 carried this GUID in its header (read from the release).
  assert.equal(s.mediaGuid('ad3b3b9b332b7a3fd18501a63c974f00542ee470'), '5c33923f-6ee4-20b2-8df6-b61701832cb5')

  // Reading it back out of a disk's first sectors: the header is the second sector, the GUID 56 bytes in, its first
  // three fields little-endian, as sgdisk writes the text it is given.
  const disk = Buffer.alloc(1024)
  disk.write('EFI PART', 512, 'latin1')
  Buffer.from('3f92335ce46eb2208df6b61701832cb5', 'hex').copy(disk, 512 + 56)
  assert.equal(s.diskGuid(disk), '5c33923f-6ee4-20b2-8df6-b61701832cb5')
  assert.equal(s.diskGuid(new Uint8Array(disk)), '5c33923f-6ee4-20b2-8df6-b61701832cb5')
  assert.equal(s.diskGuid(disk.subarray(0, 583)), null, 'cut short of the GUID')
  assert.equal(s.diskGuid(Buffer.alloc(1024)), null, 'no GPT header')
  assert.equal(s.diskGuid(Buffer.from('<html>Not Found</html>')), null)
  assert.equal(s.diskGuid(null), null)
})

test('a source that could not be read is not "in sync": unknown, with what could not be read', () => {
  for (const [over, said] of [
    [{ green: null }, /^no commit on main has passed ci, by ci's list of runs$/],
    [{ green: { error: 'gh api: HTTP 502' } }, /^the newest commit on main that ci passed on: gh api: HTTP 502$/],
    [{ web: { error: 'the site answered HTTP 503' } }, /^the web copy: the site answered HTTP 503$/],
    [{ release: { error: 'the release holds files but neither record' } }, /^the release: the release holds files but neither record$/],
  ] as [Partial<Facts>, RegExp][]) {
    const v = judge({ ...inSync(), ...over })
    assert.equal(v.status, 'unknown')
    assert.equal(v.problems.length, 1)
    assert.match(v.problems[0], said)
  }
  const all = judge({ ...inSync(), green: null, web: { error: 'a' }, release: { error: 'b' } })
  assert.equal(all.problems.length, 3, 'each unread source is named')
})

// ---------------------------------------------------------------------------------------------------------------
// The reading, against stand-ins for GitHub (`gh api`) and for https.

interface World {
  history: string[]
  green: string[]
  release: { state: State | null; staged: boolean; tag: string | null; extra?: string[] } | null
  runs: Record<string, Record<string, unknown>[]>
  site: Record<string, { status: number; body: string | Buffer }>
  media: Record<string, { status: number; body: Buffer } | 'fail'>
  fail?: (path: string) => string | null
}

function world(w: Partial<World> = {}): World {
  return { history: [C1, C2], green: [C1, C2], release: { state: releaseAt(C2).state, staged: false, tag: C2 }, runs: {}, site: { 'build.txt': { status: 200, body: `${cacheOf(C2)}\n` }, 'build.json': { status: 200, body: JSON.stringify(stampOf(C2)) } }, media: {}, ...w }
}

function gptWith(guid: string): Buffer {
  const hex = guid.replace(/-/g, '')
  const le = (from: number, to: number) => Buffer.from(hex.slice(from, to), 'hex').reverse()
  const disk = Buffer.alloc(1024)
  disk.write('EFI PART', 512, 'latin1')
  Buffer.concat([le(0, 8), le(8, 12), le(12, 16), Buffer.from(hex.slice(16), 'hex')]).copy(disk, 512 + 56)
  return disk
}

function standIns(w: World) {
  const asked: string[] = []
  const got: { url: string; range: string }[] = []
  const ok = (out: unknown) => ({ ok: true, out: typeof out === 'string' ? out : JSON.stringify(out), err: '' })
  const missing = { ok: false, out: '', err: 'gh: Not Found (HTTP 404)' }
  const assets = () => {
    if (!w.release) return []
    const files = w.release.state ? IDS.flatMap((id) => w.release?.state?.targets[id]?.files ?? []) : []
    const list = files.map((f, i) => ({ id: 100 + i, name: f.name, size: f.size, digest: `sha256:${f.sha256}` }))
    if (w.release.state) list.push({ id: 1, name: 'current.json', size: 10, digest: 'sha256:0' })
    if (w.release.staged) list.push({ id: 2, name: 'current.next.json', size: 10, digest: 'sha256:0' })
    for (const [i, name] of (w.release.extra ?? []).entries()) list.push({ id: 50 + i, name, size: 1, digest: 'sha256:0' })
    return list
  }
  const gh = (argv: string[]) => {
    assert.equal(argv[0], 'api', 'GitHub is only read')
    assert.ok(!argv.includes('-X') && !argv.includes('-f') && !argv.includes('-F'), `no write: ${argv.join(' ')}`)
    const path = argv[argv.length - 1].slice(`repos/${REPO}/`.length)
    asked.push(path)
    const failed = w.fail?.(path)
    if (failed) return { ok: false, out: '', err: failed }
    if (path === 'git/ref/heads/main') return ok({ object: { sha: w.history[w.history.length - 1] } })
    let k = /^compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)\?per_page=1$/.exec(path)
    if (k) {
      const [a, b] = [w.history.indexOf(k[1]), w.history.indexOf(k[2])]
      return ok({ status: a < 0 || b < 0 ? 'diverged' : b > a ? 'ahead' : b < a ? 'behind' : 'identical' })
    }
    if (path === 'actions/workflows/ci.yml/runs?branch=main&status=success&per_page=50') {
      return ok({ workflow_runs: [...w.history].reverse().filter((x) => w.green.includes(x)).map((sha) => ({ head_sha: sha, conclusion: 'success', head_branch: 'main', event: 'push', head_repository: { full_name: REPO }, html_url: `https://ci/${sha.slice(0, 7)}`, updated_at: at('17:00') })) })
    }
    k = /^actions\/workflows\/(web|current|ci)\.yml\/runs\?per_page=30$/.exec(path)
    if (k) return ok({ workflow_runs: w.runs[k[1]] ?? [] })
    k = /^releases\/tags\/([a-z-]+)$/.exec(path)
    if (k) return w.release && k[1] === 'current' ? ok({ id: 7, tag_name: 'current', body: '', assets: assets() }) : missing
    if (path === 'releases/assets/1' || path === 'releases/assets/2') return ok(JSON.stringify(w.release?.state))
    if (path === 'git/ref/tags/current') return w.release?.tag ? ok({ object: { sha: w.release.tag, type: 'commit' } }) : missing
    return { ok: false, out: '', err: `unexpected call ${argv.join(' ')}` }
  }
  const get = async (url: string, { range = '' }: { range?: string } = {}) => {
    got.push({ url, range })
    if (url.startsWith(SITE)) {
      const file = url.slice(SITE.length).split('?')[0]
      const a = w.site[file]
      if (!a) return { status: 404, bytes: Buffer.from('not found') }
      return { status: a.status, bytes: Buffer.from(a.body) }
    }
    const k = /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/current\/(.+)$/.exec(url)
    if (k) {
      const a = w.media[k[1]]
      if (a === 'fail') throw new Error('connection reset')
      return a ? { status: a.status, bytes: a.body } : { status: 404, bytes: Buffer.alloc(0) }
    }
    throw new Error(`unexpected address ${url}`)
  }
  return { gh, get, asked, got }
}

const bothImages = (commit: string) => ({ 'crimson_noir_os.img': { status: 206, body: gptWith(s.mediaGuid(commit, '')) }, 'crimson_noir_os-aarch64.img': { status: 206, body: gptWith(s.mediaGuid(commit, 'aarch64:')) } })

test('gather reads the newest green commit, the site past every cache, the release with its record, tag and files, the head of each disk image, and the runs on main that have not ended; then the verdict is in sync', async () => {
  const w = world({
    media: bothImages(C2),
    runs: {
      web: [{ status: 'completed', conclusion: 'skipped', head_branch: 'main', event: 'workflow_run', head_sha: C2, updated_at: at('17:20') }, { status: 'completed', conclusion: 'success', head_branch: 'main', event: 'workflow_run', head_sha: C2, updated_at: at('17:05') }, { status: 'completed', conclusion: 'success', head_branch: 'main', event: 'workflow_run', head_sha: C1, updated_at: at('12:00') }],
      current: [
        { status: 'in_progress', head_branch: 'claude/thread', event: 'pull_request', head_sha: commitOf(9), run_started_at: at('17:50') },
        { status: 'queued', head_branch: 'main', event: 'workflow_run', head_sha: C2, created_at: at('17:40') },
        { status: 'in_progress', head_branch: 'main', event: 'workflow_dispatch', head_sha: C2, run_started_at: at('17:45'), created_at: at('17:44') },
        { status: 'completed', conclusion: 'success', head_branch: 'main', event: 'workflow_run', head_sha: C1 },
      ],
      ci: [{ status: 'in_progress', head_branch: 'main', event: 'push', head_sha: C3, run_started_at: at('17:55') }, { status: 'in_progress', head_branch: 'claude/thread', event: 'push', head_sha: commitOf(9), run_started_at: at('17:56') }],
    },
  })
  const io = standIns(w)
  const f: Facts = await s.gather({ repo: REPO, now: at('18:00') }, io.gh, io.get)
  assert.deepEqual(f.green, { sha: C2, ci: `https://ci/${C2.slice(0, 7)}`, at: at('17:00') })
  assert.equal(f.tip, C2)
  assert.deepEqual(f.web, { stamp: stampOf(C2), probe: cacheOf(C2) })
  assert.ok(f.release && !('error' in f.release))
  assert.equal(f.release.state.commit, C2)
  assert.equal(f.release.staged, false)
  assert.equal(f.release.tag, C2)
  assert.equal(f.release.assets.length, IDS.length + 1, 'every file and the record')
  assert.deepEqual(f.media, { 'uefi-x64': s.mediaGuid(C2, ''), 'uefi-arm64': s.mediaGuid(C2, 'aarch64:') })
  // Only main's runs that have not ended, never a pull request's dry run or another branch's ci; a run's start, or
  // its creation while it waits for a runner.
  assert.deepEqual(f.runs, [
    { workflow: 'current', created: at('17:40'), sha: C2 },
    { workflow: 'current', created: at('17:45'), sha: C2 },
    { workflow: 'ci', created: at('17:55'), sha: C3 },
  ])
  assert.equal(f.served, at('17:05'), 'the last web run that passed, not the skipped one after it')
  assert.equal(f.runsError, undefined)
  assert.equal(s.verdict(f).status, 'in-sync')
  // The site is asked under an address no cache has seen, the images for their first sectors alone.
  const salt = `?sync=${encodeURIComponent(at('18:00'))}`
  assert.deepEqual(io.got, [
    { url: `${SITE}build.txt${salt}`, range: '' },
    { url: `${SITE}build.json${salt}`, range: '' },
    { url: `https://github.com/${REPO}/releases/download/current/crimson_noir_os.img`, range: 'bytes=0-1023' },
    { url: `https://github.com/${REPO}/releases/download/current/crimson_noir_os-aarch64.img`, range: 'bytes=0-1023' },
  ])
  assert.equal(s.siteOf('Cassius-Software/Some.Repo'), 'https://cassius-software.github.io/Some.Repo/', 'the owner in lower case, the name as it is')
})

test('gather keeps each failure where it belongs: a site without a stamp, a site that fails, a release that cannot be read, images that cannot be read, runs that cannot be listed', async () => {
  // No build.json yet (a copy published before the stamp): null, and the verdict calls the web copy behind.
  const before = standIns(world({ site: { 'build.txt': { status: 200, body: `${cacheOf(C1)}\n` } }, media: bothImages(C2) }))
  const f1: Facts = await s.gather({ repo: REPO, now: at('18:00') }, before.gh, before.get)
  assert.deepEqual(f1.web, { stamp: null, probe: cacheOf(C1) })
  assert.equal(s.verdict(f1).status, 'drift')

  for (const [site, said] of [
    [{ 'build.txt': { status: 503, body: '' } }, /build\.txt answered HTTP 503$/],
    [{}, /build\.txt answered HTTP 404$/],
    [{ 'build.txt': { status: 200, body: '<html>a sign-in page</html>' } }, /build\.txt is not a build's name: "<html>a sign-in page<\/html>"$/],
    [{ 'build.txt': { status: 200, body: `${cacheOf(C2)}\n` }, 'build.json': { status: 500, body: '' } }, /build\.json answered HTTP 500$/],
    [{ 'build.txt': { status: 200, body: `${cacheOf(C2)}\n` }, 'build.json': { status: 200, body: 'not json' } }, /build\.json is not JSON$/],
    [{ 'build.txt': { status: 200, body: `${cacheOf(C2)}\n` }, 'build.json': { status: 200, body: JSON.stringify({ schema: 1, commit: 'main' }) } }, /build\.json names no commit$/],
    [{ 'build.txt': { status: 200, body: `${cacheOf(C2)}\n` }, 'build.json': { status: 200, body: JSON.stringify({ ...stampOf(C2), schema: 2 }) } }, /build\.json names no commit$/],
    [{ 'build.txt': { status: 200, body: `${cacheOf(C2)}\n` }, 'build.json': { status: 200, body: 'null' } }, /build\.json names no commit$/],
  ] as [World['site'], RegExp][]) {
    const io = standIns(world({ site, media: bothImages(C2) }))
    const f: Facts = await s.gather({ repo: REPO, now: at('18:00') }, io.gh, io.get)
    assert.ok('error' in f.web, JSON.stringify(site))
    assert.match(f.web.error, said)
    assert.equal(s.verdict(f).status, 'unknown')
  }
  const down = standIns(world())
  const f2: Facts = await s.gather({ repo: REPO, now: at('18:00') }, down.gh, async () => { throw new Error('getaddrinfo ENOTFOUND') })
  assert.deepEqual(f2.web, { error: `${SITE} could not be read (getaddrinfo ENOTFOUND)` })
  assert.deepEqual(f2.media, { 'uefi-x64': null, 'uefi-arm64': null }, 'the images too: a warning each, were the rest readable')

  // The release: none at all; files without a record; GitHub not answering.
  const none = standIns(world({ release: null }))
  const f3: Facts = await s.gather({ repo: REPO, now: at('18:00') }, none.gh, none.get)
  assert.equal(f3.release, null)
  assert.deepEqual(f3.media, {})
  const bare = standIns(world({ release: { state: null, staged: false, tag: C2, extra: ['orphan.bin'] } }))
  const f4: Facts = await s.gather({ repo: REPO, now: at('18:00') }, bare.gh, bare.get)
  assert.ok(f4.release && 'error' in f4.release)
  assert.match(f4.release.error, /holds files but neither current\.json nor current\.next\.json/)
  const refused = standIns(world({ fail: (p) => (p.startsWith('releases/tags/') ? 'gh: Server Error (HTTP 500)' : null) }))
  const f5: Facts = await s.gather({ repo: REPO, now: at('18:00') }, refused.gh, refused.get)
  assert.ok(f5.release && 'error' in f5.release)
  assert.equal(s.verdict(f5).status, 'unknown')
  // A staged record is the newer of the two, and is said.
  const staged = standIns(world({ release: { state: releaseAt(C2).state, staged: true, tag: C2 }, media: bothImages(C2) }))
  const f6: Facts = await s.gather({ repo: REPO, now: at('18:00') }, staged.gh, staged.get)
  assert.ok(f6.release && !('error' in f6.release) && f6.release.staged)

  // The newest green commit: GitHub not answering is an error kept in its place, nothing green is null.
  const mute = standIns(world({ fail: (p) => (p.startsWith('actions/workflows/ci.yml/runs?branch=main') ? 'gh: Bad Gateway (HTTP 502)' : null), media: bothImages(C2) }))
  const f7: Facts = await s.gather({ repo: REPO, now: at('18:00') }, mute.gh, mute.get)
  assert.ok(f7.green && 'error' in f7.green)
  assert.match(f7.green.error, /HTTP 502/)
  const red = standIns(world({ green: [], media: bothImages(C2) }))
  assert.equal(((await s.gather({ repo: REPO, now: at('18:00') }, red.gh, red.get)) as Facts).green, null)

  // An image that answers 404, a page, or nothing: null, and a warning in the verdict, never red on its own.
  const odd = standIns(world({ media: { 'crimson_noir_os.img': { status: 404, body: Buffer.alloc(0) }, 'crimson_noir_os-aarch64.img': 'fail' } }))
  const f8: Facts = await s.gather({ repo: REPO, now: at('18:00') }, odd.gh, odd.get)
  assert.deepEqual(f8.media, { 'uefi-x64': null, 'uefi-arm64': null })
  const v8: Verdict = s.verdict(f8)
  assert.equal(v8.status, 'in-sync')
  assert.equal(v8.warnings.length, 2)
  const page = standIns(world({ media: { ...bothImages(C2), 'crimson_noir_os.img': { status: 200, body: Buffer.from('<html>') } } }))
  assert.equal(((await s.gather({ repo: REPO, now: at('18:00') }, page.gh, page.get)) as Facts).media['uefi-x64'], null)

  // Runs that cannot be listed: nothing counts as on its way, and the report says why "behind" reads as drift.
  const blind = standIns(world({ release: { state: releaseAt(C1).state, staged: false, tag: C1 }, media: bothImages(C1), fail: (p) => (/^actions\/workflows\/[a-z]+\.yml\/runs\?per_page=30$/.test(p) ? 'gh: rate limit (HTTP 403)' : null) }))
  const f9: Facts = await s.gather({ repo: REPO, now: at('18:00') }, blind.gh, blind.get)
  assert.match(f9.runsError ?? '', /rate limit/)
  assert.deepEqual(f9.runs, [])
  const v9: Verdict = s.verdict(f9)
  assert.equal(v9.status, 'drift')
  assert.ok(s.report(v9, f9).lines.some((l: string) => /^::warning::the runs under way could not be listed \(.*rate limit.*\), so nothing counts as on its way$/.test(l)))
})

test('the report and the command line: one line each in the log, red for wrong, a table for the summary; exit 0 in sync or settling, 1 for drift, 2 for unknown; --report-only never red for what it finds', async () => {
  const out: string[] = []
  const err: string[] = []
  const [log, error] = [console.log, console.error]
  console.log = (...a: unknown[]) => { out.push(a.join(' ')) }
  console.error = (...a: unknown[]) => { err.push(a.join(' ')) }
  const dir = mkdtempSync(join(tmpdir(), 'sync-check-'))
  try {
    const summary = join(dir, 'summary.md')
    const good = standIns(world({ media: bothImages(C2) }))
    assert.equal(await s.main(['check', '--repo', REPO, '--summary', summary], good.gh, good.get), 0)
    assert.deepEqual(out.splice(0), [`in sync: the web copy and every download are built from ${C2}`])
    const text = readFileSync(summary, 'utf8')
    assert.match(text, /^## Is everything published from one commit\?\n\n\*\*in sync: /)
    assert.match(text, /\| What \| Commit \| \|\n\| :--- \| :--- \| :--- \|\n\| main, newest commit ci passed on \| `[0-9a-f]{7}` \| ci passed 2026-11-21T17:00:00Z \|\n\| web copy \| `[0-9a-f]{7}` \| same commit \|/)
    assert.match(text, /\| &nbsp;&nbsp;uefi-x64 \| `[0-9a-f]{7}` \| same commit \|/)
    assert.ok(!text.includes('**Wrong**') && !text.includes('**On its way**'))

    // Drift: the release a commit behind, nothing running. The look is hours after ci passed (the real clock).
    const behind = () => standIns(world({ release: { state: releaseAt(C1).state, staged: false, tag: C1 }, media: bothImages(C1) }))
    let io = behind()
    assert.equal(await s.main(['check', '--repo', REPO, '--summary', summary], io.gh, io.get), 1)
    const lines = out.splice(0)
    assert.equal(lines[0], 'drift: what is published does not come from one commit, and nothing is on its way to mend it')
    assert.ok(lines.includes(`::error::the downloads are built from ${C1.slice(0, 7)}, not ${C2.slice(0, 7)}: Actions > current > Run workflow, on main`))
    assert.ok(lines.includes(`::warning::ios-ipa is built from ${C1.slice(0, 7)}, not ${C2.slice(0, 7)} (best effort: it never turns a publish red)`))
    assert.match(readFileSync(summary, 'utf8'), /\n\*\*Wrong\*\*\n\n- the downloads are built from /)
    io = behind()
    assert.equal(await s.main(['check', '--repo', REPO, '--report-only'], io.gh, io.get), 0, 'a pull request\'s look')
    assert.equal(out.splice(0)[0].startsWith('drift: '), true, 'said all the same')

    // Unknown: the site does not answer.
    const dark = standIns(world({ site: {}, media: bothImages(C2) }))
    assert.equal(await s.main(['check', '--repo', REPO], dark.gh, dark.get), 2)
    assert.match(out.splice(0).join('\n'), /^unknown: what is published could not be read, so nothing is vouched for\n::error::the web copy: .*build\.txt answered HTTP 404$/)
    assert.equal(await s.main(['check', '--repo', REPO, '--report-only'], dark.gh, dark.get), 0)
    out.splice(0)

    // Another site can be named, an https address ending in a slash; the repository must be named.
    const moved = standIns(world({ media: bothImages(C2) }))
    assert.equal(await s.main(['check', '--repo', REPO, '--site', 'https://example.org/city/'], moved.gh, async (url: string, o: { range?: string }) => moved.get(url.replace('https://example.org/city/', SITE), o)), 0)
    out.splice(0)
    for (const bad of ['http://example.org/', 'https://example.org', 'example.org/']) assert.equal(await s.main(['check', '--repo', REPO, '--site', bad], moved.gh, moved.get), 1, bad)
    assert.match(err.splice(0).join('\n'), /::error::--site must be an https address ending in a slash/)
    assert.equal(await s.main(['check', '--repo', 'nonsense'], moved.gh, moved.get), 1)
    assert.match(err.splice(0).join('\n'), /::error::GH_REPO \(or --repo owner\/name\) must name the repository/)
    assert.equal(await s.main(['publish'], moved.gh, moved.get), 1, 'it has one command, and it only reads')
    assert.equal(await s.main(['--help'], moved.gh, moved.get), 0)
    assert.equal(await s.main([], moved.gh, moved.get), 0)
    assert.ok(out.splice(0).every((l) => l.startsWith('usage: node tools/build/sync.mjs check ')))
  } finally {
    console.log = log
    console.error = error
    rmSync(dir, { recursive: true, force: true })
  }
})

test('realGet reads only the first bytes it was asked for, even from a host that ignores the range and sends everything', async () => {
  const { createServer } = await import('node:http')
  const seen: (string | undefined)[] = []
  let sent = 0
  const server = createServer((req, res) => {
    seen.push(req.headers.range)
    if (req.url === '/missing') { res.writeHead(404); res.end('no'); return }
    // A host that ignores the range: 64 MiB of image, in pieces (more than the sockets between them could hold unread), with a GPT header where one belongs.
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    const first = gptWith(s.mediaGuid(C2, ''))
    res.write(first)
    sent = first.length
    const more = () => {
      if (res.destroyed || sent >= 64 << 20) { res.end(); return }
      sent += 65536
      if (res.write(Buffer.alloc(65536))) setImmediate(more)
      else res.once('drain', more)
    }
    more()
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  try {
    const port = (server.address() as { port: number }).port
    const got = await s.realGet(`http://127.0.0.1:${port}/disk.img`, { range: 'bytes=0-1023' })
    assert.equal(got.status, 200)
    assert.equal(got.bytes.length, 1024, 'the first sectors and no more')
    assert.equal(s.diskGuid(got.bytes), s.mediaGuid(C2, ''))
    assert.equal(seen[0], 'bytes=0-1023', 'the range is asked for')
    assert.ok(sent < 64 << 20, 'and the rest was never read')
    // Without a range the whole (small) answer is read; a 4xx is an answer, not a failure to be tried again.
    const none = await s.realGet(`http://127.0.0.1:${port}/missing`)
    assert.deepEqual([none.status, none.bytes.toString()], [404, 'no'])
    assert.equal(seen.length, 2, 'asked once each')
  } finally {
    server.closeAllConnections()
    await new Promise((done) => server.close(done))
  }
})

test('sync.mjs loads from a checkout of tools/ alone, as the workflow checks out, and asks GitHub for nothing but reads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-tools-'))
  try {
    cpSync(join(ROOT, 'tools'), join(dir, 'tools'), { recursive: true })
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', `const x = await import(${JSON.stringify(join(dir, 'tools', 'build', 'sync.mjs'))}); console.log(typeof x.verdict, typeof x.gather)`], { cwd: dir, encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    assert.equal(run.stdout.trim(), 'function function')
  } finally { rmSync(dir, { recursive: true, force: true }) }
  const tool = read('tools/build/sync.mjs')
  // Every call to GitHub in the tool itself is a plain `gh api <path>`: no method, no field, no `gh release`.
  assert.doesNotMatch(tool, /'-X'|'-f'|'-F'|'--method'|\['release'|\['workflow'|\['run'/)
  assert.equal((tool.match(/gh\(\[/g) ?? []).length, 1, 'one call of its own, the runs; the rest go through current.mjs\'s readers')
  assert.match(tool, /const r = gh\(\['api', `repos\/\$\{repo\}\/actions\/workflows\/\$\{file\}\/runs\?per_page=30`\]\)/)
  // And of current.mjs it takes the readers alone, never publish or the tag's movers.
  const taken = /import \{ ([^}]+) \} from '\.\/current\.mjs'/.exec(tool)?.[1].split(', ') ?? []
  assert.deepEqual(taken, ['BEST_EFFORT', 'STAGED', 'TAG', 'choose', 'getRelease', 'mainTip', 'readState', 'realGh', 'tagAt'])
})

test('the workflow: after each run of web or current on main, every hour, by hand, and on a pull request that changes it (report only); read access alone; GitHub\'s own actions', () => {
  assert.match(WORKFLOW, /^on:\n {2}workflow_run:\n {4}workflows: \[web, current\]\n {4}types: \[completed\]\n {4}branches: \[main\]\n {2}schedule:\n {4}- cron: '23 \* \* \* \*'\n {2}workflow_dispatch:\n {2}pull_request:\n {4}paths:\n {6}- \.github\/workflows\/sync\.yml\n {6}- tools\/build\/sync\.mjs\n {6}- tools\/build\/current\.mjs\n {6}- tools\/build\/matrix\.mjs\n\npermissions/m)
  assert.match(WORKFLOW, /^permissions: \{\}$/m)
  const jobs = WORKFLOW.split(/^jobs:$/m)[1] ?? ''
  assert.deepEqual(jobs.match(/^ {2}[a-z-]+:$/gm), ['  check:'], 'one job')
  assert.match(jobs, /\n {4}permissions:\n {6}contents: read\n {6}actions: read\n {4}steps:/)
  assert.doesNotMatch(WORKFLOW, /: write\b/, 'it can write nothing')
  assert.doesNotMatch(WORKFLOW, /secrets\./, 'and holds no secret but the run\'s own read token')
  // A publisher's skipped run (a ci that did not pass) starts no look; a fork's branch named main neither.
  assert.match(jobs, /if: >-\n {6}github\.event_name != 'workflow_run' \|\|\n {6}\(github\.event\.workflow_run\.conclusion != 'skipped' &&\n {6}github\.event\.workflow_run\.head_branch == 'main' &&\n {6}github\.event\.workflow_run\.head_repository\.full_name == github\.repository\)\n/)
  assert.match(jobs, /- uses: actions\/checkout@v4\n {8}with:\n {10}persist-credentials: false\n {10}sparse-checkout: tools\n/)
  // Red for what it finds everywhere but on a pull request, whose run reports.
  assert.match(jobs, /REPORT_ONLY: \$\{\{ github\.event_name == 'pull_request' \}\}\n {8}run: \|\n {10}args=\(check --summary "\$GITHUB_STEP_SUMMARY"\)\n {10}if \[ "\$REPORT_ONLY" = true \]; then args\+=\(--report-only\); fi\n {10}node tools\/build\/sync\.mjs "\$\{args\[@\]\}"\n$/)
  assert.doesNotMatch(jobs, /continue-on-error|\|\| true|\|\| exit 0/, 'nothing swallows its exit')
  assert.match(WORKFLOW, /^concurrency:\n {2}group: \$\{\{ github\.event_name == 'pull_request' && format\('sync-pr-\{0\}', github\.event\.pull_request\.number\) \|\| 'sync' \}\}\n {2}cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}$/m)
  for (const line of WORKFLOW.split('\n').filter((l) => /^\s*(- )?uses:/.test(l))) assert.match(line, /uses: actions\/[a-z-]+@v\d+$/, line)
  assert.doesNotMatch(WORKFLOW, /persist-credentials: true/)
  // The two publishers it follows are the two that publish: their names are their workflows' names.
  assert.match(read('.github/workflows/web.yml'), /^name: web$/m)
  assert.match(read('.github/workflows/current.yml'), /^name: current$/m)
})

test('one version: the product\'s is package.json\'s wherever it is typed again, and Crimson Noir OS keeps its own, the one sealed into its containment files', () => {
  const version = (JSON.parse(read('package.json')) as { version: string }).version
  assert.match(version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/)
  // Typed by hand in three more places, and copied by the tools into two lock files.
  assert.equal(/^ {2}version: '([^']+)',$/m.exec(read('src/brand.ts'))?.[1], version, 'src/brand.ts (what the page, the stamp and the worker\'s cache name show)')
  const shell = /^\[package\]\nname = "crimson-noir-app"\nversion = "([^"]+)"$/m.exec(read('src-tauri/Cargo.toml'))
  assert.equal(shell?.[1], version, 'src-tauri/Cargo.toml (the apps)')
  assert.equal(/\[\[package\]\]\nname = "crimson-noir-app"\nversion = "([^"]+)"/.exec(read('src-tauri/Cargo.lock'))?.[1], version, 'src-tauri/Cargo.lock')
  const lock = JSON.parse(read('package-lock.json')) as { version: string; packages: Record<string, { version: string }> }
  assert.deepEqual([lock.version, lock.packages[''].version], [version, version], 'package-lock.json')
  // The shell's configuration names no version of its own: it reads package.json's.
  assert.equal((JSON.parse(read('src-tauri/tauri.conf.json')) as { version: string }).version, '../package.json')
  // The web copy's stamp and the release's record take theirs from the same two files at build time.
  assert.match(read('tools/web/pwa.mjs'), /JSON\.parse\(readFileSync\(join\(ROOT, 'package\.json'\), 'utf8'\)\)\.version/)
  assert.match(read('tools/build/current.mjs'), /package\.json/)

  // Crimson Noir OS: its own version in each of its crates and in the containment files that are sealed.
  const os = /^\[package\]\nname = "crimson_noir_os"\nversion = "([^"]+)"$/m.exec(read('crimson_noir_os/Cargo.toml'))?.[1]
  assert.match(os ?? '', /^\d+\.\d+\.\d+$/)
  assert.notEqual(os, version, 'two schemes, by design (CHANGELOG.md, "Version numbers")')
  assert.equal(/^\[package\]\nname = "crimson_boot"\nversion = "([^"]+)"$/m.exec(read('crimson_noir_os/boot/Cargo.toml'))?.[1], os, 'the boot crate')
  const locked = read('crimson_noir_os/Cargo.lock')
  for (const crate of ['crimson_boot', 'crimson_noir_os', 'noir_core']) {
    assert.equal(new RegExp(`\\[\\[package\\]\\]\\nname = "${crate}"\\nversion = "([^"]+)"`).exec(locked)?.[1], os, `Cargo.lock: ${crate}`)
  }
  assert.equal(/^ {4}version = "([^"]+)";$/m.exec(read('crimson_noir_os/containment.nix'))?.[1], os, 'containment.nix')
  assert.equal(/^ {2}system\.version = "([^"]+)";$/m.exec(read('crimson_noir_os/containment.canonical'))?.[1], os, 'containment.canonical')
  assert.match(read('CHANGELOG.md'), new RegExp(`Crimson Noir OS keeps its own crate and containment\\nversion, \`${os?.replace(/\./g, '\\.')}\``))
})
