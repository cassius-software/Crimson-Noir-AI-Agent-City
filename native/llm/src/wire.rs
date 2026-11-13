// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Why does this file exist? It is everything the page and the runner say to each other, as plain data with fixed
//! names: the request for an answer, the events streamed while it is made, how it ended, and why it could not be made.
//! The page reads the same names (tests/wire.json holds one of each, written from these types by tests/wire.rs, so a
//! renamed field fails a test on both sides). Every event is small: a text event carries at most `TEXT_MAX` bytes, so
//! its JSON stays under the 8 KiB that Tauri's channel delivers straight into the page.
//! What breaks if it is removed? The shell and the page have no shared words for an answer.

use serde::{Deserialize, Serialize};

/// The most text bytes one `Text` event carries. Even if every byte were escaped as `\u00XX` (six bytes), the event's
/// JSON stays under 8,192 bytes, the size up to which Tauri's channel hands a message to the page directly.
pub const TEXT_MAX: usize = 1024;

/// Who said a message of the conversation.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
}

impl Role {
    /// The role's name as the model's template writes it.
    pub fn as_str(self) -> &'static str {
        match self {
            Role::System => "system",
            Role::User => "user",
            Role::Assistant => "assistant",
        }
    }
}

/// One message of the conversation.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Message {
    pub role: Role,
    pub content: String,
}

/// The page's request for an answer. `id` is the page's own (random) number for it, used to stop it; `max_tokens` 0
/// means the plan's cap. `think` is accepted and ignored: the models carried have no thinking mode.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenRequest {
    pub id: u32,
    pub messages: Vec<Message>,
    #[serde(default)]
    pub max_tokens: u32,
    #[serde(default)]
    pub think: bool,
}

/// What the page is told while its answer is made, in this order (each but `Text` only when it applies).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RunEvent {
    /// Another answer is being made first; this one runs after it.
    Waiting,
    /// The model file is being checked or copied before its first use: `done` of `total` bytes.
    Preparing { done: u64, total: u64 },
    /// The model is being loaded, `fraction` from 0 to 1.
    Loading { fraction: f32 },
    /// The prompt is being read: `done` of `total` tokens (the reused part counts as read).
    Read { done: u32, total: u32 },
    /// The next piece of the answer: whole characters, at most `TEXT_MAX` bytes.
    Text { text: String },
}

/// Why an answer ended.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Reason {
    /// The model ended its turn.
    Eog,
    /// The request's (or the plan's) token cap was reached.
    MaxTokens,
    /// The page stopped it, or went away.
    Stopped,
    /// The context is full.
    Context,
}

/// How an answer ended, with what the page can show of its cost (read off a device to tune the plan).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GenDone {
    pub id: u32,
    pub reason: Reason,
    /// Tokens of answer made.
    pub tokens: u32,
    /// Tokens of the rendered prompt.
    pub prompt_tokens: u32,
    /// Of those, how many the context still held from the last answer and were not read again.
    pub reused: u32,
    pub prefill_ms: u64,
    pub gen_ms: u64,
    pub threads: i32,
    pub n_ctx: u32,
    pub n_batch: u32,
    /// Whether the model's layers were given to a GPU.
    pub gpu: bool,
}

/// Why an answer could not be made. `Offline`: there is no runner or no model here (the page looks elsewhere).
/// `Refused`: this device cannot run it (its processor or memory). `Model`: the model failed to load or to answer.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    Offline,
    Refused,
    Model,
}

/// An answer that could not be made, with a plain sentence the page can show.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct RunError {
    pub code: ErrorCode,
    pub message: String,
}

impl RunError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> RunError {
        RunError { code, message: message.into() }
    }
}

/// Where the runner stands.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Status {
    /// The model file is being checked or copied: `done` of `total` bytes.
    Preparing { done: u64, total: u64 },
    /// The file is checked; the model loads on the first answer.
    Ready,
    /// The model is loaded.
    Loaded,
    /// It cannot run here, and why (a plain sentence); `refused` when it is this device.
    Failed { reason: String, refused: bool },
}
