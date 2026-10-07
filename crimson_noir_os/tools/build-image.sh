#!/bin/sh
# Why does this file exist? It makes the one-click bootable media of Crimson Noir OS from the UEFI image: a raw GPT disk
# image (an EFI system partition holding \EFI\BOOT\BOOTX64.EFI, the declared configuration and the notices) to write to a
# USB stick or boot in a virtual machine, and a UEFI-bootable ISO (El Torito, hybrid). Tools: cargo with the
# x86_64-unknown-uefi target, mtools, sgdisk (gdisk) and xorriso.
# What breaks if it is removed? The image is built but nothing can boot it.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-"$here/target/image"}
cd "$here"
cargo build -q --locked -p crimson_boot --target x86_64-unknown-uefi --release
efi="$here/target/x86_64-unknown-uefi/release/crimson_boot.efi"
mkdir -p "$out"
esp="$out/esp.img"
rm -f "$esp" "$out/crimson_noir_os.img" "$out/crimson_noir_os.iso"
# The EFI system partition: FAT, 34 MiB.
dd if=/dev/zero of="$esp" bs=1M count=34 status=none
mformat -i "$esp" -F -v CRIMSONNOIR ::
mmd -i "$esp" ::/EFI ::/EFI/BOOT
mcopy -i "$esp" "$efi" ::/EFI/BOOT/BOOTX64.EFI
mcopy -i "$esp" "$here/containment.nix" "$here/containment.lock" ::/
mcopy -i "$esp" "$here/NOTICE.txt" ::/NOTICE.TXT
# The disk: a GPT with the ESP as its one partition (sectors 2048 onward).
disk="$out/crimson_noir_os.img"
dd if=/dev/zero of="$disk" bs=1M count=36 status=none
sgdisk -o -n 1:2048:+34M -t 1:ef00 -c 1:"CRIMSON NOIR OS" "$disk" > /dev/null
dd if="$esp" of="$disk" bs=512 seek=2048 conv=notrunc status=none
# The ISO: the ESP as its El Torito EFI boot image; hybrid, so it also boots written to a stick.
iso_root="$out/iso"
rm -rf "$iso_root"
mkdir -p "$iso_root"
cp "$esp" "$iso_root/efiboot.img"
cp "$here/containment.nix" "$here/NOTICE.txt" "$iso_root/"
xorriso -as mkisofs -quiet -R -J -V CRIMSON_NOIR -e efiboot.img -no-emul-boot -isohybrid-gpt-basdat \
  -o "$out/crimson_noir_os.iso" "$iso_root"
sha256sum "$efi" "$disk" "$out/crimson_noir_os.iso" | sed "s|$here/||"
sgdisk -v "$disk" | grep -q "No problems found" || { echo "the disk image's GPT is not valid" >&2; exit 1; }
