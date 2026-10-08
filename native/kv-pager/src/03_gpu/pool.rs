// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Stage 03 (feature `gpu`): the pages on the device.
//!
//! Why does this file exist? It puts the page table on a GPU: a fixed pool of KV pages allocated once, the copy a
//! copy-on-write asks for, and the compute pipeline that runs `PAGED_ATTENTION_WGSL` (kernel.rs) over the block tables.
//! What breaks if it is removed? The page table still works, but nothing holds the pages it hands out, and the kernel
//! has no pipeline.
//!
//! Pool layout: per layer one K and one V storage buffer, each `[block][slot][kv_head][head_dim / 2]` words of two f16
//! values. A token's heads are contiguous, so one write stores a token for one layer, and a copy-on-write of the first
//! `n` slots of a block is one contiguous range per buffer that never touches slot `n` (the token about to be written).

use crate::{BlockId, Geometry, GpuTables, BLOCK_TOKENS, PAGED_ATTENTION_WGSL};
use wgpu::util::DeviceExt;

/// Invocations per workgroup; the kernel's TILE, and half its HEAD_DIM.
const WORKGROUP: usize = 64;

/// A device and its queue.
pub struct Gpu {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub info: wgpu::AdapterInfo,
    pub limits: wgpu::Limits,
}

impl Gpu {
    /// The discrete GPU where one is visible (on a hybrid laptop a high-performance request can still come back with the
    /// integrated one), with its own storage-buffer limits.
    pub fn new() -> Result<Self, String> {
        // WGPU_BACKEND (vulkan, dx12, …) narrows the backends.
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor::from_env_or_default());
        let discrete = instance.enumerate_adapters(wgpu::Backends::all()).into_iter().find(|a| a.get_info().device_type == wgpu::DeviceType::DiscreteGpu);
        let adapter = match discrete {
            Some(a) => a,
            None => pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                compatible_surface: None,
            }))
            .ok_or("no GPU adapter")?,
        };
        let info = adapter.get_info();
        let have = adapter.limits();
        let limits = wgpu::Limits {
            max_storage_buffer_binding_size: have.max_storage_buffer_binding_size,
            max_buffer_size: have.max_buffer_size,
            ..wgpu::Limits::default()
        };
        let (device, queue) = pollster::block_on(adapter.request_device(
            &wgpu::DeviceDescriptor { label: Some("kv-pager"), required_features: wgpu::Features::empty(), required_limits: limits.clone(), memory_hints: wgpu::MemoryHints::Performance },
            None,
        ))
        .map_err(|e| format!("request_device: {e}"))?;
        Ok(Self { device, queue, info, limits })
    }

    /// Driver-side allocations as the backend's allocator reports them (DX12 and Vulkan), or None.
    pub fn allocator_report(&self) -> Option<AllocatorTotals> {
        self.device.generate_allocator_report().map(|r| AllocatorTotals {
            allocated_bytes: r.total_allocated_bytes,
            reserved_bytes: r.total_reserved_bytes,
            allocations: r.allocations.len(),
            memory_blocks: r.blocks.len(),
        })
    }
}

/// The totals of a backend allocator report.
#[derive(Debug, Clone, Copy)]
pub struct AllocatorTotals {
    pub allocated_bytes: u64,
    pub reserved_bytes: u64,
    pub allocations: usize,
    pub memory_blocks: usize,
}

/// The fixed pool of KV pages: allocated whole at start, never grown.
pub struct KvPool {
    pub geometry: Geometry,
    pub blocks: usize,
    k: Vec<wgpu::Buffer>,
    v: Vec<wgpu::Buffer>,
    /// Where a copy-on-write bounces (a buffer cannot be copied into itself): one block of every layer, K and V.
    staging: wgpu::Buffer,
}

impl KvPool {
    /// Words (two f16) one token's keys (or values) take in one layer.
    pub fn token_words(g: &Geometry) -> usize {
        g.kv_heads * g.head_dim / 2
    }

    /// Bytes of one layer's K (or V) buffer for `blocks` pages.
    pub fn layer_bytes(g: &Geometry, blocks: usize) -> u64 {
        (blocks * BLOCK_TOKENS * Self::token_words(g) * 4) as u64
    }

    /// Bytes of one page across every layer, keys and values.
    pub fn block_bytes(g: &Geometry) -> u64 {
        2 * g.layers as u64 * Self::layer_bytes(g, 1)
    }

    /// Allocates `blocks` pages on the device. An allocation the device refuses (out of memory, or over its buffer
    /// limits) is an error, and nothing is kept.
    pub fn new(gpu: &Gpu, geometry: Geometry, blocks: usize) -> Result<Self, String> {
        assert_eq!(geometry.head_dim, 2 * WORKGROUP, "the kernel is built for head_dim 128");
        let bytes = Self::layer_bytes(&geometry, blocks);
        if bytes > u64::from(gpu.limits.max_storage_buffer_binding_size) || bytes > gpu.limits.max_buffer_size {
            return Err(format!("a layer's pool buffer of {bytes} B exceeds the device's binding limit"));
        }
        gpu.device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        gpu.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let make = |kind: &str, layer: usize| {
            gpu.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(&format!("kv-pool {kind} layer {layer}")),
                size: bytes,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            })
        };
        let k: Vec<_> = (0..geometry.layers).map(|l| make("K", l)).collect();
        let v: Vec<_> = (0..geometry.layers).map(|l| make("V", l)).collect();
        let staging = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("kv-pool copy-on-write staging"),
            size: 2 * geometry.layers as u64 * Self::layer_bytes(&geometry, 1),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let validation = pollster::block_on(gpu.device.pop_error_scope());
        let oom = pollster::block_on(gpu.device.pop_error_scope());
        if let Some(e) = oom.or(validation) {
            return Err(format!("pool allocation of {blocks} blocks failed: {e}"));
        }
        Ok(Self { geometry, blocks, k, v, staging })
    }

    /// Bytes the pool holds on the device (the pages; the one-block staging buffer is `staging_bytes`).
    pub fn bytes(&self) -> u64 {
        2 * self.geometry.layers as u64 * Self::layer_bytes(&self.geometry, self.blocks)
    }

    pub fn staging_bytes(&self) -> u64 {
        self.staging.size()
    }

    fn slot_offset(&self, block: BlockId, slot: usize) -> u64 {
        assert!((block as usize) < self.blocks && slot < BLOCK_TOKENS);
        ((block as usize * BLOCK_TOKENS + slot) * Self::token_words(&self.geometry) * 4) as u64
    }

    /// Stores one token's keys and values for one layer (each `token_words` words). Queue writes land before the
    /// command buffers of the next submit.
    pub fn write_token(&self, queue: &wgpu::Queue, layer: usize, block: BlockId, slot: usize, k: &[u32], v: &[u32]) {
        let words = Self::token_words(&self.geometry);
        assert!(k.len() == words && v.len() == words);
        let at = self.slot_offset(block, slot);
        queue.write_buffer(&self.k[layer], at, bytemuck::cast_slice(k));
        queue.write_buffer(&self.v[layer], at, bytemuck::cast_slice(v));
    }

    /// Records the copy a copy-on-write asks for: the first `slots` token slots of `src` into `dst`, every layer, keys
    /// and values, through the staging buffer (commands in an encoder run in order, so the next copy may reuse it).
    /// Returns the bytes copied.
    pub fn encode_copy(&self, enc: &mut wgpu::CommandEncoder, src: BlockId, dst: BlockId, slots: usize) -> u64 {
        let len = (slots * Self::token_words(&self.geometry) * 4) as u64;
        if len == 0 {
            return 0;
        }
        let (from, to) = (self.slot_offset(src, 0), self.slot_offset(dst, 0));
        let stride = Self::layer_bytes(&self.geometry, 1);
        let buffers = self.k.iter().chain(&self.v);
        for (i, b) in buffers.clone().enumerate() {
            enc.copy_buffer_to_buffer(b, from, &self.staging, i as u64 * stride, len);
        }
        for (i, b) in buffers.enumerate() {
            enc.copy_buffer_to_buffer(&self.staging, i as u64 * stride, b, to, len);
        }
        2 * self.geometry.layers as u64 * len
    }
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    num_seqs: u32,
    max_blocks: u32,
    q_heads: u32,
    kv_heads: u32,
    pool_blocks: u32,
    scale: f32,
    _pad: [u32; 2],
}

/// The decode-step attention pipeline (`PAGED_ATTENTION_WGSL`, entry `decode`).
pub struct Decode {
    pipeline: wgpu::ComputePipeline,
    layout: wgpu::BindGroupLayout,
}

impl Decode {
    pub fn new(gpu: &Gpu) -> Result<Self, String> {
        gpu.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let module = gpu.device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("paged_attention.wgsl"),
            source: wgpu::ShaderSource::Wgsl(PAGED_ATTENTION_WGSL.into()),
        });
        let storage = |binding: u32, read_only: bool| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only }, has_dynamic_offset: false, min_binding_size: None },
            count: None,
        };
        let layout = gpu.device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("paged attention"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
                    count: None,
                },
                storage(1, true),
                storage(2, true),
                storage(3, true),
                storage(4, true),
                storage(5, true),
                storage(6, false),
            ],
        });
        let pipeline_layout = gpu.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("paged attention"),
            bind_group_layouts: &[&layout],
            push_constant_ranges: &[],
        });
        let pipeline = gpu.device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("paged attention decode"),
            layout: Some(&pipeline_layout),
            module: &module,
            entry_point: Some("decode"),
            compilation_options: Default::default(),
            cache: None,
        });
        if let Some(e) = pollster::block_on(gpu.device.pop_error_scope()) {
            return Err(format!("paged_attention.wgsl: {e}"));
        }
        Ok(Self { pipeline, layout })
    }

    /// One decode step for one layer: `q` is `[seq][q_head][head_dim]` for the sequences of `tables`, in order; the
    /// result has the same shape.
    pub fn run(&self, gpu: &Gpu, pool: &KvPool, layer: usize, tables: &GpuTables, q: &[f32]) -> Vec<f32> {
        let g = &pool.geometry;
        let seqs = tables.seq_lens.len();
        assert_eq!(q.len(), seqs * g.q_heads * g.head_dim);
        let d = &gpu.device;
        let params = Params {
            num_seqs: seqs as u32,
            max_blocks: tables.max_blocks as u32,
            q_heads: g.q_heads as u32,
            kv_heads: g.kv_heads as u32,
            pool_blocks: pool.blocks as u32,
            scale: 1.0 / (g.head_dim as f32).sqrt(),
            _pad: [0; 2],
        };
        let init = |label: &str, contents: &[u8], usage| d.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some(label), contents, usage });
        let params_buf = init("params", bytemuck::bytes_of(&params), wgpu::BufferUsages::UNIFORM);
        let q_buf = init("q", bytemuck::cast_slice(q), wgpu::BufferUsages::STORAGE);
        let table_buf = init("block_table", bytemuck::cast_slice(&tables.block_table), wgpu::BufferUsages::STORAGE);
        let lens_buf = init("seq_lens", bytemuck::cast_slice(&tables.seq_lens), wgpu::BufferUsages::STORAGE);
        let out_bytes = (q.len() * 4) as u64;
        let out_buf = d.create_buffer(&wgpu::BufferDescriptor { label: Some("out"), size: out_bytes, usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false });
        let read_buf = d.create_buffer(&wgpu::BufferDescriptor { label: Some("readback"), size: out_bytes, usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        let bind = d.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("paged attention"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: params_buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: q_buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: pool.k[layer].as_entire_binding() },
                wgpu::BindGroupEntry { binding: 3, resource: pool.v[layer].as_entire_binding() },
                wgpu::BindGroupEntry { binding: 4, resource: table_buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 5, resource: lens_buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 6, resource: out_buf.as_entire_binding() },
            ],
        });
        let mut enc = d.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("decode") });
        {
            let mut pass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("decode"), timestamp_writes: None });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &bind, &[]);
            pass.dispatch_workgroups(g.q_heads as u32, seqs as u32, 1);
        }
        enc.copy_buffer_to_buffer(&out_buf, 0, &read_buf, 0, out_bytes);
        gpu.queue.submit([enc.finish()]);
        let slice = read_buf.slice(..);
        slice.map_async(wgpu::MapMode::Read, |r| r.expect("readback map"));
        d.poll(wgpu::Maintain::Wait);
        let out = bytemuck::cast_slice(&slice.get_mapped_range()).to_vec();
        read_buf.unmap();
        out
    }
}

/// f32 → f16 bits, round to nearest even (what the host stores and the kernel's unpack2x16float reads back exactly).
pub fn f16_bits(x: f32) -> u16 {
    let b = x.to_bits();
    let sign = ((b >> 16) & 0x8000) as u16;
    let exp = ((b >> 23) & 0xff) as i32;
    let man = b & 0x7f_ffff;
    if exp == 0xff {
        return sign | 0x7c00 | if man != 0 { 0x200 } else { 0 };
    }
    let e = exp - 127 + 15;
    if e >= 0x1f {
        return sign | 0x7c00;
    }
    if e <= 0 {
        if e < -10 {
            return sign;
        }
        let m = man | 0x80_0000;
        let shift = (14 - e) as u32;
        let half = 1u32 << (shift - 1);
        let rest = m & ((1 << shift) - 1);
        let mut r = m >> shift;
        if rest > half || (rest == half && r & 1 == 1) {
            r += 1;
        }
        return sign | r as u16;
    }
    let mut r = ((e as u32) << 10) | (man >> 13);
    let rest = man & 0x1fff;
    if rest > 0x1000 || (rest == 0x1000 && r & 1 == 1) {
        r += 1;
    }
    sign | r as u16
}

/// f16 bits → f32.
pub fn f16_value(h: u16) -> f32 {
    let sign = if h & 0x8000 != 0 { -1.0 } else { 1.0 };
    let exp = i32::from((h >> 10) & 0x1f);
    let man = f32::from(h & 0x3ff);
    sign * match exp {
        0 => man * 2f32.powi(-24),
        0x1f => if man == 0.0 { f32::INFINITY } else { f32::NAN },
        _ => (1.0 + man / 1024.0) * 2f32.powi(exp - 15),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn f16_round_trips_and_rounds_to_nearest_even() {
        for x in [0.0f32, -0.0, 1.0, -2.5, 0.333_333_34, 65504.0, 6.1e-5, 5.96e-8, -1.0e-3] {
            let back = f16_value(f16_bits(x));
            assert!((back - x).abs() <= x.abs() * 1e-3 + 6e-8, "{x} -> {back}");
        }
        assert_eq!(f16_bits(1.0), 0x3c00);
        assert_eq!(f16_bits(1.0 + 1.0 / 2048.0), 0x3c00, "a tie rounds to even");
        assert_eq!(f16_bits(1.0 + 3.0 / 2048.0), 0x3c02);
        assert_eq!(f16_bits(1.0e6), 0x7c00);
        for h in (0u16..0x7c00).step_by(7) {
            assert_eq!(f16_bits(f16_value(h)), h);
        }
    }
}
