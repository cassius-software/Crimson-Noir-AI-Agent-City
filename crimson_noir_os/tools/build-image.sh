#!/bin/sh
# Why does this file exist? It makes the one-click bootable media of Crimson Noir OS from the UEFI image: a raw GPT disk
# image (an EFI system partition holding \EFI\BOOT\BOOTX64.EFI, the declared configuration and the notices) to write to a
# USB stick or boot in a virtual machine, and a UEFI-bootable ISO (El Torito, hybrid). Tools: cargo with the
# x86_64-unknown-uefi target, mtools, sgdisk (gdisk) and xorriso.
# The media are reproducible: the same commit gives the same bytes on any machine, so two release tags at one commit
# publish one set of checksums and anyone can rebuild and compare. Everything that would otherwise vary is fixed by the
# commit: every timestamp is its commit time (SOURCE_DATE_EPOCH, which mtools and xorriso honour), and the GPT's GUIDs
# and the FAT volume's serial number come from its hash. Outside git, set SOURCE_DATE_EPOCH (and optionally
# CRIMSON_MEDIA_ID) yourself.
# What breaks if it is removed? The image is built but nothing can boot it.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-"$here/target/image"}
cd "$here"
cargo build -q --locked -p crimson_boot --target x86_64-unknown-uefi --release
efi="$here/target/x86_64-unknown-uefi/release/crimson_boot.efi"

# What fixes every varying byte: the commit's time, and its hash as the media's identity.
SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct 2>/dev/null || echo 0)}
id=${CRIMSON_MEDIA_ID:-$(git rev-parse HEAD 2>/dev/null || echo "$SOURCE_DATE_EPOCH")}
export SOURCE_DATE_EPOCH
hex=$(printf '%s' "crimson-noir-media:$id" | sha256sum | cut -c1-64)
guid() { echo "$1" | sed 's/^\(.\{8\}\)\(.\{4\}\)\(.\{4\}\)\(.\{4\}\)\(.\{12\}\).*/\1-\2-\3-\4-\5/'; }
disk_guid=$(guid "$(echo "$hex" | cut -c1-32)")
part_guid=$(guid "$(echo "$hex" | cut -c33-64)")
serial=$(echo "$hex" | cut -c1-8)

mkdir -p "$out"
esp="$out/esp.img"
rm -f "$esp" "$out/crimson_noir_os.img" "$out/crimson_noir_os.iso"
# The files that go on the media, stamped with the commit's time (mcopy -m keeps a file's time).
stage="$out/stage"
rm -rf "$stage"
mkdir -p "$stage"
cp "$efi" "$stage/BOOTX64.EFI"
cp "$here/containment.nix" "$here/containment.lock" "$stage/"
cp "$here/NOTICE.txt" "$stage/NOTICE.TXT"
touch -d "@$SOURCE_DATE_EPOCH" "$stage"/*
# The EFI system partition: FAT, 34 MiB.
dd if=/dev/zero of="$esp" bs=1M count=34 status=none
mformat -i "$esp" -F -v CRIMSONNOIR -N "$serial" ::
mmd -i "$esp" ::/EFI ::/EFI/BOOT
mcopy -m -i "$esp" "$stage/BOOTX64.EFI" ::/EFI/BOOT/BOOTX64.EFI
mcopy -m -i "$esp" "$stage/containment.nix" "$stage/containment.lock" ::/
mcopy -m -i "$esp" "$stage/NOTICE.TXT" ::/NOTICE.TXT
# The disk: a GPT with the ESP as its one partition (sectors 2048 onward), under the commit's GUIDs.
disk="$out/crimson_noir_os.img"
dd if=/dev/zero of="$disk" bs=1M count=36 status=none
sgdisk -o -U "$disk_guid" -n 1:2048:+34M -t 1:ef00 -c 1:"CRIMSON NOIR OS" -u 1:"$part_guid" "$disk" > /dev/null
dd if="$esp" of="$disk" bs=512 seek=2048 conv=notrunc status=none
# The ISO: the ESP as its El Torito EFI boot image; hybrid, so it also boots written to a stick.
iso_root="$out/iso"
rm -rf "$iso_root"
mkdir -p "$iso_root"
cp "$esp" "$iso_root/efiboot.img"
cp "$here/containment.nix" "$here/NOTICE.txt" "$iso_root/"
touch -d "@$SOURCE_DATE_EPOCH" "$iso_root"/* "$iso_root"
xorriso -as mkisofs -quiet -R -J -V CRIMSON_NOIR -e efiboot.img -no-emul-boot -isohybrid-gpt-basdat \
  -o "$out/crimson_noir_os.iso" "$iso_root"
rm -rf "$stage"
sha256sum "$efi" "$disk" "$out/crimson_noir_os.iso" | sed "s|$here/||"
sgdisk -v "$disk" | grep -q "No problems found" || { echo "the disk image's GPT is not valid" >&2; exit 1; }
