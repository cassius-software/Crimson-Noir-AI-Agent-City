//! Why does this file exist? It is the declarative configuration's generator for the hosted runtime: it reads
//! `containment.nix`, refuses it unless it obeys the system's rules and matches the digest pinned in
//! `containment.lock`, runs the self-test's scripted swarm on the build machine, and writes the locked tables
//! (`$OUT_DIR/locked.rs`) the runtime is compiled with. A refused configuration fails the build with the reason (and,
//! for a changed file, the digest to pin once the change is reviewed).
//! What breaks if it is removed? The runtime has no declared bounds to run under.
use std::{env, fs, path::Path};

fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let (nix_path, lock_path) = (root.join("containment.nix"), root.join("containment.lock"));
    println!("cargo:rerun-if-changed={}", nix_path.display());
    println!("cargo:rerun-if-changed={}", lock_path.display());
    let nix = fs::read_to_string(&nix_path).expect("containment.nix is missing");
    let lock = fs::read_to_string(&lock_path).unwrap_or_default();
    match noir_core::generate(&nix, &lock) {
        Ok(src) => fs::write(Path::new(&env::var("OUT_DIR").unwrap()).join("locked.rs"), src).unwrap(),
        Err(e) => panic!("\n\n{e}\n\n"),
    }
}
