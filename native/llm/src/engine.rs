// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Why does this file exist? llama.cpp's context belongs to one thread at a time, and a model is too big to load
//! twice, so the runner is one thread named "model" that owns the backend's model and its context, and every answer is
//! a job sent to it. On start the thread checks the processor (`guard`) and the model file (`verify`: once, then a
//! stamp; or copied out of a package; one part of a split model is refused), then waits; the model loads on the first
//! answer, not at launch, so an app that is never asked never spends the memory. Jobs run in the order they came: one
//! sent while another is being made is told it waits. A job is stopped by its flag, read between decode calls (one
//! token, or one chunk of prompt), and a page that goes away stops its jobs (`stop_all`, and a sink that answers
//! false). A stopped job is sent nothing more, and one stopped while the file is checked or copied is answered at the
//! next piece read, not when the file is done. A stop never cancels a load: the next answer would only load again.
//! What breaks if it is removed? Nothing can ask the model for an answer.

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{self, Read};
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;

use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::model::params::{LlamaModelParams, LlamaSplitMode};
use llama_cpp_2::model::LlamaModel;

use crate::backend::backend;
use crate::gen::State;
use crate::guard;
use crate::verify::{self, Pin};
use crate::wire::{ErrorCode, GenDone, GenRequest, Reason, RunError, RunEvent, Status};

/// Where the page's events go. It answers false once nobody is listening (the page went away), which stops the job.
pub type Sink = Box<dyn FnMut(RunEvent) -> bool + Send>;
/// How an answer ended, or why it could not be made.
pub type Answer = Result<GenDone, RunError>;
/// Opens the model inside a package, on the model thread (Android's asset reader is not `Send`).
pub type Opener = Box<dyn FnOnce() -> io::Result<Box<dyn Read>> + Send>;

/// Where the model file is.
pub enum Source {
    /// A real file llama.cpp can map in place (the app's resources on macOS, Linux and iOS).
    Path(PathBuf),
    /// Inside a package, copied out once to `dest` and checked on the way (Android's APK assets).
    Copy { open: Opener, dest: PathBuf },
}

/// Whether the model's layers go to a GPU. `Off` keeps every device out of the model and its context (split mode None,
/// main GPU -1, no op offload), so no work runs on a GPU. It does not stop Metal from starting: wherever Metal is
/// compiled in (every Apple build but watchOS), llama.cpp's backend start registers it, which creates the device and a
/// command queue and compiles its whole shader library, whatever the plan. A CPU-only Apple app that must not pay for
/// that is built with GGML_METAL=OFF (llama-cpp-sys-2 passes GGML_* environment variables to CMake).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Gpu {
    Off,
    All,
}

/// How the next token is chosen. `Chat` is llama.cpp's usual chain (top-k 40, top-p 0.95, min-p 0.05, temperature
/// 0.8), seeded from the clock unless a seed is given; `Greedy` always takes the likeliest, for tests.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sampling {
    Greedy,
    Chat { seed: Option<u32> },
}

/// The platform's plan, chosen by the shell: context and batch sizes, threads, GPU, the cap on an answer's tokens.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Plan {
    pub n_ctx: u32,
    pub n_batch: u32,
    pub threads: i32,
    pub gpu: Gpu,
    pub max_tokens: u32,
    pub sampling: Sampling,
}

/// Half the processor's threads, at least one and at most `cap`, so the web view keeps the rest.
pub fn half_the_threads(cap: i32) -> i32 {
    let n = thread::available_parallelism().map(|n| n.get()).unwrap_or(2);
    i32::try_from(n / 2).unwrap_or(1).clamp(1, cap.max(1))
}

pub(crate) struct Job {
    pub(crate) req: GenRequest,
    pub(crate) sink: Sink,
    pub(crate) stop: Arc<AtomicBool>,
    reply: Sender<Answer>,
}

impl Job {
    fn stopped(&self) -> bool {
        self.stop.load(Ordering::Relaxed)
    }
}

struct Shared {
    status: Mutex<Status>,
    live: Mutex<HashMap<u32, Arc<AtomicBool>>>,
    /// Held from counting a job to queueing it, so being told it waits and its place in the queue agree. The model
    /// thread never takes it, and it is never taken inside `live`.
    submit: Mutex<()>,
    /// Jobs sent and not yet answered.
    pending: AtomicUsize,
    /// Models loaded by this engine (one, once it has answered).
    loads: AtomicUsize,
}

/// A lock that a panic elsewhere never poisons for good (the release build aborts on a panic anyway).
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// The runner: its model thread and what the shell asks of it.
pub struct Engine {
    tx: Sender<Job>,
    shared: Arc<Shared>,
}

impl Engine {
    /// Starts the model thread: it checks the processor and the model file now, and loads the model on the first job.
    pub fn start(pin: Pin, source: Source, plan: Plan, stamp_dir: PathBuf) -> Engine {
        let (tx, rx) = mpsc::channel();
        let shared = Arc::new(Shared {
            status: Mutex::new(Status::Preparing { done: 0, total: pin.bytes }),
            live: Mutex::new(HashMap::new()),
            submit: Mutex::new(()),
            pending: AtomicUsize::new(0),
            loads: AtomicUsize::new(0),
        });
        let worker_shared = shared.clone();
        let spawned = thread::Builder::new()
            .name("model".into())
            .spawn(move || worker(pin, source, plan, stamp_dir, rx, worker_shared));
        if let Err(e) = spawned {
            *lock(&shared.status) = Status::Failed { reason: format!("the model's thread could not start ({e})"), refused: false };
        }
        Engine { tx, shared }
    }

    /// Where the runner stands.
    pub fn status(&self) -> Status {
        lock(&self.shared.status).clone()
    }

    /// How many times this engine has loaded its model.
    pub fn loads(&self) -> usize {
        self.shared.loads.load(Ordering::SeqCst)
    }

    /// Asks for an answer. Events go to `sink` as it is made; the receiver gets how it ended. A request whose `id` is
    /// already being answered, or sent to a runner that cannot run, is answered at once with the reason.
    pub fn submit(&self, req: GenRequest, mut sink: Sink) -> Receiver<Answer> {
        let (reply, answer) = mpsc::channel();
        if let Status::Failed { reason, refused } = self.status() {
            let _ = reply.send(Err(RunError::new(if refused { ErrorCode::Refused } else { ErrorCode::Model }, reason)));
            return answer;
        }
        let id = req.id;
        let stop = Arc::new(AtomicBool::new(false));
        {
            let mut live = lock(&self.shared.live);
            if live.contains_key(&id) {
                let _ = reply.send(Err(RunError::new(ErrorCode::Model, "an answer with this number is already being made")));
                return answer;
            }
            live.insert(id, stop.clone());
        }
        // Counted and queued in one turn, so a job told it waits is queued behind another. The sink (a channel send)
        // returns at once and never submits, so holding the turn across it is safe.
        let _turn = lock(&self.shared.submit);
        let waits = self.shared.pending.fetch_add(1, Ordering::SeqCst) > 0;
        if waits && !stop.load(Ordering::Relaxed) && !sink(RunEvent::Waiting) {
            stop.store(true, Ordering::Relaxed);
        }
        if let Err(mpsc::SendError(job)) = self.tx.send(Job { req, sink, stop, reply }) {
            finish(&self.shared, job, Err(RunError::new(ErrorCode::Model, "the model's thread has stopped")));
        }
        answer
    }

    /// Stops the answer `id`, queued or being made; false when there is none.
    pub fn stop(&self, id: u32) -> bool {
        match lock(&self.shared.live).get(&id) {
            Some(flag) => {
                flag.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }

    /// Stops every answer (the page reloaded or closed).
    pub fn stop_all(&self) {
        for flag in lock(&self.shared.live).values() {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

/// Answers a job and forgets it.
fn finish(shared: &Shared, job: Job, answer: Answer) {
    {
        let mut live = lock(&shared.live);
        if live.get(&job.req.id).is_some_and(|f| Arc::ptr_eq(f, &job.stop)) {
            live.remove(&job.req.id);
        }
    }
    shared.pending.fetch_sub(1, Ordering::SeqCst);
    let _ = job.reply.send(answer);
}

/// What a job that ends before it starts is answered.
pub(crate) fn untouched(id: u32, reason: Reason, plan: &Plan) -> GenDone {
    GenDone {
        id,
        reason,
        tokens: 0,
        prompt_tokens: 0,
        reused: 0,
        prefill_ms: 0,
        gen_ms: 0,
        threads: plan.threads,
        n_ctx: plan.n_ctx,
        n_batch: plan.n_batch,
        gpu: plan.gpu == Gpu::All,
    }
}

/// The jobs: those that came while the file was being prepared first, then the channel.
struct Queue {
    early: VecDeque<Job>,
    rx: Receiver<Job>,
}

impl Queue {
    fn gather(&mut self) {
        while let Ok(job) = self.rx.try_recv() {
            self.early.push_back(job);
        }
    }

    fn next(&mut self) -> Option<Job> {
        self.early.pop_front().or_else(|| self.rx.recv().ok())
    }
}

fn set(shared: &Shared, status: Status) {
    *lock(&shared.status) = status;
}

/// The runner cannot run: every job from now on is answered with why.
fn fail(shared: &Shared, queue: &mut Queue, reason: String, refused: bool) {
    set(shared, Status::Failed { reason: reason.clone(), refused });
    let code = if refused { ErrorCode::Refused } else { ErrorCode::Model };
    while let Some(job) = queue.next() {
        finish(shared, job, Err(RunError::new(code, reason.clone())));
    }
}

fn worker(pin: Pin, source: Source, plan: Plan, stamp_dir: PathBuf, rx: Receiver<Job>, shared: Arc<Shared>) {
    let mut queue = Queue { early: VecDeque::new(), rx };
    if let Some(why) = guard::cpu_refusal() {
        return fail(&shared, &mut queue, why, true);
    }
    let path = match prepare(&pin, source, &stamp_dir, &shared, &mut queue, &plan) {
        Ok(path) => path,
        Err(why) => return fail(&shared, &mut queue, why, false),
    };
    set(&shared, Status::Ready);
    let backend = match backend() {
        Ok(b) => b,
        Err(why) => return fail(&shared, &mut queue, why, false),
    };
    // The first job that still wants an answer loads the model.
    let first = loop {
        let Some(job) = queue.next() else { return };
        if job.stopped() {
            let done = untouched(job.req.id, Reason::Stopped, &plan);
            finish(&shared, job, Ok(done));
        } else {
            break job;
        }
    };
    let (model, first) = match load(backend, &path, &plan, first) {
        Ok(loaded) => loaded,
        Err((why, job)) => {
            finish(&shared, job, Err(RunError::new(ErrorCode::Model, why.clone())));
            return fail(&shared, &mut queue, why, false);
        }
    };
    shared.loads.fetch_add(1, Ordering::SeqCst);
    let plan = Plan { n_ctx: plan.n_ctx.min(model.n_ctx_train().max(1)), ..plan };
    let ctx = match model.new_context(backend, context_params(&plan)) {
        Ok(ctx) => ctx,
        Err(e) => {
            let why = format!("the model's context could not be made ({e})");
            finish(&shared, first, Err(RunError::new(ErrorCode::Model, why.clone())));
            return fail(&shared, &mut queue, why, false);
        }
    };
    set(&shared, Status::Loaded);
    let mut state = State::new(&model, ctx, plan);
    let mut job = Some(first);
    while let Some(mut current) = job.take().or_else(|| queue.next()) {
        let answer = if current.stopped() {
            Ok(untouched(current.req.id, Reason::Stopped, &plan))
        } else {
            state.answer(&current.req, &mut current.sink, &current.stop)
        };
        finish(&shared, current, answer);
    }
}

/// Checks (or copies out and checks) the model file; jobs that come meanwhile are told how far it has got.
fn prepare(
    pin: &Pin,
    source: Source,
    stamp_dir: &Path,
    shared: &Shared,
    queue: &mut Queue,
    plan: &Plan,
) -> Result<PathBuf, String> {
    // The file llama.cpp is handed. A pin covers one file, and llama.cpp opens a split model's other parts by itself.
    let target = match &source {
        Source::Path(path) => path,
        Source::Copy { dest, .. } => dest,
    };
    if let Some(n) = verify::split_parts(target) {
        return Err(format!(
            "the app's model ({}) is one of {n} parts of a split model, and the runner loads only one checked file",
            pin.file
        ));
    }
    let mut last = u64::MAX;
    let mut progress = |done: u64, total: u64| {
        set(shared, Status::Preparing { done, total });
        queue.gather();
        // A job stopped meanwhile (its own stop, or stop_all on a page load) is answered now and told nothing more.
        let (gone, keep): (VecDeque<Job>, VecDeque<Job>) =
            std::mem::take(&mut queue.early).into_iter().partition(Job::stopped);
        queue.early = keep;
        for job in gone {
            let stopped = untouched(job.req.id, Reason::Stopped, plan);
            finish(shared, job, Ok(stopped));
        }
        let pct = done.saturating_mul(100) / total.max(1);
        if pct != last {
            last = pct;
            for job in queue.early.iter_mut().filter(|job| !job.stopped()) {
                if !(job.sink)(RunEvent::Preparing { done, total }) {
                    job.stop.store(true, Ordering::Relaxed);
                }
            }
        }
    };
    match source {
        Source::Path(path) => {
            verify::check_file(&path, pin, stamp_dir, &mut progress)?;
            Ok(path)
        }
        Source::Copy { open, dest } => {
            if verify::check_file(&dest, pin, stamp_dir, &mut progress).is_ok() {
                return Ok(dest);
            }
            // A file there that is not the pinned model (an older one) goes now, so it holds no space during the copy.
            let _ = fs::remove_file(&dest);
            let mut reader = open().map_err(|e| format!("the app's model could not be opened in its package ({e})"))?;
            verify::copy_checked(&mut *reader, &dest, pin, verify::free_bytes, &mut progress)?;
            verify::stamp(&dest, pin, stamp_dir);
            Ok(dest)
        }
    }
}

/// Loads the model, telling the first job how far it has got. Never cancelled: a stop is read once it is loaded.
fn load(backend: &LlamaBackend, path: &Path, plan: &Plan, job: Job) -> Result<(LlamaModel, Job), (String, Job)> {
    let Job { req, sink, stop, reply } = job;
    // The load's callback must own what it calls, so the job's sink is shared with it for the rest of the job.
    let shared_sink = Arc::new(Mutex::new(sink));
    let for_load = shared_sink.clone();
    let stop_on_gone = stop.clone();
    let mut last = -1.0f32;
    let params = LlamaModelParams::default().with_use_mmap(true).with_progress_callback(move |fraction| {
        // A stopped job is told nothing more (the load itself goes on).
        if !stop_on_gone.load(Ordering::Relaxed) && (fraction >= 1.0 || fraction - last >= 0.02) {
            last = fraction;
            if !(lock(&for_load))(RunEvent::Loading { fraction }) {
                stop_on_gone.store(true, Ordering::Relaxed);
            }
        }
        true
    });
    let params = match plan.gpu {
        Gpu::Off => params.with_n_gpu_layers(0).with_split_mode(LlamaSplitMode::None).with_main_gpu(-1),
        Gpu::All => params.with_n_gpu_layers(999),
    };
    let loaded = LlamaModel::load_from_file(backend, path, &params);
    drop(params);
    let sink: Sink = Box::new(move |event| (lock(&shared_sink))(event));
    let job = Job { req, sink, stop, reply };
    match loaded {
        Ok(model) => Ok((model, job)),
        Err(e) => Err((format!("the app's model could not be loaded ({e})"), job)),
    }
}

fn context_params(plan: &Plan) -> LlamaContextParams {
    LlamaContextParams::default()
        .with_n_ctx(NonZeroU32::new(plan.n_ctx))
        .with_n_batch(plan.n_batch)
        .with_n_ubatch(plan.n_batch)
        .with_n_threads(plan.threads)
        .with_n_threads_batch(plan.threads)
        .with_op_offload(plan.gpu == Gpu::All)
}
