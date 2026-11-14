// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Why does this file exist? A chat model answers well only in the format it was trained on. The conversation is
//! rendered with the model's own chat template (the GGUF's tokenizer.chat_template), through llama.cpp's built-in
//! template engine, which knows Qwen2.5's as ChatML; a model with no template, or one the engine does not know, is
//! rendered as ChatML. The rendered
//! prompt ends by opening the assistant's turn, so the model answers rather than continuing the user's words.
//! What breaks if it is removed? The model is given raw text and answers off format.

use llama_cpp_2::model::{LlamaChatMessage, LlamaChatTemplate, LlamaModel};

use crate::wire::Message;

/// The conversation as the model's prompt.
pub fn render(model: &LlamaModel, messages: &[Message]) -> Result<String, String> {
    let chat = messages
        .iter()
        .map(|m| LlamaChatMessage::new(m.role.as_str().to_string(), m.content.clone()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "a message holds a NUL character, which the model cannot read".to_string())?;
    // The model's own template first; one llama.cpp's engine does not know falls back to ChatML too.
    if let Ok(own) = model.chat_template(None) {
        if let Ok(prompt) = model.apply_chat_template(&own, &chat, true) {
            return Ok(prompt);
        }
    }
    let chatml = LlamaChatTemplate::new("chatml").map_err(|_| "the ChatML template could not be named".to_string())?;
    model
        .apply_chat_template(&chatml, &chat, true)
        .map_err(|e| format!("the conversation could not be put in the model's format ({e})"))
}
