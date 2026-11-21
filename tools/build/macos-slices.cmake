# Copyright (c) 2026 Julian Cassius Subban
# SPDX-License-Identifier: MIT
# Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
# Why does this file exist? The macOS app is one universal binary: Tauri builds it as two cargo builds, one per slice
# (aarch64-apple-darwin, then x86_64-apple-darwin, on an Apple silicon runner), and joins them with lipo. Each build
# compiles llama.cpp through llama-cpp-sys-2, which hands every GGML_* and CMAKE_* variable of the environment to
# CMake as it is (its build.rs) and reads no variable per target, so an environment setting reaches both slices
# alike. The two slices want different things: Apple silicon runs the model on its GPU through Metal (ggml's default
# on Apple), while the Intel slice runs it on the processor alone and is cross-compiled, so ggml's defaults turn its
# x86 instruction sets off (CMAKE_CROSSCOMPILING). tools/build/matrix.mjs names this file in CMAKE_PROJECT_ggml_INCLUDE,
# which llama-cpp-sys-2 passes to CMake for both slices; CMake reads it right after ggml's own project() call, before
# ggml declares its options, and it acts only where the slice is x86_64 (CMAKE_OSX_ARCHITECTURES, which the cmake
# crate sets per slice), so nothing here reaches the arm64 slice:
#   - GGML_METAL off: no Metal device is created and no shader library compiled when the backend starts, which a
#     plan with no GPU layers does not prevent (native/llm engine.rs Gpu);
#   - SSE4.2, AVX, AVX2, FMA, F16C and BMI2 on, the instruction sets a Linux x86-64 build gets by default, so the
#     Intel slice is not left on baseline SSE; the runner refuses a processor without them before llama.cpp starts
#     (native/llm guard.rs), with a plain sentence.
# FORCE, so a CMake cache kept from an earlier build cannot hold other values. tools/build/macAudit.mjs `slices` reads
# both slices' build output and binary afterwards: Metal and no x86 flags in arm64, no Metal and these flags in x86_64.
# What breaks if it is removed? The Intel slice starts Metal it never uses and runs the model on baseline SSE code.
if(APPLE AND CMAKE_OSX_ARCHITECTURES STREQUAL "x86_64")
  set(GGML_METAL OFF CACHE BOOL "ggml: use Metal (off: the Intel slice runs on the processor alone)" FORCE)
  foreach(option GGML_SSE42 GGML_AVX GGML_AVX2 GGML_FMA GGML_F16C GGML_BMI2)
    set(${option} ON CACHE BOOL "ggml: an x86 instruction set the runner's guard checks for" FORCE)
  endforeach()
  message(STATUS "crimson-noir macos-slices: x86_64: Metal off; SSE4.2, AVX, AVX2, FMA, F16C and BMI2 on")
elseif(APPLE)
  message(STATUS "crimson-noir macos-slices: ${CMAKE_OSX_ARCHITECTURES}: ggml's own defaults (Metal on)")
endif()
