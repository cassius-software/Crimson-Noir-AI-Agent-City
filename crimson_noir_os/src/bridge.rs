//! Why does this file exist? It is the hosted runtime's bridge to the Phase 12 authoritative host (the `bridge`
//! command). The bootable image never takes part: it has no network code and its configuration refuses one. A run:
//! 1. The self-test's scripted run, recorded (ledger.rs). The ledger must fold to the matrix's weights exactly before
//!    anything leaves this process.
//! 2. A sealed session on the host's ledger door (`crimson.1`, wire.rs): the locked configuration's canonical text
//!    (the host checks its SHA-256 against the operator's pinned containment.lock), the entries in chunks, then the
//!    seal (head, count, the weights' digest). The host replays the fold under the containment rules and answers
//!    `verified`, or `refused` with the reason and a close.
//! 3. The fleet sync. A second runtime starts fresh, with no learned weights. It fetches the weights of the last
//!    verified ledger of its configuration, checks them itself (digest, range, only roles declared with `learn`), and
//!    adopts them; they must equal the first runtime's, bit for bit.
//!
//! The token comes from the environment (CRIMSON_TOKEN, minted by the host's operator), never the command line, where
//! other users of the machine could read it.
//! What breaks if it is removed? Nothing on the image; the runtime cannot have its learning verified or shared.

use std::time::Instant;

use noir_core::config::Dims;
use noir_core::matrix;

use crate::ledger::{self, Ledger};
use crate::wire::{Json, Sealed, Ws};

/// The ledger door's subprotocol, and the entries one message carries (ledger.ts LEDGER_SUBPROTOCOL, LEDGER_CHUNK).
pub const PROTOCOL: &str = "crimson.1";
pub const CHUNK: usize = 64;

/// What the locked configuration gives the bridge.
pub struct Locked<'a> {
    pub canonical: &'a str,
    pub dims: Dims,
    pub role_counts: &'a [u32],
    pub role_caps: &'a [u32],
}

fn t(kind: &str) -> (&'static str, Json) {
    ("t", Json::Str(kind.to_string()))
}

/// The next message, which must be of kind `want`; a `refused` is an error carrying the host's reason.
fn expect(s: &mut Sealed, want: &str) -> Result<Json, String> {
    let m = s.recv()?;
    match m.str("t") {
        Some(k) if k == want => Ok(m),
        Some("refused") => Err(format!("refused: {}", m.str("reason").unwrap_or("?"))),
        other => Err(format!("expected '{want}', the host sent {other:?}")),
    }
}

/// A session on the door, greeted: the host's `ready` must name the configuration's digest.
pub fn session(url: &str, token: &str, lk: &Locked) -> Result<Sealed, String> {
    let mut s = Sealed::new(Ws::connect(url, PROTOCOL, token)?, token);
    s.send(&Json::obj(&[t("hello"), ("v", Json::Int(1)), ("config", Json::Str(lk.canonical.to_string()))]))?;
    let ready = expect(&mut s, "ready")?;
    let digest = crate::wire::sha256_hex(lk.canonical.as_bytes());
    if ready.str("digest") != Some(digest.as_str()) {
        return Err(String::from("the host's ready names another configuration"));
    }
    Ok(s)
}

/// Sends a ledger in chunks and then its seal; the host's verdict. A host that refuses an entry closes the session
/// while chunks are still going out: a send that fails then gives way to the reason the host sent before it closed.
pub fn submit(s: &mut Sealed, l: &Ledger, weights: &[i32]) -> Result<Json, String> {
    let mut sent = Ok(());
    for chunk in l.entries.chunks(CHUNK) {
        let list = Json::Arr(chunk.iter().map(Ledger::json).collect());
        sent = s.send(&Json::obj(&[t("entries"), ("list", list)]));
        if sent.is_err() {
            break;
        }
    }
    if sent.is_ok() {
        let count = Json::Int(l.entries.len() as i64);
        let digest = Json::Str(ledger::weights_digest(weights));
        sent = s.send(&Json::obj(&[t("seal"), ("head", Json::Str(l.head().to_string())), ("count", count), ("weights", digest)]));
    }
    match (sent, expect(s, "verified")) {
        (Ok(()), verdict) => verdict,
        (Err(_), Err(reason)) if reason.starts_with("refused") => Err(reason),
        (Err(e), _) => Err(e),
    }
}

/// Weights as the host shares them: [index, weight] pairs in index order, and the digest it sealed them under.
pub type Shared = (Vec<(i64, i64)>, String);

/// Fetches the weights of the last verified ledger of this configuration. None when nothing has verified yet.
pub fn fetch(s: &mut Sealed) -> Result<Option<Shared>, String> {
    s.send(&Json::obj(&[t("fetch")]))?;
    let mut got: Vec<(i64, i64)> = Vec::new();
    loop {
        let m = s.recv()?;
        match m.str("t") {
            Some("none") => return Ok(None),
            Some("weights") => {
                let Some(Json::Arr(list)) = m.get("list") else { return Err(String::from("a weights message without a list")) };
                for pair in list {
                    match pair {
                        Json::Arr(p) if p.len() == 2 => match (&p[0], &p[1]) {
                            (Json::Int(i), Json::Int(w)) => got.push((*i, *w)),
                            _ => return Err(String::from("a weight that is not two whole numbers")),
                        },
                        _ => return Err(String::from("a weight that is not a pair")),
                    }
                }
            }
            Some("end") => {
                if m.int("pairs") != Some(got.len() as i64) {
                    return Err(String::from("the host's end does not count the weights it sent"));
                }
                let digest = m.str("weights").ok_or_else(|| String::from("an end without the weights' digest"))?;
                return Ok(Some((got, digest.to_string())));
            }
            Some("refused") => return Err(format!("refused: {}", m.str("reason").unwrap_or("?"))),
            other => return Err(format!("the host sent {other:?} during a fetch")),
        }
    }
}

/// The whole sync: record the scripted run, check the ledger against the matrix, have the host verify it, then start a
/// second runtime from nothing and have it fetch, check and adopt the verified weights. They must be the first's.
pub fn run(url: &str, token: &str, lk: &Locked) -> Result<(), String> {
    let d = &lk.dims;
    let started = Instant::now();
    let (a, proof, l) = ledger::record_golden(d, lk.role_counts, lk.role_caps);
    if ledger::fold(d, &l.entries) != a.weights {
        return Err(String::from("the recorded ledger does not fold to the matrix's weights; nothing was sent"));
    }
    let learned = l.entries.iter().filter(|e| e.body[0] == ledger::LEARN).count();
    println!(
        "recorded: {} ticks, {} entries ({learned} learns, {} wipes), head {}",
        proof.tick,
        l.entries.len(),
        l.entries.len() - learned,
        l.head()
    );
    let digest = ledger::weights_digest(&a.weights);
    println!("folded: {} non-zero weights, digest {digest}", ledger::pairs(&a.weights).len());

    let mut s = session(url, token, lk)?;
    let verdict = submit(&mut s, &l, &a.weights)?;
    s.ws.close();
    if verdict.str("head") != Some(l.head()) || verdict.str("weights") != Some(digest.as_str()) {
        return Err(String::from("the host verified another ledger than the one sent"));
    }
    println!("verified by the host: the fold holds under the containment rules");

    // The fleet sync: a second runtime, started the same way but with nothing learned.
    let mut b = matrix::new(d);
    let _ = matrix::golden_begin(d, lk.role_counts, lk.role_caps, &mut b);
    if b.weights.iter().any(|&w| w != 0) {
        return Err(String::from("a fresh runtime already holds weights"));
    }
    let mut s = session(url, token, lk)?;
    let fetched = fetch(&mut s)?;
    s.ws.close();
    let Some((list, sealed)) = fetched else { return Err(String::from("the host holds no verified weights")) };
    if sealed != digest {
        return Err(String::from("the host shared weights sealed under another digest"));
    }
    let n = ledger::adopt(d, lk.role_counts, lk.role_caps, &list, &sealed, &mut b)?;
    if b.weights != a.weights {
        return Err(String::from("the adopted weights are not the first runtime's"));
    }
    println!("fleet sync: a fresh runtime adopted {n} weights, bit-exact ({:.0?})", started.elapsed());
    Ok(())
}

/// Run by tools/net/bridge-smoke.mjs against a live host (CRIMSON_URL, CRIMSON_TOKEN), after an honest `bridge` run:
/// `cargo test -- --ignored a_tampered_ledger`. Each tampered ledger must be refused, and none of them may become what
/// the host shares: a fetch afterwards still returns the honest run's weights.
#[cfg(test)]
mod live {
    use super::*;
    use noir_core::config::{parse, validate};

    fn relinked(bodies: impl Iterator<Item = [u32; 5]>) -> Ledger {
        let mut l = Ledger::new();
        bodies.for_each(|b| l.push(b));
        l
    }

    #[test]
    #[ignore = "needs a live host: run by tools/net/bridge-smoke.mjs"]
    fn a_tampered_ledger_is_refused_by_the_live_host() {
        let url = std::env::var("CRIMSON_URL").expect("CRIMSON_URL");
        let token = std::env::var("CRIMSON_TOKEN").expect("CRIMSON_TOKEN");
        let c = validate(&parse(include_str!("../containment.nix")).unwrap()).unwrap();
        let canonical = noir_core::config::canonical(&c);
        let (counts, caps): (Vec<u32>, Vec<u32>) = c.roles.iter().map(|r| (r.count, r.caps)).unzip();
        let lk = Locked { canonical: &canonical, dims: c.dims, role_counts: &counts, role_caps: &caps };
        let (m, _, honest) = ledger::record_golden(&lk.dims, &counts, &caps);
        let first = honest.entries.iter().position(|e| e.body[0] == ledger::LEARN).unwrap();
        let sentry = counts[0];

        // A learn handed to a sentry, relinked and sealed with the fold it now makes.
        let to_sentry = relinked(honest.entries.iter().enumerate().map(|(k, e)| {
            let mut b = e.body;
            if k == first {
                b[2] = sentry;
            }
            b
        }));
        // Another reward the kernel could have produced, so no rule refuses the entry itself.
        let r = honest.entries[first].body[4];
        let other = if r == ledger::reward(1) as u32 { ledger::reward(2) } else { ledger::reward(1) } as u32;
        // That reward, relinked, sealed with the honest run's weights: the fold is no longer those weights.
        let swapped = relinked(honest.entries.iter().enumerate().map(|(k, e)| {
            let mut b = e.body;
            if k == first {
                b[4] = other;
            }
            b
        }));
        // That reward written over the entry, its link left as it was.
        let mut edited = honest.clone();
        edited.entries[first].body[4] = other;
        // A reward beyond any the kernel makes, relinked and sealed with the fold it makes.
        let mut outside = honest.clone();
        outside.entries[first].body[4] = ledger::REWARD_MAX as u32 + 1;
        let outside = relinked(outside.entries.iter().map(|e| e.body));
        let cases: [(&str, &Ledger, Vec<i32>, &str); 4] = [
            ("a sentry that learns", &to_sentry, ledger::fold(&lk.dims, &to_sentry.entries), "never declared with learn"),
            ("a reward swapped, sealed as the honest weights", &swapped, m.weights.clone(), "not the fold of the entries"),
            ("an entry edited in place", &edited, m.weights.clone(), "the chain breaks"),
            ("a reward no clock gives", &outside, ledger::fold(&lk.dims, &outside.entries), "not one the kernel can produce"),
        ];
        for (what, l, weights, why) in cases {
            let mut s = session(&url, &token, &lk).expect("session");
            let r = submit(&mut s, l, &weights);
            match r {
                Err(e) if e.contains("refused") && e.contains(why) => println!("refused, as it must be: {what}: {e}"),
                other => panic!("{what}: the host answered {other:?}"),
            }
        }
        // Nothing tampered became what the host shares.
        let mut s = session(&url, &token, &lk).expect("session");
        let (_, digest) = fetch(&mut s).expect("fetch").expect("the honest run's weights");
        s.ws.close();
        assert_eq!(digest, ledger::weights_digest(&m.weights));
        println!("the host still shares the honest run's weights");
    }
}
