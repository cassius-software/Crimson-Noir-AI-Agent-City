// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Why does this file exist? It drives the runner end to end on the tiny model (tools/browser/tinyGguf.mjs), whose
//! greedy text is known before it runs ("aaaa…", one letter per token, whatever the prompt): loading by path and by
//! its first shard, the template and its ChatML fallback, the stream and its order, the caps, a stop from another
//! thread and from a page that went away, the queue, a stop during a load, the context kept between answers, a file
//! copied out of a package, and every refusal as a sentence. The tiny model ignores its prompt, so what it proves is
//! the runner's plumbing; tests/real.rs proves the real model's tokens and kernels.
//! What breaks if it is removed? The runner's behaviour is checked nowhere.

mod common;

use std::fs::File;
use std::io;
use std::sync::{Arc, Mutex};
use std::thread;

use common::*;
use crimson_noir_llm::{Engine, ErrorCode, Plan, Reason, Role, RunEvent, Source, Status};

#[test]
fn loads_by_path_and_streams_the_known_text_in_order() {
    let path = tiny("tiny-a.gguf");
    // The plan asks for more context than the model was trained with; the runner caps it at the training.
    let engine = Engine::start(pin_of(&path), Source::Path(path), Plan { n_ctx: 8192, ..plan() }, scratch("stream"));
    let (events, answer) = ask(&engine, req(1, chat(), 8));
    let done = answer.unwrap();
    assert_eq!(text_of(&events), "aaaaaaaa");
    assert_eq!((done.id, done.reason, done.tokens, done.reused), (1, Reason::MaxTokens, 8, 0));
    assert!(done.prompt_tokens > 20, "{done:?}");
    assert_eq!((done.n_ctx, done.n_batch, done.threads, done.gpu), (6144, 512, 2, false));
    let kind = |e: &RunEvent| match e {
        RunEvent::Preparing { .. } => 0,
        RunEvent::Loading { .. } => 1,
        RunEvent::Read { .. } => 2,
        RunEvent::Text { .. } => 3,
        other => panic!("unexpected event {other:?}"),
    };
    let kinds: Vec<i32> = events.iter().map(kind).collect();
    assert!(kinds.windows(2).all(|w| w[0] <= w[1]), "(preparing,) loading, then reading, then text: {events:?}");
    assert!(kinds.contains(&1), "the load is told: {events:?}");
    assert!(matches!(events.iter().rev().find(|e| kind(e) == 2), Some(RunEvent::Read { done, total }) if done == total));
    assert_eq!(engine.status(), Status::Loaded);
    assert_eq!(engine.loads(), 1);
}

#[test]
fn loads_a_model_split_in_two_by_its_first_shard() {
    let path = tiny("tiny-a-00001-of-00002.gguf");
    let engine = Engine::start(pin_of(&path), Source::Path(path), plan(), scratch("split"));
    let (events, answer) = ask(&engine, req(1, chat(), 4));
    assert_eq!(answer.unwrap().reason, Reason::MaxTokens);
    assert_eq!(text_of(&events), "aaaa");
}

#[test]
fn a_model_without_a_template_is_written_as_chatml_like_the_one_with_it() {
    // The tiny vocabulary is one token per byte, so the prompt's length in tokens is the rendered text's length, with
    // the start-of-text token and the space a SentencePiece vocabulary puts in front.
    let prompt_tokens = |file: &str, content: &str| {
        let path = tiny(file);
        let engine = Engine::start(pin_of(&path), Source::Path(path), plan(), scratch("template"));
        let messages = vec![msg(Role::System, "S"), msg(Role::User, content)];
        ask(&engine, req(1, messages, 1)).1.unwrap().prompt_tokens
    };
    let with = prompt_tokens("tiny-a.gguf", "U");
    assert_eq!(prompt_tokens("tiny-a-plain.gguf", "U"), with);
    let chatml = "<|im_start|>system\nS<|im_end|>\n<|im_start|>user\nU<|im_end|>\n<|im_start|>assistant\n";
    assert!(with as usize >= chatml.len() && with as usize <= chatml.len() + 4, "{with} tokens for {} bytes", chatml.len());
    assert_eq!(prompt_tokens("tiny-a.gguf", "UU"), with + 1);
}

#[test]
fn the_request_cap_and_the_plan_cap_both_hold() {
    let path = tiny("tiny-a.gguf");
    let engine = Engine::start(pin_of(&path), Source::Path(path), Plan { max_tokens: 5, ..plan() }, scratch("cap"));
    let (events, answer) = ask(&engine, req(1, chat(), 0));
    assert_eq!((answer.unwrap().tokens, text_of(&events).len()), (5, 5), "0 asks for the plan's cap");
    let (_, answer) = ask(&engine, req(2, chat(), 100));
    assert_eq!(answer.unwrap().tokens, 5, "the plan's cap holds over the request's");
    let (_, answer) = ask(&engine, req(3, chat(), 3));
    assert_eq!(answer.unwrap().tokens, 3);
}

#[test]
fn a_full_context_ends_the_answer_and_a_prompt_too_long_is_refused() {
    let path = tiny("tiny-a.gguf");
    let engine = Engine::start(pin_of(&path), Source::Path(path.clone()), Plan { n_ctx: 256, ..plan() }, scratch("ctx"));
    let (events, answer) = ask(&engine, req(1, chat(), 4000));
    let done = answer.unwrap();
    assert_eq!(done.reason, Reason::Context);
    assert_eq!(done.prompt_tokens + done.tokens, 256);
    assert_eq!(text_of(&events).len() as u32, done.tokens);
    let long = vec![msg(Role::User, &"x".repeat(400))];
    let err = ask(&engine, req(2, long, 4)).1.unwrap_err();
    assert_eq!(err.code, ErrorCode::Model);
    assert!(err.message.contains("more than the 256 the model can hold"), "{}", err.message);
    // The runner answers again after a refusal.
    assert_eq!(ask(&engine, req(3, chat(), 2)).1.unwrap().tokens, 2);
}

#[test]
fn a_stop_from_another_thread_ends_the_answer_early() {
    let path = tiny("tiny-a.gguf");
    let engine = Arc::new(Engine::start(pin_of(&path), Source::Path(path), plan(), scratch("stop")));
    let stopper = engine.clone();
    let texts = Arc::new(Mutex::new(String::new()));
    let into = texts.clone();
    let answer = engine
        .submit(
            req(7, chat(), 4000),
            Box::new(move |e| {
                if let RunEvent::Text { text } = e {
                    into.lock().unwrap().push_str(&text);
                    assert!(stopper.stop(7), "the answer is live");
                }
                true
            }),
        )
        .recv()
        .unwrap()
        .unwrap();
    assert_eq!(answer.reason, Reason::Stopped);
    assert!(answer.tokens > 0 && answer.tokens < 4000, "{answer:?}");
    assert!(texts.lock().unwrap().len() as u32 <= answer.tokens);
    assert!(!engine.stop(7), "a finished answer is forgotten");
}

#[test]
fn a_page_that_went_away_stops_its_answer() {
    let path = tiny("tiny-a.gguf");
    let engine = Engine::start(pin_of(&path), Source::Path(path), plan(), scratch("gone"));
    let answer = engine
        .submit(req(1, chat(), 4000), Box::new(|e| !matches!(e, RunEvent::Text { .. })))
        .recv()
        .unwrap()
        .unwrap();
    assert_eq!(answer.reason, Reason::Stopped);
    assert!(answer.tokens < 4000);
}

#[test]
fn answers_run_in_order_and_a_queued_one_is_told_it_waits() {
    let path = tiny("tiny-a.gguf");
    let engine = Engine::start(pin_of(&path), Source::Path(path), plan(), scratch("queue"));
    let log = Arc::new(Mutex::new(Vec::<(char, RunEvent)>::new()));
    let sink = |who: char| {
        let log = log.clone();
        Box::new(move |e: RunEvent| {
            log.lock().unwrap().push((who, e));
            true
        })
    };
    let first = engine.submit(req(1, chat(), 3000), sink('A'));
    let second = engine.submit(req(2, chat(), 3), sink('B'));
    // The same number again while it is live is refused.
    let twin = engine.submit(req(2, chat(), 3), Box::new(|_| true)).recv().unwrap().unwrap_err();
    assert!(twin.message.contains("already being made"), "{}", twin.message);
    let a = first.recv().unwrap().unwrap();
    let b = second.recv().unwrap().unwrap();
    assert_eq!((a.reason, a.tokens, b.reason, b.tokens), (Reason::MaxTokens, 3000, Reason::MaxTokens, 3));
    let log = log.lock().unwrap();
    let bs: Vec<&RunEvent> = log.iter().filter(|(w, _)| *w == 'B').map(|(_, e)| e).collect();
    assert_eq!(bs.first(), Some(&&RunEvent::Waiting), "{bs:?}");
    let last_a = log.iter().rposition(|(w, _)| *w == 'A').unwrap();
    let first_b_read = log.iter().position(|(w, e)| *w == 'B' && matches!(e, RunEvent::Read { .. })).unwrap();
    assert!(last_a < first_b_read, "B is read only after A is done");
}

#[test]
fn a_stop_during_the_load_leaves_the_model_loaded_for_the_next_answer() {
    let path = tiny("tiny-a.gguf");
    let engine = Arc::new(Engine::start(pin_of(&path), Source::Path(path), plan(), scratch("load")));
    let stopper = engine.clone();
    let answer = engine
        .submit(
            req(1, chat(), 8),
            Box::new(move |e| {
                if matches!(e, RunEvent::Loading { .. }) {
                    stopper.stop(1);
                }
                true
            }),
        )
        .recv()
        .unwrap()
        .unwrap();
    assert_eq!((answer.reason, answer.tokens), (Reason::Stopped, 0));
    assert_eq!(engine.status(), Status::Loaded);
    let (events, next) = ask(&engine, req(2, chat(), 3));
    assert_eq!((next.unwrap().tokens, text_of(&events).as_str()), (3, "aaa"));
    assert_eq!(engine.loads(), 1, "loaded once");
    assert!(!events.iter().any(|e| matches!(e, RunEvent::Loading { .. })), "the second answer loads nothing");
}

#[test]
fn stop_all_stops_the_running_answer_and_the_queued_one() {
    let path = tiny("tiny-a.gguf");
    let engine = Arc::new(Engine::start(pin_of(&path), Source::Path(path), plan(), scratch("all")));
    let stopper = engine.clone();
    let first = engine.submit(
        req(1, chat(), 4000),
        Box::new(move |e| {
            if matches!(e, RunEvent::Text { .. }) {
                stopper.stop_all();
            }
            true
        }),
    );
    let second = engine.submit(req(2, chat(), 4000), Box::new(|_| true));
    let a = first.recv().unwrap().unwrap();
    let b = second.recv().unwrap().unwrap();
    assert_eq!((a.reason, b.reason, b.tokens), (Reason::Stopped, Reason::Stopped, 0));
}

#[test]
fn the_context_kept_from_the_last_answer_is_not_read_again() {
    let path = tiny("tiny-a.gguf");
    let engine = Engine::start(pin_of(&path), Source::Path(path), plan(), scratch("reuse"));
    let (events, first) = ask(&engine, req(1, chat(), 8));
    let first = first.unwrap();
    let mut more = chat();
    more.push(msg(Role::Assistant, &text_of(&events)));
    more.push(msg(Role::User, "Again."));
    let second = ask(&engine, req(2, more, 4)).1.unwrap();
    assert!(second.reused >= first.prompt_tokens, "{first:?} then {second:?}");
    assert!(second.reused < second.prompt_tokens);
    // A conversation that starts otherwise keeps only the common start.
    let other = ask(&engine, req(3, vec![msg(Role::System, "You are Sloane."), msg(Role::User, "Bye.")], 2)).1.unwrap();
    assert!(other.reused > 0 && other.reused < first.prompt_tokens, "{other:?}");
}

#[test]
fn a_model_inside_a_package_is_copied_out_once_and_checked() {
    let path = tiny("tiny-a.gguf");
    let pin = pin_of(&path);
    let data = scratch("copy");
    let dest = data.join("models").join("tiny-a.gguf");
    let source = |may_open: bool| {
        let from = path.clone();
        Source::Copy {
            open: Box::new(move || {
                assert!(may_open, "a good copy is not copied again");
                Ok(Box::new(File::open(from)?) as Box<dyn io::Read>)
            }),
            dest: dest.clone(),
        }
    };
    let engine = Engine::start(pin.clone(), source(true), plan(), data.clone());
    let (events, answer) = ask(&engine, req(1, chat(), 3));
    assert_eq!((answer.unwrap().tokens, text_of(&events).as_str()), (3, "aaa"));
    assert_eq!(std::fs::read(&dest).unwrap(), std::fs::read(&path).unwrap());
    drop(engine);
    let again = Engine::start(pin, source(false), plan(), data);
    assert_eq!(ask(&again, req(1, chat(), 2)).1.unwrap().tokens, 2);
}

#[test]
fn a_package_that_cannot_be_opened_is_refused_in_a_sentence() {
    let path = tiny("tiny-a.gguf");
    let data = scratch("unopened");
    let source = Source::Copy {
        open: Box::new(|| Err(io::Error::new(io::ErrorKind::NotFound, "no such asset"))),
        dest: data.join("models").join("tiny-a.gguf"),
    };
    let engine = Engine::start(pin_of(&path), source, plan(), data);
    let err = ask(&engine, req(1, chat(), 2)).1.unwrap_err();
    assert_eq!(err.code, ErrorCode::Model);
    assert_eq!(err.message, "the app's model could not be opened in its package (no such asset)");
}

#[test]
fn a_missing_wrong_or_changed_file_is_refused_in_a_sentence_without_loading() {
    let path = tiny("tiny-a.gguf");
    let pin = pin_of(&path);
    let refused = |pin: crimson_noir_llm::Pin, at: std::path::PathBuf| {
        let engine = Engine::start(pin, Source::Path(at), plan(), scratch("refused"));
        let err = ask(&engine, req(1, chat(), 2)).1.unwrap_err();
        // Every later answer gets the same reason, without starting the model.
        let again = ask(&engine, req(2, chat(), 2)).1.unwrap_err();
        assert_eq!(err, again);
        assert!(matches!(engine.status(), Status::Failed { refused: false, .. }));
        assert_eq!(engine.loads(), 0);
        assert_eq!(err.code, ErrorCode::Model);
        err.message
    };
    assert_eq!(refused(pin.clone(), tiny("no-such.gguf")), "the app's model (tiny-a.gguf) is not where the app put it");
    let longer = crimson_noir_llm::Pin { bytes: pin.bytes + 1, ..pin.clone() };
    assert!(refused(longer, path.clone()).contains("bytes, not the"));
    let other = crimson_noir_llm::Pin { sha256: "0".repeat(64), ..pin };
    assert!(refused(other, path).contains("SHA-256 differs"));
}

#[test]
fn many_engines_in_one_process_share_one_backend() {
    let path = tiny("tiny-a.gguf");
    let handles: Vec<_> = (0..4)
        .map(|i| {
            let path = path.clone();
            thread::spawn(move || {
                let engine = Engine::start(pin_of(&path), Source::Path(path), plan(), scratch("many"));
                text_of(&ask(&engine, req(i, chat(), 2)).0)
            })
        })
        .collect();
    for h in handles {
        assert_eq!(h.join().unwrap(), "aa");
    }
}
