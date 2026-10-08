#!/usr/bin/env node
// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
/**
 * Why does this file exist? It mints a session token for the authoritative host, offline, from the operator's secret:
 * one per player and one per Crimson Noir OS runtime. A subject is one connection (a second under the same name
 * replaces the first), so a deployment needs a token for each, not the one the host prints at start-up (a deployment
 * whose logs are kept turns that print off with NET_PRINT_TOKEN=0).
 * The secret is read the way the host reads it: NET_SECRET_FILE (a file, a container's secret) or NET_SECRET. The token
 * alone goes to standard output, so it can be piped straight into a client's environment; everything else goes to
 * standard error. A token cannot be revoked before it expires except by changing the secret (which ends them all), so
 * its life is capped at a week.
 * Usage: node tools/net/mint-token.mjs SUBJECT [HOURS]   (in the container: docker compose exec host
 *        /nodejs/bin/node tools/net/mint-token.mjs SUBJECT [HOURS])
 * What breaks if it is removed? A deployment can admit only the one subject whose token the host printed.
 */
import { readFileSync } from 'node:fs'
import { MIN_SECRET, mintToken, TOKEN_TTL_MS } from '../../src/10_Network/replication.node.ts'

const MAX_HOURS = 7 * 24
const [subject, hoursText] = process.argv.slice(2)
const fail = (why) => {
  console.error(`mint-token: ${why}\nusage: node tools/net/mint-token.mjs SUBJECT [HOURS] (secret from NET_SECRET_FILE or NET_SECRET)`)
  process.exit(2)
}

if (subject === undefined) fail('no subject')
if (!/^[\w .-]{1,24}$/.test(subject)) fail('a subject is 1 to 24 letters, digits, spaces, dots, dashes or underscores')
const hours = hoursText === undefined ? TOKEN_TTL_MS / 3_600_000 : Number(hoursText)
if (!(Number.isFinite(hours) && hours > 0 && hours <= MAX_HOURS)) fail(`HOURS must be more than 0 and at most ${MAX_HOURS}`)
const { NET_SECRET: inline, NET_SECRET_FILE: file } = process.env
if (inline !== undefined && file !== undefined) fail('set NET_SECRET or NET_SECRET_FILE, not both')
if (inline === undefined && file === undefined) fail('no secret: set NET_SECRET_FILE (or NET_SECRET) to the host\'s')
const secret = file !== undefined ? readFileSync(file, 'utf8').replace(/\r?\n$/, '') : inline
if (secret.length < MIN_SECRET) fail(`the secret is shorter than the host accepts (${MIN_SECRET} characters)`)

const expires = Date.now() + Math.round(hours * 3_600_000)
console.log(mintToken(secret, subject, expires))
console.error(`a token for '${subject}', good until ${new Date(expires).toISOString()}`)
