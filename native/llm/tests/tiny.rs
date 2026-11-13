// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Why does this file exist? It drives the runner end to end on the tiny model (tools/browser/tinyGguf.mjs), whose
//! greedy text is known before it runs ("aaaa…", one letter per token, whatever the prompt): loading by path, the
//! refusal of a split model, the template and its ChatML fallback, the stream and its order, the caps, a stop from
//! another thread and from a page that went away (nothing sent after it during a copy or a load), the queue and who is
//! told it waits when two answers are asked at once, a stop during a load, the context kept between answers, a file
//! copied out of a package, and every refusal as a sentence. The tiny model ignores its prompt, so what it proves is
//! the runner's plumbing; tests/real.rs proves the real model's tokens and kernels.
//! What breaks if it is removed? The runner's behaviour is checked nowhere.

mod common;

use std::fs::File;
use std::io::{self, Read};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Barrier, Mutex};
use std::thread;

use common::*;
use crimson_noir_llm::{Answer, Engine, ErrorCode, Plan, Reason, Role, RunEvent, Sink, Source, Status};

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
fn a_model_split_in_parts_is_refused_without_loading() {
    // A pin covers one file, and llama.cpp would open the second part by itself, unchecked.
    let path = tiny("tiny-a-00001-of-00002.gguf");
    let engine = Engine::start(pin_of(&path), Source::Path(path), plan(), scratch("split"));
    let err = ask(&engine, req(1, chat(), 4)).1.unwrap_err();
    assert_eq!(err.code, ErrorCode::Model);
    assert_eq!(
        err.message,
        "the app's model (tiny-a-00001-of-00002.gguf) is one of 2 parts of a split model, and the runner loads only \
         one checked file"
    );
    assert!(matches!(engine.status(), Status::Failed { refused: false, .. }));
    assert_eq!(engine.loads(), 0);
    // Copied out of a package under a split name, it is refused before anything is opened.
    let data = scratch("split-copy");
    let source = Source::Copy {
        open: Box::new(|| panic!("a split model is never opened")),
        dest: data.join("models").join("tiny-a-00001-of-00002.gguf"),
    };
    let copied = Engine::start(pin_of(&tiny("tiny-a-00001-of-00002.gguf")), source, plan(), data);
    assert!(ask(&copied, req(1, chat(), 4)).1.unwrap_err().message.contains("parts of a split model"));
    assert_eq!(copied.loads(), 0);
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
    let texts = Arc::new(Mutex::new(Vec::new()));
    let into = texts.clone();
    let answer = engine
        .submit(
            req(7, chat(), 4000),
            Box::new(move |e| {
                if let RunEvent::Text { text } = e {
                    into.lock().unwrap().push(text);
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
    // The first token goes out at once, and the stop made at it ends the answer there: no text after it.
    assert_eq!(*texts.lock().unwrap(), vec!["a".to_string()]);
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
fn of_two_answers_asked_at_once_only_the_one_queued_second_is_told_it_waits() {
    let path = tiny("tiny-a.gguf");
    // One thread: the test is about the queue, and on a busy runner llama.cpp's threads would only spin, waiting.
    let one_thread = Plan { threads: 1, ..plan() };
    let engine = Arc::new(Engine::start(pin_of(&path), Source::Path(path), one_thread, scratch("at-once")));
    assert!(ask(&engine, req(1, chat(), 1)).1.is_ok(), "loaded, and idle from here");
    for round in 0..1000u32 {
        let log = Arc::new(Mutex::new(Vec::new()));
        let together = Arc::new(Barrier::new(2));
        let askers: Vec<_> = (0..2u32)
            .map(|k| {
                let (engine, log, together) = (engine.clone(), log.clone(), together.clone());
                thread::spawn(move || {
                    together.wait();
                    let sink: Sink = Box::new(move |e| {
                        log.lock().unwrap().push((k, e));
                        true
                    });
                    engine.submit(req(10 + 2 * round + k, chat(), 1), sink).recv().unwrap().unwrap();
                })
            })
            .collect();
        for asker in askers {
            asker.join().unwrap();
        }
        let log = log.lock().unwrap();
        let told: Vec<u32> = log.iter().filter(|(_, e)| *e == RunEvent::Waiting).map(|(k, _)| *k).collect();
        // The model thread reads one answer after the other, so the first Read is the answer that ran first.
        let ran_first = log.iter().find(|(_, e)| matches!(e, RunEvent::Read { .. })).map(|(k, _)| *k);
        assert!(ran_first.is_some(), "round {round}: {log:?}");
        assert!(told.len() <= 1, "round {round}: only one can wait for the other: {log:?}");
        if let Some(&waited) = told.first() {
            assert_ne!(ran_first, Some(waited), "round {round}: the answer told it waits ran first: {log:?}");
        }
    }
}

#[test]
fn a_job_stopped_during_the_load_is_told_nothing_more() {
    let path = tiny("tiny-a.gguf");
    let engine = Arc::new(Engine::start(pin_of(&path), Source::Path(path), plan(), scratch("load-quiet")));
    let stopper = engine.clone();
    let (stopped, after) = (Arc::new(AtomicBool::new(false)), Arc::new(AtomicUsize::new(0)));
    let (now, later) = (stopped.clone(), after.clone());
    let answer = engine
        .submit(
            req(1, chat(), 8),
            Box::new(move |e| {
                if now.load(Ordering::SeqCst) {
                    later.fetch_add(1, Ordering::SeqCst);
                } else if matches!(e, RunEvent::Loading { .. }) {
                    assert!(stopper.stop(1), "the answer is live");
                    now.store(true, Ordering::SeqCst);
                }
                true
            }),
        )
        .recv()
        .unwrap()
        .unwrap();
    assert!(stopped.load(Ordering::SeqCst), "the load was told");
    assert_eq!((answer.reason, answer.tokens), (Reason::Stopped, 0));
    assert_eq!(after.load(Ordering::SeqCst), 0, "no event reached the job after its stop");
    assert_eq!(engine.loads(), 1, "the load went on");
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

/// A package reader that hands out the model a little at a time (Android's asset reader on a first run, every piece
/// a step of the copy's progress), and runs `at_end` when it has handed out the last byte.
struct Trickle {
    file: File,
    at_end: Option<Box<dyn FnOnce() + Send>>,
}

impl Read for Trickle {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = buf.len().min(1024);
        let got = self.file.read(&mut buf[..n])?;
        if got == 0 {
            if let Some(at_end) = self.at_end.take() {
                at_end();
            }
        }
        Ok(got)
    }
}

#[test]
fn a_job_stopped_during_the_copy_is_answered_before_it_ends_and_told_nothing_more() {
    // A page that reloads during the first-run copy: stop_all at the first Preparing event.
    let path = tiny("tiny-a.gguf");
    let data = scratch("copy-quiet");
    let (go, gate) = mpsc::channel::<()>();
    let pending: Arc<Mutex<Option<Receiver<Answer>>>> = Arc::new(Mutex::new(None));
    // What the stopped job's answer channel held when the reader handed out its last byte.
    let at_copy_end = Arc::new(Mutex::new(None));
    let (slot, seen, from) = (pending.clone(), at_copy_end.clone(), path.clone());
    let source = Source::Copy {
        open: Box::new(move || {
            // The copy starts once the job is queued, so the job is told of it from its first piece.
            let _ = gate.recv();
            let at_end = Box::new(move || {
                let answered = slot.lock().unwrap().take().map(|answer| answer.try_recv());
                *seen.lock().unwrap() = Some(answered);
            });
            Ok(Box::new(Trickle { file: File::open(from)?, at_end: Some(at_end) }) as Box<dyn Read>)
        }),
        dest: data.join("models").join("tiny-a.gguf"),
    };
    let engine = Arc::new(Engine::start(pin_of(&path), source, plan(), data));
    let stopper = engine.clone();
    let (stopped, after) = (mpsc::channel::<()>(), Arc::new(AtomicUsize::new(0)));
    let (told_stop, later) = (stopped.0, after.clone());
    let mut done = false;
    let answer = engine.submit(
        req(1, chat(), 4),
        Box::new(move |e| {
            if done {
                later.fetch_add(1, Ordering::SeqCst);
            } else if matches!(e, RunEvent::Preparing { .. }) {
                stopper.stop_all();
                done = true;
                told_stop.send(()).unwrap();
            }
            true
        }),
    );
    *pending.lock().unwrap() = Some(answer);
    go.send(()).unwrap();
    // Asked only after the stop_all, so it is not stopped with the first; it comes after the copy and the load.
    stopped.1.recv().unwrap();
    let (events, next) = ask(&engine, req(2, chat(), 2));
    assert_eq!((next.unwrap().tokens, text_of(&events).as_str()), (2, "aa"));
    assert_eq!(after.load(Ordering::SeqCst), 0, "no event reached the stopped job after stop_all");
    let answered = at_copy_end.lock().unwrap().take();
    match answered {
        Some(Some(Ok(Ok(done)))) => assert_eq!((done.id, done.reason, done.tokens), (1, Reason::Stopped, 0)),
        other => panic!("the stopped job was not answered before the copy ended: {other:?}"),
    }
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
