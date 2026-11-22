/*
 * Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
 * SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
 * Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
 * Why does this file exist? The riscv64 image is linked as a bare-metal program and written out flat as a UEFI
 * application (boot/src/arch/riscv64.rs says why). This script lays that file out: the PE header first, at address 0,
 * so every offset in the file is its address in memory; then the code on a 4096-byte boundary; then everything else
 * (read-only data, the relocation table the entry walks, data, and the zeroed part last and outside the file) in one
 * writable stretch, because every address the entry rewrites lies there. Its symbols give the header its sizes.
 * What breaks if it is removed? The riscv64 image does not link, or links to a file no firmware would load.
 */
OUTPUT_ARCH(riscv)
ENTRY(_entry)
SECTIONS
{
  . = 0;
  ImageBase = .;
  .head : { KEEP(*(.head)) }
  . = ALIGN(0x1000);
  _text = .;
  .text : { *(.text.entry) *(.text .text.*) }
  . = ALIGN(0x1000);
  _etext = .;
  _data = .;
  .rodata : { *(.rodata .rodata.*) *(.srodata .srodata.*) }
  .data.rel.ro : { *(.data.rel.ro .data.rel.ro.*) }
  .got : { *(.got .got.*) }
  .dynamic : { *(.dynamic) }
  .dynsym : { *(.dynsym) }
  .dynstr : { *(.dynstr) }
  .hash : { *(.hash) }
  .gnu.hash : { *(.gnu.hash) }
  . = ALIGN(8);
  .rela.dyn : { __rela_start = .; *(.rela .rela.*) __rela_end = .; }
  .data : { *(.data .data.*) *(.sdata .sdata.*) . = ALIGN(0x1000); }
  _edata = .;
  .bss (NOLOAD) : { *(.sbss .sbss.*) *(.bss .bss.*) *(COMMON) . = ALIGN(0x1000); }
  _end = .;
  _pe_text_rva = ABSOLUTE(_text);
  _pe_text_size = ABSOLUTE(_etext - _text);
  _pe_data_rva = ABSOLUTE(_data);
  _pe_data_fsize = ABSOLUTE(_edata - _data);
  _pe_data_vsize = ABSOLUTE(_end - _data);
  _pe_image_size = ABSOLUTE(_end);
  _pe_entry_rva = ABSOLUTE(_entry);
  /DISCARD/ : { *(.comment) *(.eh_frame) *(.eh_frame_hdr) *(.riscv.attributes) *(.note .note.*) }
}
