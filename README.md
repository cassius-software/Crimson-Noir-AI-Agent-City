<div align="center">

<img src="brand/marks/crimson-noir-wordmark.svg" alt="Crimson Noir: AI Agent City" width="540" />

# CRIMSON NOIR: AI AGENT CITY
### **The Zero-Trust 3D Civic Operating System, Turing-Complete Console & Sim2Real Sub-Agent Sandbox**

[![Live WebGPU Simulation](https://img.shields.io/badge/Live_Simulation-WebGPU_%2F_Wasm-e11d48?style=for-the-badge)](https://cassius-software.github.io/Crimson-Noir-AI-Agent-City/)
[![Architecture](https://img.shields.io/badge/Architecture-Pure_DOD_%7C_SIMD_%7C_SIMT-0f172a?style=for-the-badge)](#architecture-pure-dod--simd--branchless-math)
[![Containment](https://img.shields.io/badge/ASI_Safety-Ring--0_Airgapped_Wasm-10b981?style=for-the-badge)](#ring-0-asi-containment--zero-trust-guardrails)
[![Content Rating](https://img.shields.io/badge/Rating-14A_Business_Casual-3b82f6?style=for-the-badge)](#14a-business-casual-sandbox--multi-modal-fleet)
[![Platforms](https://img.shields.io/badge/Targets-iOS_%7C_Android_%7C_Windows_%7C_Linux_%7C_macOS_%7C_UEFI-6366f1?style=for-the-badge)](#universal-cross-platform-compilation)

<p align="center">
  <a href="https://cassius-software.github.io/Crimson-Noir-AI-Agent-City/"><strong>Launch Live WebGPU Build</strong></a> ·
  <a href="MANUAL.md"><strong>Operator Manual</strong></a> ·
  <a href="docs/noirscript.md"><strong>NoirScript VM Spec</strong></a> ·
  <a href="docs/zero-trust-sandbox.md"><strong>Ring-0 Containment Audit</strong></a> ·
  <a href="crimson_noir_os/README.md"><strong>Bare-Metal UEFI OS</strong></a>
</p>

![Crimson Noir Cover](docs/cover.jpg)

</div>

---

## Executive Overview

**Crimson Noir: AI Agent City** is a next-generation 3D civic simulation engine, **Real2Sim / Sim2Real** robotics training ground, and spatial **Turing-Complete Console (`NoirScript`)**.

Instead of interacting with autonomous AI agents through a flat terminal window, **Agent City renders the console itself as a living, photorealistic metropolis**. When you issue a high-level directive to **Sloane** (the Root Concierge Orchestrator) or write deterministic **NoirScript** in the terminal, your command decomposes across thousands of sandboxed **Sub-Agents**. Each sub-agent physically navigates the city's transit networks, boards multi-modal vehicles, and enters **16 specialized indoor workplaces** to execute simulated physical and computational tasks.

---

## Key Capabilities

### 1. Ring-0 ASI Containment & Zero-Trust Guardrails
Engineered from the ground up to prevent any current or future Artificial Superintelligence (ASI) from escaping the sandbox:
* **Zero Ambient Authority**: Sub-agents execute inside isolated WebAssembly / `noir_core` lanes with zero access to raw sockets (`fetch`, `WebSocket`, `WebRTC`), host filesystems, or dynamic code evaluation.
* **DeterministicKV-Paging & Gas Metering**: Powered by `native/kv-pager`, every agent reasoning trace and `NoirScript` VM cycle is strictly gas-metered (`4,096 ops/tick`) with bounds-checked linear memory pages.
* **Cryptographic Ring-0 Panic**: Any boundary violation, pointer trap, or unauthorized capability request instantaneously triggers `ring0Panic`, zeroing the agent's Structure-of-Arrays (SoA) lane via bitwise masks and recording an immutable audit hash.
* **Hardware Actuator Clamping**: Real-world robot/drone teleoperation links (`robotLink.ts`, `peripheralPolicy.ts`) enforce hard torque, velocity, and geofence envelopes.

### 2. Pure Data-Oriented Design (DOD), SIMD/SIMT & Branchless Math
* **Zero OOP in Hot Paths**: No `class` hierarchies, no virtual dispatch tables, and zero garbage-collection pauses during simulation ticks.
* **Structure-of-Arrays (SoA)**: All agent kinematics, flow-fields, vehicle suspension states, and lighting clusters reside in contiguous, 64-byte cache-line-aligned `SharedArrayBuffer` typed arrays (`Float32Array`, `Uint32Array`).
* **Hardware Vectorization**: Driven by WGSL `@compute @workgroup_size(64)` shaders (`crowd.wgsl`, `flowField.wgsl`), WebAssembly 128-bit SIMD, and Rust `core::arch` SIMD intrinsics.

### 3. Real2Sim / Sim2Real: 16 Enterable Indoor Tasked Workplaces
Agents don't just wander streets—they enter multi-floor indoor facilities equipped with **URDF-compatible workstations** and **Actuator Reality Shaping** (domain randomization across payload mass $\pm 20\%$, inertia tensors $\pm 30\%$, and static friction):
* Dexterous 7-DOF Robotics & Manipulation Lab
* Automated Fulfillment & Counterbalance Forklift Warehouse
* Tier-4 AI Server Vault & Thermal Cooling Plant
* Lakefront Metro Rail Dispatch & Signal Center
* Air Traffic & Autonomous Drone Swarm Control Tower
* Commercial Culinary & Automated Prep Kitchen
* Precision CNC & Cleanroom Wafer Micro-Fab
* Autonomous Fleet Maintenance & Battery Swap Bay
* *Plus 8 additional specialized civic, biomedical, microgrid, and executive Sanctuary facilities.*

### 4. 14A Business Casual Sandbox: Planes, Trains, Automobiles & Drones
* **Lawful Parked Fleet Everywhere**: Zero hijacking mechanics. Step directly into designated, lawfully parked vehicles across the city or teleoperate them remotely via the console:
  * **Ground**: Executive EV Sedans, Heavy Logistics Trucks, Omnidirectional Warehouse AGVs, Counterbalance Forklifts.
  * **Rail**: Lakefront Metro Articulated Electric Trains.
  * **Aerial**: 6-DOF Quadcopter Inspection Drones, Urban eVTOL Air Taxis, Fixed-Wing STOL Utility Aircraft.
  * **Marine**: Autonomous Lakefront Harbour Ferries.
* **Selective Indestructible Physics**: Powered by a branchless bitwise collision matrix. Players and vehicles physically collide **only** with indestructible world structures and terrain—exhibiting authentic XPBD rigid-body restitution and suspension compression—while phasing harmlessly past pedestrians, other vehicles, and street props. Zero vehicle destruction, zero violence, 100% **14A Business Casual** compliant.

### 5. Photorealistic & Cinematic WebGPU Pipeline
* **Clustered Forward+ & Deferred Lighting**: Real-time culling of up to 4,096 dynamic streetlights, vehicle headlamps, and indoor workplace fixtures with volumetric fog cones.
* **Cook-Torrance GGX PBR**: Perceptual roughness-squared ($\alpha = \text{roughness}^2$) microfacet shading, Ground Truth Ambient Occlusion (GTAO), Screen-Space Reflections (SSR), and 3-cascade PCSS soft shadows.
* **Cinematic Optics**: 180-degree shutter rule motion blur (`1/48s` / `1/120s`), physically based Rayleigh/Mie sky scattering, ACES Filmic tone mapping, 4x MSAA + TAA, and spring-arm camera rigs.

### 6. Default-On Full-Duplex Voice, WCAG AAA Accessibility & Mandatory Console Tutorial
* **Always-Ready Voice HUD**: Full-duplex `AudioWorklet` Voice Activity Detection (VAD) active by default with a 1-tap hardware mute toggle, spatial closed captions, screen-reader ARIA live regions, eye-tracking dwell support, and DualSense Edge / adaptive controller mapping.
* **ELI8 + 5-Whys First-Boot Tutorial**: Mandatory kinetic onboarding that teaches every system by showing rather than telling. The **only** way to graduate from the first-boot tutorial is inside the Turing-complete `NoirScript` Console by executing a live Ring-0 verification and sub-agent swarm deployment script.

---

## Hardware Scalability Matrix

The built-in **Dynamic Frame Governor** (`src/05_Observe_Environment/governor.ts`) automatically adapts compute workgroups, shadow cascades, and KV-pager memory pools across a 20x hardware span:

| Target Tier | Reference Hardware | Render Pipeline | Active SoA Agent Lanes | Local LLM / Swarm Mode |
| :--- | :--- | :--- | :--- | :--- |
| **Lite / Mobile** | Latest iPhone / Ulefone Armor X32 (6–8 GB RAM) | Clustered Forward+ · TAA · 2-Cascade CSM | 4,096 Lanes | In-Page Q4_K_M GGUF (1.7B–3B) / HTN |
| **Desktop Auto** | Core i7 / Ryzen 7 · GTX 1060 / Radeon iGPU (16 GB) | 4x MSAA + TAA · GTAO · SSR · 3-Cascade PCSS | 32,768 Lanes | In-Page GGUF / Local Ollama / Claude Bridge |
| **Peak / Pro** | PS5 Pro Equivalent Linux PC (RDNA 3.5/4 · 60+ TFLOPS) | 4K Clustered Deferred · Ray-Marched GI · Volumetrics | 131,072 Lanes | Multi-Swarm Parallel GGUF + Full Sim2Real |

---

## Repository Architecture

```text
Crimson-Noir-AI-Agent-City/
├── crimson_noir_os/           # Bare-metal UEFI Rust OS kernel & noir_core SIMD/WGSL crates
├── native/
│   ├── kv-pager/              # Deterministic GPU/CPU paged attention memory manager
│   ├── kv-pager-wasm/         # WebAssembly bindings for deterministic KV paging
│   └── routing/               # Branchless SIMD flow-field & pathfinding math crate
├── src-tauri/                 # Tauri v2 cross-platform native shell & DualSense/HID bridge
├── src/
│   ├── 01_Initialize_World/   # Clustered WebGPU device, Lakefront city, 16 indoor workplaces
│   ├── 02_Define_The_Rules/   # Ring-0 ASI airgap, capability gates, 14A selective collision
│   ├── 03_Spawn_Agents/       # SoA crowd compute shaders, procedural humanoids, IK rigs
│   ├── 04_Connect_Hardware/   # URDF parser, Actuator Reality Shaping, DualSense, WebXR, Touch
│   ├── 05_Observe_Environment/# Dynamic Governor, ISA-95 Unified Namespace, deterministic recorder
│   ├── 06_Make_Decisions/     # GGUF/Claude intent router, GPU flow-fields, rail & traffic AI
│   ├── 07_Execute_Actions/    # Planes/trains/automobiles/drones, NoirScript VM, Voice & Tutorial
│   └── 08_Swarm/              # Sub-agent swarm orchestrator & shared memory weights
└── docs/                      # Architecture blueprints, IP audit, & Zero-Trust specifications
```

---

## Quick Start & Universal Cross-Compilation

### 1. Run WebGPU Development Server
```bash
npm install
npm run dev
```

### 2. Run Full Verification Suite (Unit + Property Fuzz + Soak + Rust Crates)
```bash
npm test
cargo test --manifest-path crimson_noir_os/Cargo.toml --workspace
cargo test --manifest-path native/kv-pager/Cargo.toml
cargo test --manifest-path native/routing/Cargo.toml
```

### 3. Build Native Executables (Windows `.exe`, Linux ELF, macOS `.app`, Android/iOS)
```bash
# Desktop Native (Windows / Linux / macOS via Tauri v2 + Clang/LLVM)
npm run tauri build

# Bare-Metal UEFI Bootable Image
./crimson_noir_os/tools/build-image.sh
```

---

## Intellectual Property & Licensing

* **Engine, NoirScript VM, Shaders & Brand Assets**: Copyright © Julian Cassius Subban (Cassius Software). All rights reserved under `LICENSES/LicenseRef-CrimsonNoir-Proprietary.txt` and dual-licensed components as specified in `NOTICE.md`.
* **100% Clean-Room Procedural & CC0 Geometry**: Verified via automated IP audit (`docs/ip-audit.md`) for full commercial distribution.