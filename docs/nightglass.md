# Nightglass: the product's own explicit GPU interface

Nightglass is how the console's apps, its language and its agents draw. It is an explicit, low-level interface: the
caller asks for an adapter and opens a device, allocates memory and binds buffers and images into it, writes shaders
in Nightglass's own binary form (Lens), builds pipelines from them, records command lists, orders work with barriers
and semaphores, submits to a queue and waits on fences. Nothing happens behind the caller's back, and every rule is
checked: a mistake is refused with a `Fault` that names the object and the rule, before any back end sees it.

The implementation is `src/07_Execute_Actions/terminal/nightglass/`. Like the console's other layers it imports
nothing from outside its folder, names no door to the host (nothing asynchronous, no clock, no randomness, no DOM)
and is deterministic; `airgap.test.ts` pins that. Two back ends sit under it:

- **The reference renderer** (`soft.ts`, in the folder): every command run in TypeScript on the host, bit for bit the
  same on every machine. It is what the tests draw with, and it draws for a device whose browser offers no GPU.
- **The GPU back end** (outside the folder, beside the page's own GPU code): the same commands over the browser's
  WebGPU, with Lens lowered to WGSL. The browser job in CI draws the same scenes through both and compares them.

Where this text says less than the implementation had to decide, the decision is marked **pinned** and a test holds it.

## Names and origin

Nightglass, Lens and every identifier in the folder are the product's own. The design follows the general model that
explicit GPU interfaces share (adapters and devices, memory and resources, binding layouts, pipelines, recorded
command lists, barriers, fences and semaphores), written from that model and from the WebGPU and WGSL standards the
GPU back end runs on. No other interface's headers, specification text, identifiers, enumerant values or sample code
were used. The product claims no conformance to, or compatibility with, any other graphics interface.

## Objects (`api.ts`)

| Object | Made by | What it is |
|---|---|---|
| `Instance` | `createInstance({ backends, checks?, report? })` | The entry point; lists every back end's adapters, GPUs first. |
| `Adapter` | `instance.adapters()` | A device that can be opened: its kind, limits, features, memory heaps and kinds, queue groups. |
| `Device` | `instance.open(adapter, { features?, limits?, queues? })` | An opened adapter; creates everything else. |
| `Queue` | `device.queue(group, index)` | Runs submitted command lists in order. One group of one queue (graphics, compute and copy) on both back ends. |
| `Memory` | `device.allocate({ size, kind })` | Bytes of one memory kind. Host-visible kinds are mapped with `map()`. |
| `Buffer`, `Image` | `device.createBuffer/createImage` | Unbacked until `device.bind(resource, memory, offset)`; `device.needs(resource)` says the size, alignment and kinds. |
| `View`, `Sampler` | `device.createView/createSampler` | How a shader sees an image (levels, layers, shape) and filters it. |
| `BindingLayout` | `device.createBindingLayout({ entries })` | The kinds of resource bound at each binding number of a set, and the stages that use them. |
| `PipelineLayout` | `device.createPipelineLayout({ sets, constants? })` | Up to three binding layouts and an inline-constant block. |
| `BindingPool`, `BindingSet` | `device.createBindingPool({ sets })`, `pool.allocate(layout)` | Sets of resources bound together; `set.write([...])` fills them. |
| `Lens` | `device.createLens(words or module)` | A checked shader. |
| `RenderPipeline`, `ComputePipeline` | `device.createRenderPipeline/createComputePipeline` | Every fixed state of a draw or a dispatch. |
| `CommandArena`, `CommandList` | `device.createCommandArena()`, `arena.allocate()` | Recorded work. |
| `Fence`, `Semaphore` | `device.createFence/createSemaphore` | Host-side and device-side completion. |

Every object has a `label`, `destroyed` and `destroy()`; destroying an object that queued work still uses is refused.

### Memory

Four kinds, each on a heap (`adapter.kinds`, `adapter.heaps`):

| Kind | Heap | Holds | Host |
|---|---|---|---|
| `device` | device | any buffer | no |
| `images` | device | images | no |
| `upload` | host | buffers used only as `copy-src` | writes through `map()`, hands them over with `flush(offset, size)` |
| `readback` | host | buffers used only as `copy-dst` | takes the device's writes with `invalidate(offset, size)` after the writing work is done |

Host-visible memory is not coherent (**pinned**): bytes written into `map()` reach the device only at `flush`, and
bytes the device wrote reach `map()` only at `invalidate`. Both back ends keep a device copy and a host copy, so a
forgotten flush or invalidate shows the same stale bytes on every back end. A submission sees every flush made
before it. `needs()` gives an alignment of 256 for buffers with `uniform`, `storage` or `indirect` use and 4
otherwise, and of 256 for images; sizes round up to 4.

### Command lists

States: `initial` -> `begin()` -> `recording` -> `end()` -> `ready` -> submit -> `pending` -> done -> `ready` (or
`invalid` after a `once` list ran, or when an object it used changed or was destroyed). Binding state lasts until the
next `beginPass` or `endPass` (**pinned**): draws bind inside a pass, dispatches outside one, and a pass starts with
the viewport and scissor covering its attachments. Barriers, copies, updates and dispatches are outside passes.

## Ordering

Work on a queue starts in order but may overlap, so a command that reads what an earlier command wrote must say so
with a barrier, as must a command that writes what an earlier one read or wrote, and a change of image layout.
`checks` (on unless the instance turns it off) simulates every submission on the queue's timeline and refuses one
that leaves a hazard (code `hazard`) or uses an image in the wrong layout (code `layout`).

The checker's model (**pinned**):

- It tracks each buffer as a whole and each image by level and layer. For each it keeps the last write (stage and
  access), the stages and accesses that write has been made visible to, the stages that read since, and for an image
  its layout.
- A read at (stage, access) is allowed when there is no unordered write, or the last write was made visible to it.
  A write needs the same of the last write, and every read since must be ordered before its stage.
- A barrier whose `before` covers a write's stage and access makes the write visible to every (stage, access) of its
  `after`; one whose `before` covers a read's stage orders later work in its `after` stages after that read. `all`
  covers every stage; `any-read` and `any-write` cover every read and every write. `top` and `bottom` cover no stage:
  they say "wait for nothing" and "nothing waits".
- An image barrier moves a range from `from` (which must be its layout, or `blank` to throw the contents away) to
  `to`. The move waits for the last write and the reads the barrier's `before` covers, and is itself a write made
  visible to `after`.
- Waiting on a semaphore makes every earlier write visible to every access of the waiting stages. A semaphore must be
  signalled by an earlier submission before one waits on it, and each signal is waited on once.
- Host writes made and flushed before a submission are visible to it. `invalidate()` needs the fence of every
  submission that wrote the range signalled, and those writes made visible to (`host`, `host-read`).
- Inside a pass, draws keep the order of their attachment writes; a resource written by one draw and read by a later
  draw of the same pass is a hazard (a barrier cannot sit in a pass: split it), and an image may not be an attachment
  and be bound for reading in the same pass.

What each command touches:

| Command | Accesses |
|---|---|
| `beginPass` | colour attachments: `color`/`color-write`, and `color-read` when loaded with `keep`; depth: `depth`/`depth-read`, and `depth-write` unless read-only. Layouts `color`, `depth` (or `depth-read` when read-only). |
| draws | vertex buffers `vertex-input`/`vertex-read`; index buffer `vertex-input`/`index-read`; indirect buffer `indirect`/`indirect-read`; each bound binding at each stage its layout entry lists: uniform `uniform-read`, storage-read `shader-read`, storage `shader-read` and `shader-write`, image `shader-read` (layout `shader-read`, `general` or for depth `depth-read`), storage image `shader-write` (layout `general`). |
| dispatches | the bound bindings at `compute`; an indirect buffer at `indirect`. |
| copies, `updateBuffer`, `zeroBuffer` | `copy`/`copy-read` on the source, `copy`/`copy-write` on the destination; image layouts `copy-src` or `general`, and `copy-dst` or `general`. |

## Lens: the shader form (`lens.ts`)

A Lens module is one shader stage with one entry: its workgroup size (compute), its input and output ports, the
resources it declares, and a body of instructions. Values are SSA: each instruction defines at most one id, defined
once and used only after, in its block or a block nested in it. Mutable state lives in variables (`var`, `get`,
`set`). Control flow is structured: `if` and `loop` hold blocks; `break` and `continue` leave the innermost loop;
`return` ends the invocation; `break`, `continue` and `return` end their block.

### Types

`f32`, `i32`, `u32`, `bool`; vectors of 2 to 4 of each (`f32x3`, `boolx2`, ...); and the square grids `m2`, `m3`,
`m4` of f32, stored as columns. Resource blocks hold number types (no `bool`), fixed arrays, a final array without a
length (storage only), and nested blocks; their byte layout is `layoutBlock` (WGSL's host-shareable rules: scalars
align 4, `x2` 8, `x3` and `x4` 16; grids as padded columns; arrays at a stride of their element rounded to its
alignment; in a uniform block, and in the inline constants, arrays need a stride that is a multiple of 16 and a nested
block starts and ends on 16-byte boundaries). An app filling a buffer uses the same function.

### Instructions and their typing

| Op | Operands | Result |
|---|---|---|
| `lit` | components `v` | any value type; f32 components finite and exactly representable; integers in range; bools 0 or 1 |
| `unary` | `neg` (f32, i32), `not` (bool), `bitnot` (i32, u32), `abs` (f32, i32, u32), `sign` (f32, i32), `floor ceil round trunc fract sqrt rsqrt exp exp2 log log2 sin cos tan asin acos atan saturate` (f32) | same type, per component |
| | `length` (f32 scalar or vector) -> f32; `normalize` (f32 vector) -> same; `any`, `all` (bool) -> bool; `transpose` (grid) -> grid | |
| `binary` | `add sub mul div rem` on numbers of one type, or a vector with a scalar of its kind on either side; `add sub` on two grids of one size; `mul` also grid x grid, grid x column vector, row vector x grid, grid x f32 | numbers: same type; grid x vector: vector |
| | `min max` (numbers, one type); `pow atan2 step` (f32, one type; `step(edge, x)`) | same type |
| | `and or xor` (integers or bools, one type); `shl shr` (integer, then u32 of the same width; the count is taken modulo 32; `shr` of i32 is arithmetic) | same type |
| | `eq ne` (one type, any kind); `lt le gt ge` (numbers, one type) | bools of the same width |
| | `land lor` (bools, one type) | same type |
| | `dot` (numeric vectors of one type) -> scalar; `cross` (f32x3) -> f32x3; `distance` (f32, one type) -> f32; `reflect` (f32 vectors) -> same | |
| `ternary` | `mix(a, b, t)` (f32; t of the type or f32); `clamp(x, lo, hi)` (numbers, one type); `smoothstep(lo, hi, x)` (f32, one type); `fma(a, b, c)` (f32, one type); `choose(cond, yes, no)` (cond bool or bools of the value's width; yes and no one type) | same type |
| `make` | scalars and vectors of one kind whose components add up to the width (or one scalar, repeated); a grid from its columns or from its n x n scalars, column by column | the vector or grid |
| `pick` | a vector and 1 to 4 lane numbers | the scalar or vector of those lanes |
| `lane` | a vector and an i32 or u32 value | the lane, the index clamped into the vector (**pinned**) |
| `column` | a grid and a constant index | the column |
| `cast` | a number or bool, or a vector of them | the same width of another kind: f32 to integer truncates toward zero and saturates; i32 and u32 keep their bits; bool to number is 1 or 0; number to bool is "not zero" |
| `bits` | f32, i32 or u32 (or vector) | the same bits as another of the three |
| `in`, `builtin` | a declared input slot; a builtin of the stage | the port's or builtin's type |
| `out`, `position` | a declared output slot and a value of its type; vertex only: an f32x4 clip position | (none) |
| `read`, `write` | a uniform, storage or constants resource and a path of constant field or element indices and value-held element indices (i32 or u32) | the leaf's type; `write` only to a writable storage block, never in the vertex stage |
| `sample` | a float image, a sampler, uv (f32x2), a layer for an array, and an explicit f32 `level`, or none (fragment only: the level from the screen-space rate of change) | f32x4 |
| `texel` | an image, an i32x2 or u32x2 position, a layer for an array, a level | f32x4, u32x4 or i32x4 by the image's kind; f32 for depth; zero outside the image (**pinned**) |
| `put` | a storage image, a position, and a value of its kind's x4 | (none); nothing outside the image; fragment and compute only |
| `extent` | an image (a level for a sampled one) | u32x2 |
| `deriv` | `dx dy width` of an f32 value (fragment only) | same type |
| `var get set` | a variable of a value type (zero unless initialised); reads and writes of it | |
| `if loop break continue discard return` | `if` takes a bool | |

Semantics shared by every back end (**pinned**, and the GPU back end emits code that makes them hold):

- f32 arithmetic rounds to binary32 after each operation; i32 and u32 arithmetic wraps. Integer division by zero
  gives the dividend and the remainder 0; the most negative i32 divided by -1 gives itself (remainder 0). Float `rem`
  is `a - b * trunc(a / b)`. `round` rounds half to even. `fract(x)` is `x - floor(x)`.
- A value-held index into a fixed array is clamped into it; one into a storage block's final array is clamped into
  the elements the binding holds, and with none a read gives zero and a write does nothing.
- `discard` makes the invocation a helper: it runs on (so neighbours' rates of change stay right) but writes nothing,
  and its outputs are dropped.
- A `loop` leaves, as if by `break`, after 65,536 iterations of one entry. The reference renderer also stops a draw
  whose invocations run more than its step budget, with a Fault of code `bound`.
- Implicit-level `sample` and `deriv` sit at the top level of the body, before any instruction that holds a `return`
  (the rate of change is measured across neighbouring pixels, which must all reach it).
- Outputs never written are zero; a vertex whose position is never written draws nothing.
- Transcendental functions are within the GPU's precision; the reference renderer computes them in double precision
  and rounds once.

### The binary form (`binary.ts`)

Little-endian 32-bit words, beginning with `LENS_MAGIC` and `LENS_VERSION`. `encode(module)` and `decode(words)`
are exact inverses for every valid module, and `decode` refuses anything malformed with a Fault of code `lens`
without reading past the words it was given. The word layout is set out in `binary.ts`.

## The reference renderer (`soft.ts`)

It runs every command on the host in submission order, at once (a fence signals when `submit` returns). Its
rasterisation rules (**pinned**; the GPU back end's results are compared against them with a small tolerance):

- Clip space keeps -w <= x <= w, -w <= y <= w and 0 <= z <= w (z unclipped with `depth.unclipped`, its depth then
  clamped). Polygons are clipped against those planes with attributes interpolated in clip space.
- The viewport maps x and y from -1..1 to the viewport (y down), and z from 0..1 to near..far.
- Positions snap to 1/256 of a pixel. A pixel is covered when its centre is inside the triangle, with the top-left
  rule on edges. Four-sample images test coverage at the standard positions (0.375, 0.125), (0.875, 0.375),
  (0.125, 0.625), (0.625, 0.875), shade once per pixel at its centre, and average into the resolve view.
- A triangle faces the viewer when its vertices run counter-clockwise as the image is seen (top row first) and
  `front` is `ccw`, or clockwise and `front` is `cw`. Triangle i of a strip uses vertices i, i+1, i+2 (i+1, i, i+2
  when i is odd); flat values come from its first vertex.
- Attributes are interpolated with perspective correction; depth linearly in screen space. Fragments are shaded in
  2 x 2 quads so `deriv` and implicit-level `sample` can take differences across them (fine differences: within the
  row for x, within the column for y).
- The depth test, then blending (WebGPU's factors and operations; unorm colours clamped to 0..1 before blending),
  then the write mask. Unorm writes round to nearest; sRGB formats encode on write and decode on read.
- Sampling: nearest and linear filters, clamp, repeat and mirror wrapping, mip selection by level with the sampler's
  `mip` filter, levels clamped to lodMin..lodMax and to the view.

## Limits

The reference renderer reports the same limits the GPU back end reports for the WebGPU defaults, so an app that runs
on one runs on the other: images up to 8192 pixels and 256 layers, three binding sets of up to 16 bindings, 256-byte
binding offsets, 8 vertex buffers with 16 attributes, 8 colour attachments, 128 bytes of inline constants, 256
invocations per workgroup, 65,535 workgroups per axis, 256 MiB buffers, and 256-byte copy rows. Lens's own bounds are
`LENS_LIMITS`.

## Not yet

Slice 1 is the core, Lens and the reference renderer. Next: the GPU back end and its browser check (slice 2), then
surfaces (a ring of images per console pane, presented by the host) and the app kit every console app draws its
interface with (slice 3). Cube images, lines and points, stencil, depth bias, timestamps and occlusion queries, workgroup memory
and atomics, and a text form of Lens with a language that compiles to it, come after.
