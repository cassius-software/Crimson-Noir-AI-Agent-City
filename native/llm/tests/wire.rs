// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Why does this file exist? The page reads the runner's events by their names. tests/wire.json holds one of every
//! request, event, ending, error and status, as the runner writes them; this test fails when a name or a shape in
//! src/wire.rs no longer matches it, and the page's tests read the same file, so the two sides cannot drift apart
//! unnoticed. `UPDATE_WIRE=1 cargo test --test wire` rewrites it after a deliberate change.
//! What breaks if it is removed? A renamed field reaches the page unseen, and its events are silently ignored.

use crimson_noir_llm::wire::TEXT_MAX;
use crimson_noir_llm::{ErrorCode, GenDone, GenRequest, Message, Reason, Role, RunError, RunEvent, Status};
use serde_json::{json, Value};

fn every() -> Value {
    let request = GenRequest {
        id: 42,
        messages: vec![
            Message { role: Role::System, content: "You are Sloane.".into() },
            Message { role: Role::User, content: "Say hi.".into() },
            Message { role: Role::Assistant, content: "Hi.".into() },
        ],
        max_tokens: 512,
        think: false,
    };
    let events = vec![
        RunEvent::Waiting,
        RunEvent::Preparing { done: 4_194_304, total: 397_808_192 },
        RunEvent::Loading { fraction: 0.5 },
        RunEvent::Read { done: 120, total: 187 },
        RunEvent::Text { text: "Hello".into() },
    ];
    let done: Vec<GenDone> = [Reason::Eog, Reason::MaxTokens, Reason::Stopped, Reason::Context]
        .into_iter()
        .map(|reason| GenDone {
            id: 42,
            reason,
            tokens: 9,
            prompt_tokens: 187,
            reused: 120,
            prefill_ms: 310,
            gen_ms: 820,
            threads: 4,
            n_ctx: 4096,
            n_batch: 256,
            gpu: false,
        })
        .collect();
    let errors = [ErrorCode::Offline, ErrorCode::Refused, ErrorCode::Model]
        .into_iter()
        .map(|code| RunError::new(code, "a plain sentence"))
        .collect::<Vec<_>>();
    let statuses = vec![
        Status::Preparing { done: 0, total: 397_808_192 },
        Status::Ready,
        Status::Loaded,
        Status::Failed { reason: "a plain sentence".into(), refused: true },
    ];
    json!({ "request": request, "events": events, "done": done, "errors": errors, "statuses": statuses })
}

#[test]
fn the_wire_matches_the_file_the_page_reads() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("wire.json");
    let now = every();
    if std::env::var_os("UPDATE_WIRE").is_some() {
        std::fs::write(&path, serde_json::to_string_pretty(&now).unwrap() + "\n").unwrap();
    }
    let file: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(now, file, "src/wire.rs and tests/wire.json differ: UPDATE_WIRE=1 cargo test --test wire, then the page's side");
    // Each event and status read back as the same value.
    let events: Vec<RunEvent> = serde_json::from_value(file["events"].clone()).unwrap();
    assert_eq!(serde_json::to_value(&events).unwrap(), file["events"]);
    let statuses: Vec<Status> = serde_json::from_value(file["statuses"].clone()).unwrap();
    assert_eq!(serde_json::to_value(&statuses).unwrap(), file["statuses"]);
}

#[test]
fn a_request_with_an_unknown_field_is_refused_and_the_optional_ones_may_be_left_out() {
    let ok: GenRequest = serde_json::from_value(json!({ "id": 1, "messages": [{ "role": "user", "content": "hi" }] })).unwrap();
    assert_eq!((ok.max_tokens, ok.think), (0, false));
    assert!(serde_json::from_value::<GenRequest>(json!({ "id": 1, "messages": [], "temperature": 2 })).is_err());
    assert!(serde_json::from_value::<GenRequest>(json!({ "id": 1, "messages": [{ "role": "tool", "content": "x" }] })).is_err());
}

#[test]
fn the_largest_text_event_stays_under_the_channels_direct_limit() {
    // Every byte a control character, written by JSON as \u00XX: the worst case for TEXT_MAX bytes of text.
    let worst = RunEvent::Text { text: "\u{1}".repeat(TEXT_MAX) };
    let json = serde_json::to_string(&worst).unwrap();
    assert!(json.len() < 8192, "{} bytes", json.len());
}
