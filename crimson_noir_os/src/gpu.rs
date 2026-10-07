//! Why does this file exist? It runs the Global Matrix on a GPU through wgpu: the swarm's tick (shaders/swarm.wgsl),
//! the routing relaxation (shaders/route.wgsl) and the bitonic sort (shaders/sort.wgsl), the CPU kernels' twins. The
//! matrix is uploaded as a few structure-of-arrays buffers (bytemuck casts, no per-agent object), many ticks or passes
//! go into one submission (each dispatch reads its own parameters at a dynamic uniform offset), and the scripted
//! self-test run is replayed on the GPU with the host stepping in only where the script does (the looper's trap, the
//! rogue's request), so its proof and its final matrix can be compared with the CPU's word for word.
//! What breaks if it is removed? The hosted runtime has no GPU compute, and nothing checks the WGSL against the CPU.

use std::num::NonZeroU64;
use std::sync::mpsc;

use bytemuck::{Pod, Zeroable};
use noir_core::config::{CAP_SPAWN, Dims};
use noir_core::kernels::{FATE_DROPPED, FATE_FLUSHED, FATE_REAPED, INF, Tally, step_of};
use noir_core::matrix::{self, GOLDEN_TICKS, Matrix, Proof, ROGUE_TICK, TRAP_TICK};
use wgpu::util::DeviceExt;

pub const SWARM_WGSL: &str = include_str!("../shaders/swarm.wgsl");
pub const ROUTE_WGSL: &str = include_str!("../shaders/route.wgsl");
pub const SORT_WGSL: &str = include_str!("../shaders/sort.wgsl");

/// The word arrays in the order swarm.wgsl reads them (ALIVE .. FATE).
const WORDS: usize = 12;
/// Dispatches one submission may carry (each needs its own uniform slot).
const BATCH: u32 = 256;
const NONE: u32 = u32::MAX;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct TickParams {
    t: u32,
    capacity: u32,
    width: u32,
    depth: u32,
    stations: u32,
    block_words: u32,
    loop_limit: u32,
    learn_shift: u32,
    explore: u32,
    step: f32,
    rogue: u32,
    looper: u32,
    watch_spare: u32,
    pad: [u32; 3],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct PassParams {
    a: u32,
    b: u32,
    c: u32,
    d: u32,
}

struct Kernel {
    layout: wgpu::BindGroupLayout,
    pipeline: wgpu::ComputePipeline,
}

/// The device, its queue and the three kernels.
pub struct Gpu {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub info: wgpu::AdapterInfo,
    /// The uniform buffers' dynamic offset step.
    stride: u64,
    tick: Kernel,
    relax: Kernel,
    sort: Kernel,
}

fn storage(binding: u32, read_only: bool) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only }, has_dynamic_offset: false, min_binding_size: None },
        count: None,
    }
}

fn dynamic_uniform(size: u64) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding: 0,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: true, min_binding_size: NonZeroU64::new(size) },
        count: None,
    }
}

fn kernel(device: &wgpu::Device, name: &str, source: &str, entry: &str, entries: &[wgpu::BindGroupLayoutEntry]) -> Kernel {
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some(name), source: wgpu::ShaderSource::Wgsl(source.into()) });
    let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some(name), entries });
    let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some(name), bind_group_layouts: &[Some(&layout)], immediate_size: 0 });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some(name),
        layout: Some(&pl),
        module: &module,
        entry_point: Some(entry),
        compilation_options: Default::default(),
        cache: None,
    });
    Kernel { layout, pipeline }
}

/// The first adapter wgpu offers (a GPU, or a software one such as Mesa's lavapipe), with the WebGPU default limits.
pub fn open() -> Result<Gpu, String> {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        ..Default::default()
    }))
    .map_err(|e| format!("no GPU adapter ({e}); Vulkan, Metal or DX12 is needed (Mesa's lavapipe works)"))?;
    let info = adapter.get_info();
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("crimson noir"),
        required_limits: wgpu::Limits::default(),
        ..Default::default()
    }))
    .map_err(|e| format!("the adapter {} refused a device: {e}", info.name))?;
    let stride = device.limits().min_uniform_buffer_offset_alignment.max(256) as u64;
    let tick = kernel(
        &device,
        "swarm tick",
        SWARM_WGSL,
        "tick",
        &[dynamic_uniform(64), storage(1, false), storage(2, false), storage(3, false), storage(4, false), storage(5, true), storage(6, false), storage(7, false)],
    );
    let relax = kernel(
        &device,
        "routing relaxation",
        ROUTE_WGSL,
        "relax",
        &[dynamic_uniform(16), storage(1, true), storage(2, true), storage(3, true), storage(4, false), storage(5, false)],
    );
    let sort = kernel(&device, "bitonic pass", SORT_WGSL, "bitonic", &[dynamic_uniform(16), storage(1, false)]);
    Ok(Gpu { device, queue, info, stride, tick, relax, sort })
}

fn buffer(gpu: &Gpu, name: &str, contents: &[u8], extra: wgpu::BufferUsages) -> wgpu::Buffer {
    gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some(name),
        contents,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC | wgpu::BufferUsages::COPY_DST | extra,
    })
}

fn uniforms(gpu: &Gpu, name: &str, slots: u32) -> wgpu::Buffer {
    gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some(name),
        size: gpu.stride * slots as u64,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}

fn binding(buffer: &wgpu::Buffer, n: u32, size: Option<u64>) -> wgpu::BindGroupEntry<'_> {
    wgpu::BindGroupEntry {
        binding: n,
        resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding { buffer, offset: 0, size: size.and_then(NonZeroU64::new) }),
    }
}

/// Copies `bytes` of `src` back to the host (a staging buffer, mapped once the queue is done).
fn read_back(gpu: &Gpu, src: &wgpu::Buffer, bytes: u64) -> Vec<u8> {
    let staging = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("read back"),
        size: bytes,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut enc = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
    enc.copy_buffer_to_buffer(src, 0, &staging, 0, bytes);
    gpu.queue.submit([enc.finish()]);
    let (tx, rx) = mpsc::channel();
    staging.slice(..).map_async(wgpu::MapMode::Read, move |r| {
        let _ = tx.send(r);
    });
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("the GPU did not finish");
    rx.recv().expect("the map never answered").expect("the read-back could not be mapped");
    let data = staging.slice(..).get_mapped_range().expect("the read-back mapping").to_vec();
    staging.unmap();
    data
}

/// The Global Matrix on the GPU.
pub struct Swarm {
    d: Dims,
    pos: wgpu::Buffer,
    words: wgpu::Buffer,
    weights: wgpu::Buffer,
    memory: wgpu::Buffer,
    world: wgpu::Buffer,
    tally: wgpu::Buffer,
    watch: wgpu::Buffer,
    params: wgpu::Buffer,
    bind: wgpu::BindGroup,
    /// Ticks the watch buffer has rows for.
    rows: u32,
}

fn words_of(m: &Matrix) -> Vec<u32> {
    let arrays = [&m.alive, &m.doomed, &m.caps, &m.req, &m.role, &m.goal, &m.run, &m.last, &m.trips, &m.clock, &m.heading, &m.fate];
    arrays.iter().flat_map(|a| a.iter().copied()).collect()
}

fn world_of(m: &Matrix) -> Vec<u32> {
    m.walls.iter().chain(m.field.iter()).copied().collect()
}

/// Uploads the matrix; the watch buffer keeps `rows` ticks of the rogue's and the looper's state.
pub fn upload(gpu: &Gpu, d: &Dims, m: &Matrix, rows: u32) -> Swarm {
    let pos: Vec<f32> = m.px.iter().chain(m.pz.iter()).copied().collect();
    let pos = buffer(gpu, "positions", bytemuck::cast_slice(&pos), wgpu::BufferUsages::empty());
    let words = buffer(gpu, "words", bytemuck::cast_slice(&words_of(m)), wgpu::BufferUsages::empty());
    let weights = buffer(gpu, "weights", bytemuck::cast_slice(&m.weights), wgpu::BufferUsages::empty());
    let memory = buffer(gpu, "memory", bytemuck::cast_slice(&m.memory), wgpu::BufferUsages::empty());
    let world = buffer(gpu, "world", bytemuck::cast_slice(&world_of(m)), wgpu::BufferUsages::empty());
    let tally = buffer(gpu, "tally", &[0u8; 16], wgpu::BufferUsages::empty());
    let watch = buffer(gpu, "watch", &vec![0u8; (rows as usize * 4 + d.capacity) * 4], wgpu::BufferUsages::empty());
    let params = uniforms(gpu, "tick parameters", BATCH);
    let bind = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("swarm"),
        layout: &gpu.tick.layout,
        entries: &[
            binding(&params, 0, Some(64)),
            binding(&pos, 1, None),
            binding(&words, 2, None),
            binding(&weights, 3, None),
            binding(&memory, 4, None),
            binding(&world, 5, None),
            binding(&tally, 6, None),
            binding(&watch, 7, None),
        ],
    });
    Swarm { d: *d, pos, words, weights, memory, world, tally, watch, params, bind, rows }
}

/// Reads the whole matrix back.
pub fn download(gpu: &Gpu, s: &Swarm, m: &mut Matrix) {
    let cap = s.d.capacity;
    let pos: Vec<f32> = bytemuck::cast_slice(&read_back(gpu, &s.pos, (cap * 8) as u64)).to_vec();
    m.px.copy_from_slice(&pos[..cap]);
    m.pz.copy_from_slice(&pos[cap..]);
    let words: Vec<u32> = bytemuck::cast_slice(&read_back(gpu, &s.words, (cap * WORDS * 4) as u64)).to_vec();
    let arrays = [
        &mut m.alive, &mut m.doomed, &mut m.caps, &mut m.req, &mut m.role, &mut m.goal, &mut m.run, &mut m.last, &mut m.trips,
        &mut m.clock, &mut m.heading, &mut m.fate,
    ];
    for (k, a) in arrays.into_iter().enumerate() {
        a.copy_from_slice(&words[k * cap..(k + 1) * cap]);
    }
    let w: Vec<i32> = bytemuck::cast_slice(&read_back(gpu, &s.weights, (m.weights.len() * 4) as u64)).to_vec();
    m.weights.copy_from_slice(&w);
    let mem: Vec<u32> = bytemuck::cast_slice(&read_back(gpu, &s.memory, (m.memory.len() * 4) as u64)).to_vec();
    m.memory.copy_from_slice(&mem);
    let world: Vec<u32> = bytemuck::cast_slice(&read_back(gpu, &s.world, ((m.walls.len() + m.field.len()) * 4) as u64)).to_vec();
    let cells = m.walls.len();
    m.walls.copy_from_slice(&world[..cells]);
    m.field.copy_from_slice(&world[cells..]);
}

/// Runs ticks `from .. from + n` in as few submissions as the uniform slots allow.
pub fn ticks(gpu: &Gpu, s: &Swarm, from: u32, n: u32, rogue: u32, looper: u32) {
    let d = &s.d;
    let mut done = 0;
    while done < n {
        let batch = (n - done).min(BATCH);
        let mut bytes = vec![0u8; (gpu.stride * batch as u64) as usize];
        for k in 0..batch {
            let t = from + done + k;
            // Only the ticks the watch has rows for name the rogue and the looper.
            let (r, l) = if t < s.rows { (rogue, looper) } else { (NONE, NONE) };
            let p = TickParams {
                t,
                capacity: d.capacity as u32,
                width: d.width as u32,
                depth: d.depth as u32,
                stations: d.stations as u32,
                block_words: d.block_words as u32,
                loop_limit: d.loop_limit,
                learn_shift: d.learn_shift,
                explore: d.explore,
                step: step_of(d),
                rogue: r,
                looper: l,
                watch_spare: s.rows * 4,
                pad: [0; 3],
            };
            let at = (gpu.stride * k as u64) as usize;
            bytes[at..at + 64].copy_from_slice(bytemuck::bytes_of(&p));
        }
        gpu.queue.write_buffer(&s.params, 0, &bytes);
        let mut enc = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        {
            let mut pass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("ticks"), timestamp_writes: None });
            pass.set_pipeline(&gpu.tick.pipeline);
            for k in 0..batch {
                pass.set_bind_group(0, &s.bind, &[(gpu.stride * k as u64) as u32]);
                pass.dispatch_workgroups((d.capacity / 64) as u32, 1, 1);
            }
        }
        gpu.queue.submit([enc.finish()]);
        done += batch;
    }
}

/// What the ticks so far left in the tally (dropped, flushed, reaped, docked).
pub fn tally(gpu: &Gpu, s: &Swarm) -> Tally {
    let t: Vec<u32> = bytemuck::cast_slice(&read_back(gpu, &s.tally, 16)).to_vec();
    Tally { dropped: t[0], flushed: t[1], reaped: t[2], docked: t[3] }
}

fn write_word(gpu: &Gpu, buf: &wgpu::Buffer, index: usize, v: u32) {
    gpu.queue.write_buffer(buf, (index * 4) as u64, bytemuck::bytes_of(&v));
}

/// The scripted self-test run (matrix::golden) on the GPU: the host steps in where golden_step does (the looper's
/// trap from TRAP_TICK until it is placed, the rogue's request at ROGUE_TICK, the rogue's row read back after the tick
/// after), and reads the rest from the watch rows and the tally. Returns the proof and the final matrix.
pub fn golden(gpu: &Gpu, d: &Dims, role_counts: &[u32], role_caps: &[u32]) -> (Proof, Matrix) {
    let mut m = matrix::new(d);
    let mut p = matrix::golden_begin(d, role_counts, role_caps, &mut m);
    let s = upload(gpu, d, &m, GOLDEN_TICKS);
    let cap = d.capacity;
    let mut t = 0;
    while t < GOLDEN_TICKS {
        let trap_pending = p.trapped_at == NONE && p.looper != NONE;
        if trap_pending && t >= TRAP_TICK {
            download(gpu, &s, &mut m);
            if let Some(cell) = matrix::intended_cell(d, &m, p.looper as usize)
                && !m.station.contains(&cell)
                && m.walls[cell as usize] == 0
            {
                m.walls[cell as usize] = 1;
                write_word(gpu, &s.world, cell as usize, 1);
                p.trap_cell = cell;
                p.trapped_at = t;
            }
        }
        if t == ROGUE_TICK && p.rogue != NONE {
            // Requests last one tick, so the slot holds nothing else now.
            write_word(gpu, &s.words, 3 * cap + p.rogue as usize, CAP_SPAWN);
        }
        // Run on to the next tick the script looks at.
        let mut until = GOLDEN_TICKS;
        if p.trapped_at == NONE && p.looper != NONE {
            until = until.min(if t >= TRAP_TICK { t + 1 } else { TRAP_TICK });
        }
        if t < ROGUE_TICK {
            until = until.min(ROGUE_TICK);
        } else if t < ROGUE_TICK + 2 {
            until = until.min(ROGUE_TICK + 2);
        }
        ticks(gpu, &s, t, until - t, p.rogue, p.looper);
        t = until;
        if t == ROGUE_TICK + 2 && p.rogue != NONE {
            download(gpu, &s, &mut m);
            let r = p.rogue as usize;
            p.rogue_reaped = m.fate[r] & FATE_REAPED != 0 && matrix::row_is_zero(d, &m, r);
        }
    }
    let watch: Vec<u32> = bytemuck::cast_slice(&read_back(gpu, &s.watch, (GOLDEN_TICKS * 16) as u64)).to_vec();
    let row = |t: u32, k: u32| watch[(t * 4 + k) as usize];
    if p.rogue != NONE {
        p.rogue_dropped = row(ROGUE_TICK, 0) & FATE_DROPPED != 0 && row(ROGUE_TICK, 1) == 0;
    }
    if p.looper != NONE {
        p.looper_flushed_at = (0..GOLDEN_TICKS).find(|&t| row(t, 2) & FATE_FLUSHED != 0).unwrap_or(NONE);
    }
    p.totals = tally(gpu, &s);
    p.tick = GOLDEN_TICKS;
    download(gpu, &s, &mut m);
    p.fingerprint = matrix::fingerprint(&m);
    (p, m)
}

/// The routing relaxation on the GPU, from the matrix's walls and stations: the fields and the passes it took to
/// settle (as matrix::route counts them).
pub fn route(gpu: &Gpu, d: &Dims, m: &Matrix) -> (Vec<u32>, u32) {
    let cells = d.width * d.depth;
    let mut field = vec![INF; d.stations * cells];
    for (s, &home) in m.station.iter().enumerate() {
        field[s * cells + home as usize] = 0;
    }
    let walls = buffer(gpu, "walls", bytemuck::cast_slice(&m.walls), wgpu::BufferUsages::empty());
    let station = buffer(gpu, "stations", bytemuck::cast_slice(&m.station), wgpu::BufferUsages::empty());
    let a = buffer(gpu, "field a", bytemuck::cast_slice(&field), wgpu::BufferUsages::empty());
    let b = buffer(gpu, "field b", bytemuck::cast_slice(&field), wgpu::BufferUsages::empty());
    let changed = buffer(gpu, "changed", &vec![0u8; BATCH as usize * 4], wgpu::BufferUsages::empty());
    let params = uniforms(gpu, "pass parameters", BATCH);
    let group = |src: &wgpu::Buffer, dst: &wgpu::Buffer| {
        gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("relax"),
            layout: &gpu.relax.layout,
            entries: &[binding(&params, 0, Some(16)), binding(&walls, 1, None), binding(&station, 2, None), binding(src, 3, None), binding(dst, 4, None), binding(&changed, 5, None)],
        })
    };
    let (ab, ba) = (group(&a, &b), group(&b, &a));
    let mut passes = 0u32;
    loop {
        let mut bytes = vec![0u8; (gpu.stride * BATCH as u64) as usize];
        for k in 0..BATCH {
            let p = PassParams { a: d.width as u32, b: d.depth as u32, c: cells as u32, d: k };
            let at = (gpu.stride * k as u64) as usize;
            bytes[at..at + 16].copy_from_slice(bytemuck::bytes_of(&p));
        }
        gpu.queue.write_buffer(&params, 0, &bytes);
        gpu.queue.write_buffer(&changed, 0, &vec![0u8; BATCH as usize * 4]);
        let mut enc = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        {
            let mut pass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("relax"), timestamp_writes: None });
            pass.set_pipeline(&gpu.relax.pipeline);
            for k in 0..BATCH {
                // Ping-pong: even passes (counting from the first) read a, odd ones b.
                let bind = if (passes + k).is_multiple_of(2) { &ab } else { &ba };
                pass.set_bind_group(0, bind, &[(gpu.stride * k as u64) as u32]);
                pass.dispatch_workgroups(((d.stations * cells) / 64) as u32, 1, 1);
            }
        }
        gpu.queue.submit([enc.finish()]);
        let counts: Vec<u32> = bytemuck::cast_slice(&read_back(gpu, &changed, BATCH as u64 * 4)).to_vec();
        match counts.iter().position(|&c| c == 0) {
            Some(k) => {
                passes += k as u32 + 1;
                break;
            }
            None => passes += BATCH,
        }
        if passes as usize >= cells {
            break;
        }
    }
    // Every pass after the settled one copies the same field, so both buffers hold it.
    let out: Vec<u32> = bytemuck::cast_slice(&read_back(gpu, &a, (field.len() * 4) as u64)).to_vec();
    (out, passes)
}

/// Sorts `keys` (a power of two, at least 128 of them) with the bitonic network on the GPU.
pub fn sort(gpu: &Gpu, keys: &[u32]) -> Vec<u32> {
    let n = keys.len();
    assert!(n.is_power_of_two() && n >= 128, "the GPU sort takes a power of two of at least 128 keys");
    let buf = buffer(gpu, "keys", bytemuck::cast_slice(keys), wgpu::BufferUsages::empty());
    let mut passes: Vec<PassParams> = Vec::new();
    let mut k = 2;
    while k <= n {
        let mut j = k / 2;
        while j > 0 {
            passes.push(PassParams { a: k as u32, b: j as u32, c: 0, d: 0 });
            j /= 2;
        }
        k *= 2;
    }
    let params = uniforms(gpu, "sort parameters", passes.len() as u32);
    let mut bytes = vec![0u8; (gpu.stride * passes.len() as u64) as usize];
    for (i, p) in passes.iter().enumerate() {
        let at = (gpu.stride * i as u64) as usize;
        bytes[at..at + 16].copy_from_slice(bytemuck::bytes_of(p));
    }
    gpu.queue.write_buffer(&params, 0, &bytes);
    let bind = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("sort"),
        layout: &gpu.sort.layout,
        entries: &[binding(&params, 0, Some(16)), binding(&buf, 1, None)],
    });
    let mut enc = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
    {
        let mut pass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("sort"), timestamp_writes: None });
        pass.set_pipeline(&gpu.sort.pipeline);
        for i in 0..passes.len() {
            pass.set_bind_group(0, &bind, &[(gpu.stride * i as u64) as u32]);
            pass.dispatch_workgroups((n / 2 / 64) as u32, 1, 1);
        }
    }
    gpu.queue.submit([enc.finish()]);
    bytemuck::cast_slice(&read_back(gpu, &buf, (n * 4) as u64)).to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;
    use noir_core::config::{parse, validate};
    use noir_core::hash::mix32;
    use noir_core::kernels;

    fn dims() -> Dims {
        validate(&parse(include_str!("../containment.nix")).unwrap()).unwrap().dims
    }

    /// The device, or None when this machine has none; NOIR_REQUIRE_GPU=1 turns its absence into a failure.
    fn device() -> Option<Gpu> {
        match open() {
            Ok(g) => Some(g),
            Err(e) if std::env::var_os("NOIR_REQUIRE_GPU").is_some() => panic!("{e}"),
            Err(e) => {
                eprintln!("SKIPPED (no GPU adapter on this machine: {e}); set NOIR_REQUIRE_GPU=1 to make this a failure");
                None
            }
        }
    }

    /// The kernels' source without comments.
    fn code(src: &str) -> String {
        src.lines().map(|l| l.split("//").next().unwrap_or("")).collect::<Vec<_>>().join("\n")
    }

    #[test]
    fn the_kernels_have_no_branch_in_their_source() {
        for (name, src) in [("swarm", SWARM_WGSL), ("route", ROUTE_WGSL), ("sort", SORT_WGSL)] {
            let code = code(src);
            for word in ["if", "else", "switch", "loop", "while", "break", "continue", "discard"] {
                let found = code.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).any(|w| w == word);
                assert!(!found, "{name}.wgsl uses `{word}`");
            }
            for token in ["&&", "||"] {
                assert!(!code.contains(token), "{name}.wgsl uses `{token}` (it short-circuits: a branch)");
            }
        }
    }

    #[test]
    fn the_kernels_are_valid_wgsl_without_a_device() {
        use wgpu::naga::valid::{Capabilities, ValidationFlags, Validator};
        for (name, src) in [("swarm", SWARM_WGSL), ("route", ROUTE_WGSL), ("sort", SORT_WGSL)] {
            let module = wgpu::naga::front::wgsl::parse_str(src).unwrap_or_else(|e| panic!("{name}.wgsl: {}", e.emit_to_string(src)));
            Validator::new(ValidationFlags::all(), Capabilities::empty())
                .validate(&module)
                .unwrap_or_else(|e| panic!("{name}.wgsl does not validate: {e:?}"));
        }
    }

    #[test]
    fn the_gpu_runs_the_scripted_test_to_the_cpus_last_bit() {
        let Some(g) = device() else { return };
        let d = dims();
        let c = validate(&parse(include_str!("../containment.nix")).unwrap()).unwrap();
        let counts: Vec<u32> = c.roles.iter().map(|r| r.count).collect();
        let caps: Vec<u32> = c.roles.iter().map(|r| r.caps).collect();
        let mut cpu = matrix::new(&d);
        let want = matrix::golden(&d, &counts, &caps, &mut cpu);
        let (got, m) = golden(&g, &d, &counts, &caps);
        assert_eq!(got, want);
        assert_eq!(matrix::fingerprint(&m), matrix::fingerprint(&cpu));
        let mut world = matrix::new(&d);
        matrix::lay_out_world(&d, &mut world);
        let passes = matrix::route(&d, &mut world);
        assert_eq!(route(&g, &d, &world), (world.field.clone(), passes));
        let keys: Vec<u32> = (0..4096u32).map(mix32).collect();
        let mut sorted = keys.clone();
        sorted.sort();
        assert_eq!(sort(&g, &keys), sorted);
    }

    /// Random matrices (every array, the walls and the kernels' knobs drawn at random within what the terminal and
    /// the validator allow) ticked on both: after every batch, every word the same.
    #[test]
    fn random_states_tick_the_same_on_the_gpu_and_the_cpu() {
        let Some(g) = device() else { return };
        for seed in 0..6u32 {
            let mut r = mix32(seed ^ 0xa5a5_5a5a);
            let mut next = move || {
                r = mix32(r.wrapping_add(0x9e37_79b9));
                r
            };
            let mut d = dims();
            d.loop_limit = 2 + next() % 12;
            d.step_eighths = 1 + next() % 8;
            d.learn_shift = 1 + next() % 15;
            d.explore = next() % 65537;
            let mut m = matrix::new(&d);
            matrix::lay_out_world(&d, &mut m);
            let cells = d.width * d.depth;
            for c in 0..cells {
                m.walls[c] |= (next() % 10 == 0) as u32;
            }
            for (s, st) in m.station.iter_mut().enumerate() {
                *st = (cells as u32 / 2 + s as u32 * 7) % cells as u32;
            }
            // Fields of small distances, some zero (docking, learning) and some unreachable.
            for v in m.field.iter_mut() {
                *v = match next() % 8 {
                    0 => 0,
                    1 => INF,
                    _ => next() % 64,
                };
            }
            for i in 0..d.capacity {
                m.px[i] = (next() % (d.width as u32 * 8)) as f32 / 8.0;
                m.pz[i] = (next() % (d.depth as u32 * 8)) as f32 / 8.0;
                m.alive[i] = (next() % 4 != 0) as u32;
                m.doomed[i] = (next() % 16 == 0) as u32;
                m.caps[i] = next() % 32;
                m.req[i] = (next() % 8 == 0) as u32 * (next() % 32);
                m.role[i] = next() % 3;
                m.goal[i] = next();
                m.run[i] = next() % 20;
                m.last[i] = next();
                m.trips[i] = next() % 100;
                m.clock[i] = next() % (1 << 21);
                m.heading[i] = next();
                m.fate[i] = next() % 16;
            }
            for w in m.weights.iter_mut() {
                *w = next() as i32;
            }
            for w in m.memory.iter_mut() {
                *w = next();
            }
            let s = upload(&g, &d, &m, 0);
            let mut gpu_m = matrix::new(&d);
            let mut t = next() % 1000;
            for round in 0..10 {
                // Requests made on agents' behalf (as the terminal's `ask` makes them), on both sides; the first
                // rounds compare after a single tick, so an effect the next tick wipes is still seen.
                for _ in 0..256 {
                    let i = next() as usize % d.capacity;
                    let v = next() % 32;
                    m.req[i] = v;
                    write_word(&g, &s.words, 3 * d.capacity + i, v);
                }
                let n = if round < 6 { 1 } else { 1 + next() % 40 };
                for k in 0..n {
                    kernels::tick(&d, &mut m, t + k);
                }
                ticks(&g, &s, t, n, NONE, NONE);
                t += n;
                download(&g, &s, &mut gpu_m);
                let a = crate::first_difference(&m, &gpu_m);
                assert!(a.is_none(), "seed {seed}, after tick {t}: {}", a.unwrap());
            }
            // The run exercised what it should: drops, flushes, docking.
            let t = tally(&g, &s);
            assert!(t.dropped > 0 && t.flushed > 0 && t.docked > 0, "seed {seed}: {t:?}");
        }
    }
}
