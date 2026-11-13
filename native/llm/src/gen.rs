// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Why does this file exist? It makes one answer on the model thread. The conversation is rendered with the model's
//! template and tokenized with its special tokens read as such (so `<|im_start|>` is one token, not eleven letters).
//! What the context still holds from the last answer is kept: only the tokens after the common prefix are read, in
//! chunks of the plan's batch, the stop flag read between chunks. Then one token at a time: sampled, ended at the
//! model's end-of-turn (or any control token, which starts another turn), passed through the text filters (`text`) and
//! streamed, decoded, and the stop flag read again. The context never holds a token it was not given, so the next
//! answer can trust what it keeps; a failed decode clears it.
//! What breaks if it is removed? The runner has no way to make an answer.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use llama_cpp_2::context::LlamaContext;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::LlamaModel;
use llama_cpp_2::sampling::LlamaSampler;
use llama_cpp_2::token::LlamaToken;

use crate::engine::{untouched, Answer, Plan, Sampling, Sink};
use crate::template;
use crate::text::{Batcher, StopText, Utf8Hold};
use crate::wire::{ErrorCode, GenDone, GenRequest, Reason, RunError, RunEvent};

pub(crate) struct State<'m> {
    model: &'m LlamaModel,
    ctx: LlamaContext<'m>,
    plan: Plan,
    /// The tokens the context holds for sequence 0, in order.
    cached: Vec<LlamaToken>,
}

fn sampler(sampling: Sampling) -> LlamaSampler {
    match sampling {
        Sampling::Greedy => LlamaSampler::greedy(),
        Sampling::Chat { seed } => {
            let seed = seed.unwrap_or_else(|| {
                SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.subsec_nanos() ^ (d.as_secs() as u32)).unwrap_or(0x5eed)
            });
            LlamaSampler::chain_simple([
                LlamaSampler::top_k(40),
                LlamaSampler::top_p(0.95, 1),
                LlamaSampler::min_p(0.05, 1),
                LlamaSampler::temp(0.8),
                LlamaSampler::dist(seed),
            ])
        }
    }
}

fn model_error(what: &str, e: impl std::fmt::Display) -> RunError {
    RunError::new(ErrorCode::Model, format!("the model failed {what} ({e})"))
}

impl<'m> State<'m> {
    pub(crate) fn new(model: &'m LlamaModel, ctx: LlamaContext<'m>, plan: Plan) -> State<'m> {
        State { model, ctx, plan, cached: Vec::new() }
    }

    /// Forgets the context after a failure, so the next answer reads its whole prompt again.
    fn reset(&mut self) {
        self.ctx.clear_kv_cache();
        self.cached.clear();
    }

    pub(crate) fn answer(&mut self, req: &GenRequest, sink: &mut Sink, stop: &AtomicBool) -> Answer {
        let t0 = Instant::now();
        let model = self.model;
        let prompt = template::render(model, &req.messages).map_err(|m| RunError::new(ErrorCode::Model, m))?;
        let vocab = model.vocab();
        let tokens = vocab.tokenize(prompt.as_bytes(), true, true);
        let n_ctx = self.plan.n_ctx as usize;
        if tokens.is_empty() {
            return Err(RunError::new(ErrorCode::Model, "the conversation is empty"));
        }
        if tokens.len() >= n_ctx {
            return Err(RunError::new(
                ErrorCode::Model,
                format!("the conversation is {} tokens, more than the {} the model can hold", tokens.len(), n_ctx),
            ));
        }
        let total = u32::try_from(tokens.len()).unwrap_or(u32::MAX);

        // Keep what the context already holds of this prompt (never all of it: the last token is read for its logits).
        let mut common = self.cached.iter().zip(&tokens).take_while(|(a, b)| a == b).count().min(tokens.len() - 1);
        if common < self.cached.len() {
            match self.ctx.clear_kv_cache_seq(Some(0), Some(common as u32), None) {
                Ok(true) => self.cached.truncate(common),
                _ => {
                    self.reset();
                    common = 0;
                }
            }
        }
        let reused = common as u32;
        let n_batch = self.plan.n_batch.max(1) as usize;
        let mut alive = sink(RunEvent::Read { done: reused, total });
        let mut batch = LlamaBatch::new(n_batch, 1);
        let mut pos = common;
        for chunk in tokens[common..].chunks(n_batch) {
            if stop.load(Ordering::Relaxed) || !alive {
                return Ok(self.done(req.id, Reason::Stopped, 0, total, reused, t0, None));
            }
            batch.clear();
            for (i, &token) in chunk.iter().enumerate() {
                let at = pos + i;
                if let Err(e) = batch.add(token, at as i32, &[0], at == tokens.len() - 1) {
                    self.reset();
                    return Err(model_error("to read the prompt", e));
                }
            }
            if let Err(e) = self.ctx.decode(&mut batch) {
                self.reset();
                return Err(model_error("to read the prompt", e));
            }
            pos += chunk.len();
            self.cached.extend_from_slice(chunk);
            alive = sink(RunEvent::Read { done: pos as u32, total });
        }
        let t1 = Instant::now();

        let cap = match (req.max_tokens, self.plan.max_tokens) {
            (0, plan) => plan,
            (asked, plan) => asked.min(plan),
        };
        let mut sampler = sampler(self.plan.sampling);
        let (mut utf8, mut guard, mut batcher) = (Utf8Hold::default(), StopText::default(), Batcher::default());
        let mut one = LlamaBatch::new(1, 1);
        let mut made = 0u32;
        let mut send = |text: String, alive: &mut bool| {
            if !text.is_empty() && *alive {
                *alive = sink(RunEvent::Text { text });
            }
        };
        let reason = loop {
            if stop.load(Ordering::Relaxed) || !alive {
                break Reason::Stopped;
            }
            if made >= cap {
                break Reason::MaxTokens;
            }
            if self.cached.len() >= n_ctx {
                break Reason::Context;
            }
            // The last decode asked for logits on its last token only; -1 is that one.
            let token = sampler.sample(&self.ctx, -1);
            if vocab.is_eog(token) || vocab.is_control(token) {
                break Reason::Eog;
            }
            let piece = utf8.push(&vocab.token_to_piece(token, false, None));
            let (shown, marker) = guard.push(&piece);
            for text in batcher.push(&shown, Instant::now()) {
                send(text, &mut alive);
            }
            made += 1;
            if marker {
                break Reason::Eog;
            }
            one.clear();
            if let Err(e) = one.add(token, self.cached.len() as i32, &[0], true) {
                self.reset();
                return Err(model_error("to answer", e));
            }
            if let Err(e) = self.ctx.decode(&mut one) {
                self.reset();
                return Err(model_error("to answer", e));
            }
            self.cached.push(token);
        };
        let (shown, marker) = guard.push(&utf8.finish());
        let rest = if marker { shown } else { shown + &guard.finish() };
        for text in batcher.push(&rest, Instant::now()) {
            send(text, &mut alive);
        }
        if let Some(text) = batcher.finish() {
            send(text, &mut alive);
        }
        Ok(self.done(req.id, reason, made, total, reused, t0, Some(t1)))
    }

    #[allow(clippy::too_many_arguments)]
    fn done(&self, id: u32, reason: Reason, tokens: u32, prompt_tokens: u32, reused: u32, t0: Instant, t1: Option<Instant>) -> GenDone {
        let now = Instant::now();
        let (prefill, gen) = match t1 {
            Some(t1) => (t1.duration_since(t0), now.duration_since(t1)),
            None => (now.duration_since(t0), Default::default()),
        };
        GenDone {
            tokens,
            prompt_tokens,
            reused,
            prefill_ms: prefill.as_millis() as u64,
            gen_ms: gen.as_millis() as u64,
            ..untouched(id, reason, &self.plan)
        }
    }
}
