// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Stage 04a: a model's weights on disk, read as an index of byte ranges (the GGUF container of llama.cpp).
//!
//! Why does this file exist? To stream a model that does not fit in memory, a host must know where on the disk each
//! layer's weights, and each expert of a mixture-of-experts layer, live. A GGUF file says so in its header: metadata
//! (architecture, block count, expert count) and one record per tensor (name, shape, quantization type, offset). This
//! file reads that header without trusting it (every count, length and offset is checked against the file before it is
//! used, so a damaged or hostile file is refused, never a panic or a huge allocation) and turns it into units a reader
//! fetches whole: the globals (embeddings, output), each layer's shared part (attention, norms, router, a dense or shared
//! expert FFN), and each expert of each layer. An expert's gate, up and down weights sit in three places in the file, a
//! contiguous slice of each stacked `_exps` tensor (ggml's outermost dimension is the expert), so an expert unit is
//! three extents.
//!
//! The file on disk is never rewritten. A repacked copy (every expert's three slices side by side) would save two read
//! requests per expert, but it would double the model's footprint on the disk and llama.cpp and wllama could no longer
//! load it; reads are aligned to sectors where they are planned instead (stream.rs).
//! What breaks if it is removed? The streamer (stream.rs) has nothing to read and the swarm planner (swarm.rs) no sizes.

use std::collections::BTreeMap;
use std::fmt;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

/// "GGUF", read as a little-endian u32.
pub const GGUF_MAGIC: u32 = 0x4655_4747;
/// The tensor data alignment when `general.alignment` is absent (gguf.h `GGUF_DEFAULT_ALIGNMENT`).
pub const DEFAULT_ALIGNMENT: u64 = 32;
/// ggml's `GGML_MAX_DIMS`.
const MAX_DIMS: usize = 4;
/// Arrays of arrays are legal; deeper than this is refused rather than recursed into.
const MAX_ARRAY_DEPTH: u32 = 8;
/// The smallest a tensor record can be: name length, n_dims, type, offset (an empty name and no dimensions).
const MIN_TENSOR_RECORD: u64 = 8 + 4 + 4 + 8;
/// The smallest a metadata pair can be: key length, value type, a one-byte value.
const MIN_KV_RECORD: u64 = 8 + 4 + 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GgufError {
    Io(String),
    NotGguf { magic: u32 },
    /// Version 1 used 32-bit counts and is long gone; 2 and 3 are read.
    Version(u32),
    /// The header needs bytes past the end of the file.
    Truncated { at: u64, needed: u64, file_len: u64 },
    BadString { at: u64 },
    UnknownValueType { at: u64, value_type: u32 },
    ArrayTooDeep { at: u64 },
    BadAlignment(u64),
    BadTensor { name: String, why: String },
    UnknownTensorType { name: String, ggml_type: u32 },
    Overlap { first: String, second: String },
    DuplicateTensor(String),
}

impl fmt::Display for GgufError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            GgufError::Io(e) => write!(f, "reading the file: {e}"),
            GgufError::NotGguf { magic } => write!(f, "not a GGUF file (magic {magic:#010x})"),
            GgufError::Version(v) => write!(f, "GGUF version {v} is not read (2 and 3 are)"),
            GgufError::Truncated { at, needed, file_len } => {
                write!(f, "the header needs {needed} bytes at {at}, past the end of the {file_len}-byte file")
            }
            GgufError::BadString { at } => write!(f, "the string at {at} is not UTF-8"),
            GgufError::UnknownValueType { at, value_type } => write!(f, "unknown metadata value type {value_type} at {at}"),
            GgufError::ArrayTooDeep { at } => write!(f, "arrays nested deeper than {MAX_ARRAY_DEPTH} at {at}"),
            GgufError::BadAlignment(a) => write!(f, "general.alignment {a} is not a power of two"),
            GgufError::BadTensor { name, why } => write!(f, "tensor {name}: {why}"),
            GgufError::UnknownTensorType { name, ggml_type } => write!(f, "tensor {name}: unknown ggml type {ggml_type}"),
            GgufError::Overlap { first, second } => write!(f, "tensors {first} and {second} overlap"),
            GgufError::DuplicateTensor(n) => write!(f, "tensor {n} appears twice"),
        }
    }
}

impl std::error::Error for GgufError {}

impl From<io::Error> for GgufError {
    fn from(e: io::Error) -> Self {
        GgufError::Io(e.to_string())
    }
}

/// (elements per block, bytes per block) of a ggml tensor type, by its id in ggml.h's `enum ggml_type`. Checked against
/// ggml.c's `type_traits` and ggml-common.h's block structs of llama.cpp master on 2026-11-13. Ids that upstream removed
/// (4, 5, 31-33, 36-38) are unknown here as they are in llama.cpp.
pub fn ggml_block(ggml_type: u32) -> Option<(u64, u64)> {
    Some(match ggml_type {
        0 => (1, 4),      // F32
        1 => (1, 2),      // F16
        2 => (32, 18),    // Q4_0
        3 => (32, 20),    // Q4_1
        6 => (32, 22),    // Q5_0
        7 => (32, 24),    // Q5_1
        8 => (32, 34),    // Q8_0
        9 => (32, 36),    // Q8_1
        10 => (256, 84),  // Q2_K
        11 => (256, 110), // Q3_K
        12 => (256, 144), // Q4_K
        13 => (256, 176), // Q5_K
        14 => (256, 210), // Q6_K
        15 => (256, 292), // Q8_K
        16 => (256, 66),  // IQ2_XXS
        17 => (256, 74),  // IQ2_XS
        18 => (256, 98),  // IQ3_XXS
        19 => (256, 50),  // IQ1_S
        20 => (32, 18),   // IQ4_NL
        21 => (256, 110), // IQ3_S
        22 => (256, 82),  // IQ2_S
        23 => (256, 136), // IQ4_XS
        24 => (1, 1),     // I8
        25 => (1, 2),     // I16
        26 => (1, 4),     // I32
        27 => (1, 8),     // I64
        28 => (1, 8),     // F64
        29 => (256, 56),  // IQ1_M
        30 => (1, 2),     // BF16
        34 => (256, 54),  // TQ1_0
        35 => (256, 66),  // TQ2_0
        39 => (32, 17),   // MXFP4
        40 => (64, 36),   // NVFP4
        41 => (128, 18),  // Q1_0
        42 => (64, 18),   // Q2_0
        43 => (1, 1),     // F8_E4M3
        _ => return None,
    })
}

/// A metadata value. Arrays keep only their element type and length: the index never needs a vocabulary.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Uint(u64),
    Int(i64),
    Float(f64),
    Bool(bool),
    Str(String),
    Array { elem_type: u32, len: u64 },
}

impl Value {
    pub fn as_u64(&self) -> Option<u64> {
        match *self {
            Value::Uint(v) => Some(v),
            Value::Int(v) => u64::try_from(v).ok(),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(s) => Some(s),
            _ => None,
        }
    }
}

/// One tensor record, its offset made absolute (from the start of the file) and its size computed from its shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TensorInfo {
    pub name: String,
    /// ggml order: `dims[0]` is the row length; the last dimension is the outermost (the expert of an `_exps` tensor).
    pub dims: Vec<u64>,
    pub ggml_type: u32,
    pub offset: u64,
    pub bytes: u64,
}

/// A GGUF file's header: everything but the tensor data.
#[derive(Debug, Clone, PartialEq)]
pub struct Gguf {
    pub version: u32,
    pub alignment: u64,
    /// Where the tensor data starts (the end of the header, aligned).
    pub data_start: u64,
    pub file_len: u64,
    pub meta: BTreeMap<String, Value>,
    /// In header order.
    pub tensors: Vec<TensorInfo>,
}

/// A reader over the header bytes that refuses to read past them, and says where it is.
struct Cursor<'a> {
    bytes: &'a [u8],
    at: usize,
    file_len: u64,
}

impl<'a> Cursor<'a> {
    fn remaining(&self) -> u64 {
        (self.bytes.len() - self.at) as u64
    }

    fn take(&mut self, n: u64) -> Result<&'a [u8], GgufError> {
        if n > self.remaining() {
            return Err(GgufError::Truncated { at: self.at as u64, needed: n, file_len: self.file_len });
        }
        let start = self.at;
        self.at += n as usize;
        Ok(&self.bytes[start..self.at])
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N], GgufError> {
        Ok(self.take(N as u64)?.try_into().expect("took N bytes"))
    }

    fn u32(&mut self) -> Result<u32, GgufError> {
        Ok(u32::from_le_bytes(self.array()?))
    }

    fn u64(&mut self) -> Result<u64, GgufError> {
        Ok(u64::from_le_bytes(self.array()?))
    }

    fn string(&mut self) -> Result<String, GgufError> {
        let at = self.at as u64;
        let len = self.u64()?;
        let raw = self.take(len)?;
        String::from_utf8(raw.to_vec()).map_err(|_| GgufError::BadString { at })
    }

    /// Skips a string without allocating it (the strings of an array).
    fn skip_string(&mut self) -> Result<(), GgufError> {
        let len = self.u64()?;
        self.take(len).map(|_| ())
    }

    /// Fails unless `count` records of at least `min` bytes each can still fit in the header bytes left.
    fn plausible(&self, count: u64, min: u64) -> Result<(), GgufError> {
        match count.checked_mul(min) {
            Some(n) if n <= self.remaining() => Ok(()),
            _ => Err(GgufError::Truncated { at: self.at as u64, needed: count.saturating_mul(min), file_len: self.file_len }),
        }
    }

    fn value(&mut self, value_type: u32, depth: u32) -> Result<Value, GgufError> {
        let at = self.at as u64;
        Ok(match value_type {
            0 => Value::Uint(u64::from(self.array::<1>()?[0])),
            1 => Value::Int(i64::from(i8::from_le_bytes(self.array()?))),
            2 => Value::Uint(u64::from(u16::from_le_bytes(self.array()?))),
            3 => Value::Int(i64::from(i16::from_le_bytes(self.array()?))),
            4 => Value::Uint(u64::from(self.u32()?)),
            5 => Value::Int(i64::from(i32::from_le_bytes(self.array()?))),
            6 => Value::Float(f64::from(f32::from_le_bytes(self.array()?))),
            7 => Value::Bool(self.array::<1>()?[0] != 0),
            8 => Value::Str(self.string()?),
            9 => {
                if depth >= MAX_ARRAY_DEPTH {
                    return Err(GgufError::ArrayTooDeep { at });
                }
                let elem_type = self.u32()?;
                let len = self.u64()?;
                match scalar_size(elem_type) {
                    Some(size) => {
                        let n = len.checked_mul(size).ok_or(GgufError::Truncated {
                            at: self.at as u64,
                            needed: u64::MAX,
                            file_len: self.file_len,
                        })?;
                        self.take(n)?;
                    }
                    None if elem_type == 8 => {
                        self.plausible(len, 8)?;
                        for _ in 0..len {
                            self.skip_string()?;
                        }
                    }
                    None if elem_type == 9 => {
                        self.plausible(len, 12)?;
                        for _ in 0..len {
                            self.value(9, depth + 1)?;
                        }
                    }
                    None => return Err(GgufError::UnknownValueType { at, value_type: elem_type }),
                }
                Value::Array { elem_type, len }
            }
            10 => Value::Uint(self.u64()?),
            11 => Value::Int(i64::from_le_bytes(self.array()?)),
            12 => Value::Float(f64::from_le_bytes(self.array()?)),
            other => return Err(GgufError::UnknownValueType { at, value_type: other }),
        })
    }
}

/// Bytes of a fixed-size metadata value type, or None for strings, arrays and unknown types.
fn scalar_size(value_type: u32) -> Option<u64> {
    match value_type {
        0 | 1 | 7 => Some(1),
        2 | 3 => Some(2),
        4..=6 => Some(4),
        10..=12 => Some(8),
        _ => None,
    }
}

impl Gguf {
    /// Reads the header from `prefix`, the first bytes of a file of `file_len` bytes. A prefix too short for the header
    /// gives `Truncated` with `at + needed` inside the file, and `open` reads more.
    pub fn parse(prefix: &[u8], file_len: u64) -> Result<Self, GgufError> {
        let mut c = Cursor { bytes: prefix, at: 0, file_len };
        let magic = c.u32()?;
        if magic != GGUF_MAGIC {
            return Err(GgufError::NotGguf { magic });
        }
        let version = c.u32()?;
        if !(2..=3).contains(&version) {
            return Err(GgufError::Version(version));
        }
        let tensor_count = c.u64()?;
        let kv_count = c.u64()?;
        c.plausible(kv_count, MIN_KV_RECORD)?;
        let mut meta = BTreeMap::new();
        for _ in 0..kv_count {
            let key = c.string()?;
            let value_type = c.u32()?;
            let value = c.value(value_type, 0)?;
            meta.insert(key, value);
        }
        let alignment = match meta.get("general.alignment") {
            None => DEFAULT_ALIGNMENT,
            Some(v) => match v.as_u64() {
                Some(a) if a.is_power_of_two() => a,
                Some(a) => return Err(GgufError::BadAlignment(a)),
                None => return Err(GgufError::BadAlignment(0)),
            },
        };
        c.plausible(tensor_count, MIN_TENSOR_RECORD)?;
        let mut records = Vec::with_capacity(tensor_count as usize);
        for _ in 0..tensor_count {
            let name = c.string()?;
            let n_dims = c.u32()? as usize;
            if n_dims > MAX_DIMS {
                return Err(GgufError::BadTensor { name, why: format!("{n_dims} dimensions (at most {MAX_DIMS})") });
            }
            let mut dims = Vec::with_capacity(n_dims);
            for _ in 0..n_dims {
                dims.push(c.u64()?);
            }
            let ggml_type = c.u32()?;
            let relative = c.u64()?;
            records.push((name, dims, ggml_type, relative));
        }
        let header_end = c.at as u64;
        let data_start = header_end.next_multiple_of(alignment);
        let mut tensors = Vec::with_capacity(records.len());
        let mut names = std::collections::HashSet::with_capacity(records.len());
        for (name, dims, ggml_type, relative) in records {
            if !names.insert(name.clone()) {
                return Err(GgufError::DuplicateTensor(name));
            }
            let bytes = tensor_bytes(&name, &dims, ggml_type)?;
            if relative % alignment != 0 {
                return Err(GgufError::BadTensor { name, why: format!("offset {relative} is not a multiple of {alignment}") });
            }
            let offset = data_start.checked_add(relative);
            let end = offset.and_then(|o| o.checked_add(bytes));
            match (offset, end) {
                (Some(offset), Some(end)) if end <= file_len => tensors.push(TensorInfo { name, dims, ggml_type, offset, bytes }),
                _ => {
                    return Err(GgufError::BadTensor {
                        name,
                        why: format!("{bytes} bytes at data offset {relative} run past the end of the {file_len}-byte file"),
                    })
                }
            }
        }
        let mut by_offset: Vec<&TensorInfo> = tensors.iter().collect();
        by_offset.sort_by_key(|t| (t.offset, t.bytes));
        for w in by_offset.windows(2) {
            if w[0].offset + w[0].bytes > w[1].offset {
                return Err(GgufError::Overlap { first: w[0].name.clone(), second: w[1].name.clone() });
            }
        }
        Ok(Gguf { version, alignment, data_start, file_len, meta, tensors })
    }

    /// Reads a GGUF file's header: the first 4 MiB, then four times more until the header fits (a vocabulary of a
    /// quarter of a million tokens is a few MiB).
    pub fn open(path: &Path) -> Result<Self, GgufError> {
        let mut file = File::open(path)?;
        let file_len = file.metadata()?.len();
        let mut want = (4u64 << 20).min(file_len);
        loop {
            let mut prefix = Vec::with_capacity(want as usize);
            file.seek(SeekFrom::Start(0))?;
            (&mut file).take(want).read_to_end(&mut prefix)?;
            match Gguf::parse(&prefix, file_len) {
                Err(GgufError::Truncated { at, needed, .. }) if want < file_len && at.saturating_add(needed) <= file_len => {
                    want = want.saturating_mul(4).max(at + needed).min(file_len);
                }
                Err(GgufError::Truncated { at, needed, .. }) => return Err(GgufError::Truncated { at, needed, file_len }),
                other => return other,
            }
        }
    }

    pub fn architecture(&self) -> Option<&str> {
        self.meta.get("general.architecture").and_then(Value::as_str)
    }

    /// `{architecture}.{key}` as an unsigned number (`block_count`, `expert_count`, `expert_used_count`).
    pub fn arch_u64(&self, key: &str) -> Option<u64> {
        let arch = self.architecture()?;
        self.meta.get(&format!("{arch}.{key}")).and_then(Value::as_u64)
    }
}

/// A tensor's size in bytes, from its shape and type, refusing what llama.cpp would refuse.
fn tensor_bytes(name: &str, dims: &[u64], ggml_type: u32) -> Result<u64, GgufError> {
    let (block, block_bytes) =
        ggml_block(ggml_type).ok_or_else(|| GgufError::UnknownTensorType { name: name.to_string(), ggml_type })?;
    let row = dims.first().copied().unwrap_or(1);
    if row % block != 0 {
        return Err(GgufError::BadTensor { name: name.to_string(), why: format!("row of {row} is not a multiple of the block {block}") });
    }
    let too_big = || GgufError::BadTensor { name: name.to_string(), why: "its size overflows 64 bits".to_string() };
    let mut bytes = (row / block).checked_mul(block_bytes).ok_or_else(too_big)?;
    for &d in dims.iter().skip(1) {
        bytes = bytes.checked_mul(d).ok_or_else(too_big)?;
    }
    Ok(bytes)
}

/// A byte range of the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Extent {
    pub offset: u64,
    pub len: u64,
}

impl Extent {
    pub fn end(&self) -> u64 {
        self.offset + self.len
    }
}

/// What a unit of weights is. Ordered as a forward pass meets them: the globals, then each layer's shared part
/// followed by its experts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum UnitKey {
    /// Everything outside the blocks: token embeddings, the output norm and head.
    Globals,
    /// A layer's tensors that every token uses: attention, norms, the router, a dense FFN or a shared expert.
    Layer(u32),
    /// One routed expert of a layer: its slice of every `_exps` tensor (gate, up, down and any biases).
    Expert { layer: u32, expert: u32 },
}

/// A unit's bytes on disk, sorted by offset.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unit {
    pub key: UnitKey,
    pub extents: Vec<Extent>,
}

impl Unit {
    pub fn bytes(&self) -> u64 {
        self.extents.iter().map(|e| e.len).sum()
    }
}

/// The weights of one GGUF file as units a reader fetches whole.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WeightIndex {
    pub architecture: String,
    pub layers: u32,
    /// Routed experts per MoE layer (0 for a dense model).
    pub experts: u32,
    /// Experts each token is routed to (`expert_used_count`).
    pub experts_used: u32,
    units: BTreeMap<UnitKey, Unit>,
}

/// The layer of a tensor named `blk.{n}.…`, and the rest of its name.
fn split_layer(name: &str) -> Option<(u32, &str)> {
    let rest = name.strip_prefix("blk.")?;
    let (n, tail) = rest.split_once('.')?;
    if n.is_empty() || !n.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((n.parse().ok()?, tail))
}

impl WeightIndex {
    /// Groups every tensor of `g` into units. An `_exps` tensor must have the expert count as its outermost dimension;
    /// its slice for expert `e` is the `e`-th of that many equal, contiguous parts.
    pub fn build(g: &Gguf) -> Result<Self, GgufError> {
        let experts = g.arch_u64("expert_count").unwrap_or(0);
        let experts_used = g.arch_u64("expert_used_count").unwrap_or(0);
        let block_count = g.arch_u64("block_count").unwrap_or(0);
        let narrow = |what: &str, v: u64| {
            u32::try_from(v).map_err(|_| GgufError::BadTensor { name: what.to_string(), why: format!("{v} does not fit 32 bits") })
        };
        let (experts, experts_used) = (narrow("expert_count", experts)?, narrow("expert_used_count", experts_used)?);
        let mut units: BTreeMap<UnitKey, Unit> = BTreeMap::new();
        let mut push = |key: UnitKey, e: Extent| units.entry(key).or_insert_with(|| Unit { key, extents: Vec::new() }).extents.push(e);
        let mut top_layer = None;
        for t in &g.tensors {
            let Some((layer, tail)) = split_layer(&t.name) else {
                push(UnitKey::Globals, Extent { offset: t.offset, len: t.bytes });
                continue;
            };
            top_layer = top_layer.max(Some(layer));
            let stacked = tail.split('.').next().is_some_and(|base| base.ends_with("_exps"));
            if !stacked || experts == 0 {
                push(UnitKey::Layer(layer), Extent { offset: t.offset, len: t.bytes });
                continue;
            }
            let outer = t.dims.last().copied().unwrap_or(1);
            if outer != u64::from(experts) || t.bytes % outer != 0 {
                return Err(GgufError::BadTensor {
                    name: t.name.clone(),
                    why: format!("its outermost dimension is {outer}, not the {experts} experts"),
                });
            }
            let stride = t.bytes / outer;
            for e in 0..experts {
                push(UnitKey::Expert { layer, expert: e }, Extent { offset: t.offset + u64::from(e) * stride, len: stride });
            }
        }
        for u in units.values_mut() {
            u.extents.sort();
        }
        let seen = top_layer.map_or(0, |l: u32| l + 1);
        let layers = narrow("block_count", block_count)?.max(seen);
        Ok(WeightIndex { architecture: g.architecture().unwrap_or("").to_string(), layers, experts, experts_used, units })
    }

    pub fn unit(&self, key: UnitKey) -> Option<&Unit> {
        self.units.get(&key)
    }

    /// Every unit, in forward-pass order.
    pub fn units(&self) -> impl Iterator<Item = &Unit> {
        self.units.values()
    }

    pub fn is_moe(&self) -> bool {
        self.experts > 0 && self.units.keys().any(|k| matches!(k, UnitKey::Expert { .. }))
    }

    /// Bytes of a layer's shared part.
    pub fn layer_shared_bytes(&self, layer: u32) -> u64 {
        self.unit(UnitKey::Layer(layer)).map_or(0, Unit::bytes)
    }

    /// Bytes of one expert of a layer (0 where the layer has none).
    pub fn expert_bytes(&self, layer: u32, expert: u32) -> u64 {
        self.unit(UnitKey::Expert { layer, expert }).map_or(0, Unit::bytes)
    }

    /// Bytes of a whole layer: its shared part and every expert.
    pub fn layer_bytes(&self, layer: u32) -> u64 {
        self.layer_shared_bytes(layer) + (0..self.experts).map(|e| self.expert_bytes(layer, e)).sum::<u64>()
    }

    /// Bytes every token reads: the shared parts and `experts_used` experts of every layer (the active parameters).
    pub fn active_bytes_per_token(&self) -> u64 {
        let mut total = 0;
        for layer in 0..self.layers {
            total += self.layer_shared_bytes(layer);
            let per_expert = if self.experts == 0 { 0 } else { self.expert_bytes(layer, 0) };
            total += per_expert * u64::from(self.experts_used);
        }
        total
    }

    /// Bytes of every tensor.
    pub fn total_bytes(&self) -> u64 {
        self.units.values().map(Unit::bytes).sum()
    }
}

/// Writes GGUF files: the fixtures of the tests and the synthetic model of the `stream` run. Tensor data are a hash of
/// each byte's position in the file, so any byte read back can be checked without the writer's copy.
pub mod write {
    use super::{ggml_block, GGUF_MAGIC};

    /// The byte a synthetic file holds at `pos`.
    pub fn byte_at(pos: u64) -> u8 {
        let mut x = pos.wrapping_add(0x9e37_79b9_7f4a_7c15);
        x = (x ^ (x >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        x = (x ^ (x >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        (x ^ (x >> 31)) as u8
    }

    pub enum Meta {
        U32(u32),
        U64(u64),
        Str(String),
        /// An array of strings (a vocabulary stand-in).
        Strs(Vec<String>),
    }

    pub struct Tensor {
        pub name: String,
        pub dims: Vec<u64>,
        pub ggml_type: u32,
    }

    /// A GGUF v3 file's bytes: `meta` then `tensors`, laid out in the order given at `alignment`. Panics on a type the
    /// table does not know (a fixture bug).
    pub fn gguf(meta: &[(&str, Meta)], tensors: &[Tensor], alignment: u64) -> Vec<u8> {
        let (mut out, places) = header(meta, tensors, alignment);
        for (at, size) in places {
            out.resize(at as usize, 0);
            out.extend((at..at + size).map(byte_at));
        }
        out
    }

    /// The same file's header, padded to where the tensor data start, and each tensor's (absolute offset, bytes): what
    /// a caller needs to write the data itself or to index a file of real shapes without writing it.
    pub fn header(meta: &[(&str, Meta)], tensors: &[Tensor], alignment: u64) -> (Vec<u8>, Vec<(u64, u64)>) {
        let mut out = Vec::new();
        let str_ = |out: &mut Vec<u8>, s: &str| {
            out.extend_from_slice(&(s.len() as u64).to_le_bytes());
            out.extend_from_slice(s.as_bytes());
        };
        out.extend_from_slice(&GGUF_MAGIC.to_le_bytes());
        out.extend_from_slice(&3u32.to_le_bytes());
        out.extend_from_slice(&(tensors.len() as u64).to_le_bytes());
        out.extend_from_slice(&(meta.len() as u64).to_le_bytes());
        for (key, value) in meta {
            str_(&mut out, key);
            match value {
                Meta::U32(v) => {
                    out.extend_from_slice(&4u32.to_le_bytes());
                    out.extend_from_slice(&v.to_le_bytes());
                }
                Meta::U64(v) => {
                    out.extend_from_slice(&10u32.to_le_bytes());
                    out.extend_from_slice(&v.to_le_bytes());
                }
                Meta::Str(s) => {
                    out.extend_from_slice(&8u32.to_le_bytes());
                    str_(&mut out, s);
                }
                Meta::Strs(list) => {
                    out.extend_from_slice(&9u32.to_le_bytes());
                    out.extend_from_slice(&8u32.to_le_bytes());
                    out.extend_from_slice(&(list.len() as u64).to_le_bytes());
                    for s in list {
                        str_(&mut out, s);
                    }
                }
            }
        }
        let mut relative = 0u64;
        let mut sizes = Vec::new();
        for t in tensors {
            let (block, bytes) = ggml_block(t.ggml_type).expect("a known type");
            let size = t.dims[0] / block * bytes * t.dims.iter().skip(1).product::<u64>();
            str_(&mut out, &t.name);
            out.extend_from_slice(&(t.dims.len() as u32).to_le_bytes());
            for d in &t.dims {
                out.extend_from_slice(&d.to_le_bytes());
            }
            out.extend_from_slice(&t.ggml_type.to_le_bytes());
            out.extend_from_slice(&relative.to_le_bytes());
            sizes.push((relative, size));
            relative = (relative + size).next_multiple_of(alignment);
        }
        let data_start = (out.len() as u64).next_multiple_of(alignment);
        out.resize(data_start as usize, 0);
        (out, sizes.into_iter().map(|(rel, size)| (data_start + rel, size)).collect())
    }
}
