// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Why does this file exist? It lends the page the model runner (native/llm: llama.cpp in the app's own process), for
//! the apps whose web view cannot run a model in the page. The page asks three things (src/07_Execute_Actions/
//! desktopShell.ts shellRunner, src/09_Cognition/nativeMind.ts): `native_model`, what the app carries and how that
//! stands (none where the app runs no model); `native_generate`, one answer, whose events go back on the Tauri channel
//! the page made for it while the command waits for how it ended; and `native_stop`, a stop by the answer's number. A
//! page that starts loading (a reload) stops every answer it asked for (`page_loading`, from lib.rs on_page_load):
//! a reload does not fail the channel's sends, so nothing else would stop them.
//! The runner is compiled only with the `native-runner` feature on a Linux target (src-tauri/Cargo.toml), and runs
//! only when the app carries its model as a resource (`models/<file>`, model_file.rs `carried`); the file is checked
//! against its pin once and stamped in the app's data folder (`models/`). Everywhere else (Windows, macOS, a build
//! without the feature) the same three commands answer that there is none: no model, an `offline` error with a plain
//! sentence, and false, so the page's code is one and the same. The page's request is the runner's wire shape
//! (native/llm/src/wire.rs, pinned by native/llm/tests/wire.json, which the tests below and the page's read). Nothing
//! here reaches the network or starts a process; the wait for an answer runs on Tauri's blocking pool, never on one of
//! its async workers, and every refusal is a plain sentence.
//! What breaks if it is removed? The page has no way to ask the model the app runs itself.

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, Runtime, State};

pub use imp::{GenDone, GenRequest, NativeModel, RunError, RunEvent, Runner};

/// Whether this build runs the model itself: the `native-runner` feature on a Linux target.
pub const COMPILED: bool = cfg!(all(target_os = "linux", feature = "native-runner"));

/// What the app carries and how that stands, or nothing where it runs no model (or carries none). It and `native_stop`
/// answer from memory (a lock held for a copy, an atomic store), so they run where Tauri calls them.
#[tauri::command]
pub fn native_model(runner: State<'_, Runner>) -> Option<NativeModel> {
    runner.model()
}

/// One answer: its events go to `on_event` as it is made, and the command answers how it ended or why it could not.
#[tauri::command]
pub async fn native_generate(runner: State<'_, Runner>, req: GenRequest, on_event: Channel<RunEvent>) -> Result<GenDone, RunError> {
    runner.generate(req, on_event).await
}

/// Stops the answer `id`, queued or being made; false when there is none. `native_generate` is async, so its request
/// can reach the runner after a stop the page sent just behind it: a stop that finds no answer is kept (the last
/// `EARLY_STOPS` numbers) and stops that answer the moment it arrives, which then ends `stopped`.
#[tauri::command]
pub fn native_stop(runner: State<'_, Runner>, id: u32) -> bool {
    runner.stop(id)
}

/// Starts the runner over the model the app carries, if it carries one (from lib.rs setup).
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    if let Some(runner) = app.try_state::<Runner>() {
        imp::start(app, &runner);
    }
}

/// A page started loading in the window: every answer it asked for is stopped (from lib.rs on_page_load).
pub fn page_loading<R: Runtime>(app: &AppHandle<R>) {
    if let Some(runner) = app.try_state::<Runner>() {
        runner.stop_all();
    }
}

#[cfg(all(target_os = "linux", feature = "native-runner"))]
mod imp {
    use std::collections::VecDeque;
    use std::path::PathBuf;
    use std::sync::{Mutex, MutexGuard, OnceLock};

    use crimson_noir_llm::{half_the_threads, Engine, ErrorCode, Gpu, Pin, Plan, Sampling, Sink, Source};
    pub use crimson_noir_llm::{GenDone, GenRequest, NativeModel, RunError, RunEvent, Status};
    use tauri::ipc::Channel;
    use tauri::path::BaseDirectory;
    use tauri::{AppHandle, Manager, Runtime};

    use crate::model_file::{carried, Carried};

    /// The context, tokens: the page's CONTEXT_TOKENS (src/09_Cognition/localCompute.ts), so an answer has the room it
    /// has on a model server and in the page; the runner lowers it to what the model was trained on.
    pub const N_CTX: u32 = 8192;
    /// Prompt tokens read a step: the page's integrated-GPU row (src/09_Cognition/inPagePlan.ts) and the design's
    /// desktop plan.
    pub const N_BATCH: u32 = 512;
    /// The longest answer, tokens: the page's ANSWER_TOKENS, which a computer's request asks for.
    pub const MAX_TOKENS: u32 = 2048;
    /// At most this many threads, half the processor's, so the web view and the city keep the rest.
    pub const THREADS_CAP: i32 = 8;

    /// Why there is nothing to ask: the app was built with the runner but carries no model.
    pub const NO_MODEL: &str = "this app carries no model to run itself";

    /// The plan for a computer's processor. No GPU backend is compiled into the Linux runner, so the model runs on the
    /// processor alone; the sampling is llama.cpp's usual chain, seeded from the clock.
    pub fn plan() -> Plan {
        Plan {
            n_ctx: N_CTX,
            n_batch: N_BATCH,
            threads: half_the_threads(THREADS_CAP),
            gpu: Gpu::Off,
            max_tokens: MAX_TOKENS,
            sampling: Sampling::Chat { seed: None },
        }
    }

    /// What `native_model` answers for the carried model in `status`.
    pub fn model_for(c: Carried, status: Status) -> NativeModel {
        NativeModel { file: c.file.to_string(), bytes: c.bytes, status }
    }

    /// Stops that found no answer, kept for one still on its way to the engine: at most this many numbers.
    pub const EARLY_STOPS: usize = 64;

    /// The runner, once the app has found its model: empty where it carries none.
    #[derive(Default)]
    pub struct Runner {
        engine: OnceLock<Engine>,
        /// The numbers `native_stop` found no answer for. `native_generate` is async, so its request reaches the engine
        /// on one of Tauri's workers, after a stop the page sent just behind it may already have run here; held across
        /// the submit, so a stop is either recorded before the answer is submitted or finds it live. Taken before the
        /// engine's own lock, in every path.
        pub(super) early: Mutex<VecDeque<u32>>,
    }

    fn early(m: &Mutex<VecDeque<u32>>) -> MutexGuard<'_, VecDeque<u32>> {
        m.lock().unwrap_or_else(|p| p.into_inner())
    }

    impl Runner {
        pub fn model(&self) -> Option<NativeModel> {
            self.engine.get().map(|engine| model_for(carried(), engine.status()))
        }

        pub async fn generate(&self, req: GenRequest, on_event: Channel<RunEvent>) -> Result<GenDone, RunError> {
            let Some(engine) = self.engine.get() else {
                return Err(RunError::new(ErrorCode::Offline, NO_MODEL));
            };
            // A send that fails (the window is gone) stops the answer.
            let sink: Sink = Box::new(move |event| on_event.send(event).is_ok());
            let id = req.id;
            let answer = {
                let mut early = early(&self.early);
                let answer = engine.submit(req, sink);
                if let Some(at) = early.iter().position(|&e| e == id) {
                    early.remove(at);
                    engine.stop(id);
                }
                answer
            };
            match tauri::async_runtime::spawn_blocking(move || answer.recv()).await {
                Ok(Ok(ended)) => ended,
                Ok(Err(_)) => Err(RunError::new(ErrorCode::Model, "the model's thread stopped before it answered")),
                Err(_) => Err(RunError::new(ErrorCode::Model, "the app could not wait for the model's answer")),
            }
        }

        /// Stops the answer `id`; one not there yet is kept for when it comes (see `early`), and false is answered.
        pub fn stop(&self, id: u32) -> bool {
            let Some(engine) = self.engine.get() else {
                return false;
            };
            let mut early = early(&self.early);
            if engine.stop(id) {
                return true;
            }
            if early.len() >= EARLY_STOPS {
                early.pop_front();
            }
            early.push_back(id);
            false
        }

        pub fn stop_all(&self) {
            if let Some(engine) = self.engine.get() {
                let mut early = early(&self.early);
                early.clear();
                engine.stop_all();
            }
        }

        /// Starts the engine over the carried model at `model` if the app carries that file (`placement`), its stamp in
        /// the data folder; without the file nothing starts, so `native_model` answers none and an answer `offline`.
        pub fn start_carried(&self, c: Carried, model: Option<PathBuf>, data_dir: Result<PathBuf, tauri::Error>) {
            if let Some((path, stamp_dir)) = placement(model, data_dir) {
                self.start_at(c, path, stamp_dir);
            }
        }

        /// Starts the engine over the model at `path`, its stamp in `stamp_dir`; a second start changes nothing.
        pub fn start_at(&self, c: Carried, path: PathBuf, stamp_dir: PathBuf) {
            let pin = Pin { file: c.file.to_string(), bytes: c.bytes, sha256: c.sha256.to_string() };
            let _ = self.engine.get_or_init(|| Engine::start(pin, Source::Path(path), plan(), stamp_dir));
        }
    }

    /// The carried model's path and its stamp's folder, or nothing when the app does not carry the file. The stamp
    /// spares the next launch the hash; without a data folder (no home) it is looked for beside the model, where an
    /// installed app cannot write one, so the file is hashed at every launch.
    pub fn placement(model: Option<PathBuf>, data_dir: Result<PathBuf, tauri::Error>) -> Option<(PathBuf, PathBuf)> {
        let path = model.filter(|p| p.is_file())?;
        let stamp_dir = match data_dir {
            Ok(dir) => dir.join("models"),
            Err(e) => {
                eprintln!("[app] no data folder for the model's stamp ({e}); the model is checked in full at every launch");
                path.parent()?.to_path_buf()
            }
        };
        Some((path, stamp_dir))
    }

    /// The carried model is `models/<file>` in the app's resource folder; an app without it runs nothing.
    pub fn start<R: Runtime>(app: &AppHandle<R>, runner: &Runner) {
        let c = carried();
        let model = app.path().resolve(format!("models/{}", c.file), BaseDirectory::Resource).ok();
        runner.start_carried(c, model, app.path().app_data_dir());
    }
}

#[cfg(not(all(target_os = "linux", feature = "native-runner")))]
mod imp {
    use serde::de::IgnoredAny;
    use serde::Serialize;
    use tauri::ipc::Channel;
    use tauri::{AppHandle, Runtime};

    /// Why there is nothing to ask: this build has no runner (Windows runs the model in the page).
    pub const NO_RUNNER: &str = "this app does not run a model itself";

    /// The request is not read: there is nothing to answer it.
    pub type GenRequest = IgnoredAny;
    /// Never made: `native_model` answers nothing.
    #[derive(Serialize)]
    pub enum NativeModel {}
    /// Never sent.
    #[derive(Serialize)]
    pub enum RunEvent {}
    /// Never reached: every answer is an error.
    #[derive(Serialize)]
    pub enum GenDone {}

    /// The runner's error in its wire shape (native/llm/tests/wire.json "errors"), here always `offline`.
    #[derive(Serialize, Debug, Clone, PartialEq, Eq)]
    pub struct RunError {
        pub code: &'static str,
        pub message: &'static str,
    }

    /// Braced, not a unit struct, so lib.rs's `Runner::default()` reads the same with the runner or without it.
    #[derive(Default)]
    pub struct Runner {}

    impl Runner {
        pub fn model(&self) -> Option<NativeModel> {
            None
        }

        pub async fn generate(&self, _req: GenRequest, _on_event: Channel<RunEvent>) -> Result<GenDone, RunError> {
            Err(RunError { code: "offline", message: NO_RUNNER })
        }

        pub fn stop(&self, _id: u32) -> bool {
            false
        }

        pub fn stop_all(&self) {}
    }

    pub fn start<R: Runtime>(_app: &AppHandle<R>, _runner: &Runner) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::sync::{Arc, Mutex};
    use tauri::ipc::InvokeResponseBody;

    /// native/llm/tests/wire.json, the file the page's tests read too.
    fn wire() -> Value {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../native/llm/tests/wire.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn keys(v: &Value) -> Vec<String> {
        let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
        k.sort();
        k
    }

    /// A channel that keeps every message sent on it, as JSON text.
    fn channel() -> (Channel<RunEvent>, Arc<Mutex<Vec<String>>>) {
        let got = Arc::new(Mutex::new(Vec::new()));
        let kept = got.clone();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                kept.lock().unwrap().push(json);
            }
            Ok(())
        });
        (channel, got)
    }

    /// A plain sentence: lowercase start, no Rust Debug text, no trailing period (the page adds its own words).
    fn plain(message: &str) {
        assert!(!message.is_empty() && message.chars().next().unwrap().is_lowercase(), "{message}");
        assert!(!message.ends_with('.'), "{message}");
        assert!(!message.contains("Err(") && !message.contains("Some(") && !message.contains('{'), "{message}");
    }

    #[cfg(not(all(target_os = "linux", feature = "native-runner")))]
    #[test]
    fn without_the_runner_the_commands_answer_none_offline_and_false() {
        const { assert!(!COMPILED) };
        let runner = Runner {};
        assert!(runner.model().is_none());
        assert!(!runner.stop(42));
        runner.stop_all();
        let (on_event, got) = channel();
        // GenDone has no value here, so the answer can only be the error.
        let Err(e) = tauri::async_runtime::block_on(runner.generate(serde::de::IgnoredAny, on_event));
        assert_eq!(e.code, "offline");
        plain(e.message);
        assert!(got.lock().unwrap().is_empty(), "no event is sent");
        // The error in the runner's own shape: the keys of wire.json's errors, the code one of its codes.
        let json = serde_json::to_value(&e).unwrap();
        let errors = wire()["errors"].as_array().unwrap().clone();
        assert!(errors.iter().all(|w| keys(w) == keys(&json)));
        assert!(errors.iter().any(|w| w["code"] == json["code"]));
        // What native_model answers is null on the page's side.
        assert_eq!(serde_json::to_value(runner.model()).unwrap(), Value::Null);
    }

    #[cfg(all(target_os = "linux", feature = "native-runner"))]
    mod runner {
        use super::*;
        use crate::model_file::carried;
        use crimson_noir_llm::{ErrorCode, Gpu, Message, Role, Sampling, Status};
        use std::time::{Duration, Instant};

        fn request(id: u32) -> GenRequest {
            GenRequest {
                id,
                messages: vec![Message { role: Role::User, content: "Say hi.".into() }],
                max_tokens: 8,
                think: false,
            }
        }

        #[test]
        fn the_plan_is_what_the_page_asks_on_a_computer_processor_alone() {
            const { assert!(COMPILED) };
            let p = imp::plan();
            assert_eq!((p.n_ctx, p.n_batch, p.max_tokens), (8192, 512, 2048));
            assert_eq!(p.gpu, Gpu::Off);
            assert_eq!(p.sampling, Sampling::Chat { seed: None });
            assert!((1..=imp::THREADS_CAP).contains(&p.threads));
        }

        #[test]
        fn without_a_carried_model_the_commands_answer_none_offline_and_false() {
            let runner = Runner::default();
            assert!(runner.model().is_none());
            assert!(!runner.stop(7));
            runner.stop_all();
            let (on_event, got) = channel();
            let e = tauri::async_runtime::block_on(runner.generate(request(7), on_event)).unwrap_err();
            assert_eq!(e.code, ErrorCode::Offline);
            plain(&e.message);
            assert!(got.lock().unwrap().is_empty());
        }

        #[test]
        fn what_native_model_answers_is_the_wire_files_carried_model_in_each_status() {
            let wire = wire();
            let models = wire["models"].as_array().unwrap();
            let statuses: Vec<Status> = serde_json::from_value(wire["statuses"].clone()).unwrap();
            assert_eq!(models.len(), statuses.len());
            for (status, expected) in statuses.into_iter().zip(models) {
                let ours = serde_json::to_value(imp::model_for(carried(), status)).unwrap();
                assert_eq!(keys(&ours), keys(expected));
                assert_eq!(ours["status"], expected["status"]);
                assert_eq!(ours["file"], carried().file);
                assert_eq!(ours["bytes"], carried().bytes);
                // The tiny model is the very file the wire file names, so the answer is the same, byte for byte.
                if cfg!(feature = "tiny-model") {
                    assert_eq!(&ours, expected);
                }
            }
        }

        #[test]
        fn without_the_carried_file_no_engine_starts_and_native_model_answers_none() {
            let dir = std::env::temp_dir().join(format!("cn-gate-{}", std::process::id()));
            let model = dir.join("resources").join("models").join(carried().file);
            let data = dir.join("data");
            // start() resolves the resource and hands it here: no file there (or no resource folder), no engine.
            for missing in [Some(model.clone()), None] {
                let runner = Runner::default();
                runner.start_carried(carried(), missing, Ok(data.clone()));
                assert!(runner.model().is_none(), "native_model answers none");
                let (on_event, got) = channel();
                let e = tauri::async_runtime::block_on(runner.generate(request(5), on_event)).unwrap_err();
                assert_eq!((e.code, e.message.as_str()), (ErrorCode::Offline, imp::NO_MODEL));
                assert!(got.lock().unwrap().is_empty());
                assert!(!runner.stop(5));
            }
            // A folder by the model's name is not the model.
            std::fs::create_dir_all(&model).unwrap();
            assert_eq!(imp::placement(Some(model.clone()), Ok(data.clone())), None);
            std::fs::remove_dir(&model).unwrap();
            // The file there: its stamp in the data folder's models/, or beside the model without a data folder.
            std::fs::write(&model, b"gguf").unwrap();
            assert_eq!(imp::placement(Some(model.clone()), Ok(data.clone())), Some((model.clone(), data.join("models"))));
            let beside = dir.join("resources").join("models");
            assert_eq!(imp::placement(Some(model.clone()), Err(tauri::Error::UnknownPath)), Some((model.clone(), beside)));
            let runner = Runner::default();
            runner.start_carried(carried(), Some(model.clone()), Ok(data.clone()));
            assert!(runner.model().is_some(), "with the file there the engine starts");
            let _ = std::fs::remove_dir_all(dir);
        }

        #[test]
        fn a_stop_that_comes_before_its_answer_is_kept_until_that_answer_takes_it_and_only_the_last_numbers_are_kept() {
            let dir = std::env::temp_dir().join(format!("cn-early-{}", std::process::id()));
            let runner = Runner::default();
            // The file is not there, so the engine refuses every answer once it has looked (and answers no stop true).
            runner.start_at(carried(), dir.join("models").join(carried().file), dir.join("stamps"));
            assert!(!runner.stop(11), "nothing to stop yet: kept");
            assert!(!runner.stop(11), "kept once more, and still false");
            let kept = |runner: &Runner| runner.early.lock().unwrap().clone();
            assert_eq!(kept(&runner), [11, 11]);
            for id in 100..100 + imp::EARLY_STOPS as u32 {
                assert!(!runner.stop(id));
            }
            assert_eq!(kept(&runner).len(), imp::EARLY_STOPS, "bounded");
            assert_eq!(kept(&runner).front(), Some(&100), "the oldest numbers go first");
            // An answer whose number was kept takes its stop with it as it is submitted. That the answer then ends
            // stopped needs a model to answer: tools/browser/nativeE2e.mjs's race checks show it with the tiny model.
            let (on_event, _) = channel();
            let _ = tauri::async_runtime::block_on(runner.generate(request(100), on_event));
            assert!(!kept(&runner).contains(&100));
            assert_eq!(kept(&runner).len(), imp::EARLY_STOPS - 1);
            // A page load forgets every kept stop.
            runner.stop_all();
            assert!(kept(&runner).is_empty());
            let _ = std::fs::remove_dir_all(dir);
        }

        #[test]
        fn a_carried_model_that_is_gone_once_started_is_named_failed_with_a_sentence_and_every_answer_says_why() {
            let dir = std::env::temp_dir().join(format!("cn-runner-{}", std::process::id()));
            let runner = Runner::default();
            runner.start_at(carried(), dir.join("models").join(carried().file), dir.join("stamps"));
            let deadline = Instant::now() + Duration::from_secs(30);
            let reason = loop {
                match runner.model().map(|m| m.status) {
                    Some(Status::Failed { reason, refused: false }) => break reason,
                    Some(Status::Failed { reason, refused: true }) => panic!("this processor was refused: {reason}"),
                    other => assert!(Instant::now() < deadline, "still {other:?}"),
                }
                std::thread::sleep(Duration::from_millis(10));
            };
            plain(&reason);
            assert!(reason.contains("is not where the app put it"), "{reason}");
            let (on_event, got) = channel();
            let e = tauri::async_runtime::block_on(runner.generate(request(9), on_event)).unwrap_err();
            assert_eq!((e.code, e.message.as_str()), (ErrorCode::Model, reason.as_str()));
            assert!(got.lock().unwrap().is_empty());
            assert!(!runner.stop(9), "nothing is left to stop");
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}
