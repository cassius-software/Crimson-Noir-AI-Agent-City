//! Why does this file exist? It is the declarative configuration's generator for the bootable image, and its dependency
//! lock: it locks `containment.nix` against `containment.lock` and runs the self-test's scripted swarm on the build
//! machine (noir_core::generate, as the hosted runtime's build does), writing the tables the image boots with; and it
//! walks Cargo.lock from this crate and refuses the build if the image would link any crate the configuration's
//! `dependencies` list does not name.
//! What breaks if it is removed? The image has no declared bounds, and an undeclared crate could slip into it.
use std::collections::BTreeSet;
use std::{env, fs, path::Path};

/// The crates Cargo.lock says `root` depends on, transitively (names only; the lock lists every kind of dependency).
fn closure(lock: &str, root: &str) -> BTreeSet<String> {
    let mut deps: Vec<(String, Vec<String>)> = Vec::new();
    for block in lock.split("[[package]]").skip(1) {
        let name = block.lines().find_map(|l| l.strip_prefix("name = \"")).map(|n| n.trim_end_matches('"').to_string());
        let mut list = Vec::new();
        if let Some(start) = block.find("dependencies = [") {
            for l in block[start..].lines().skip(1) {
                let l = l.trim();
                if l == "]" {
                    break;
                }
                let dep = l.trim_matches(|c| c == '"' || c == ',');
                list.push(dep.split(' ').next().unwrap_or(dep).to_string());
            }
        }
        if let Some(name) = name {
            deps.push((name, list));
        }
    }
    let mut seen = BTreeSet::from([root.to_string()]);
    let mut todo = vec![root.to_string()];
    while let Some(n) = todo.pop() {
        for (name, list) in &deps {
            if *name == n {
                for d in list {
                    if seen.insert(d.clone()) {
                        todo.push(d.clone());
                    }
                }
            }
        }
    }
    seen
}

fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let (nix_path, lock_path, cargo_lock) = (root.join("containment.nix"), root.join("containment.lock"), root.join("Cargo.lock"));
    for p in [&nix_path, &lock_path, &cargo_lock] {
        println!("cargo:rerun-if-changed={}", p.display());
    }
    let nix = fs::read_to_string(&nix_path).expect("containment.nix is missing");
    let lock = fs::read_to_string(&lock_path).unwrap_or_default();
    let src = match noir_core::generate(&nix, &lock) {
        Ok(src) => src,
        Err(e) => panic!("\n\n{e}\n\n"),
    };
    let declared = noir_core::config::validate(&noir_core::config::parse(&nix).unwrap()).unwrap().dependencies;
    let linked = closure(&fs::read_to_string(&cargo_lock).expect("Cargo.lock is missing"), env!("CARGO_PKG_NAME"));
    let undeclared: Vec<&String> = linked.iter().filter(|c| !declared.contains(c)).collect();
    if !undeclared.is_empty() {
        panic!("\n\nthe bootable image would link crates containment.nix does not declare: {undeclared:?}\n\n");
    }
    fs::write(Path::new(&env::var("OUT_DIR").unwrap()).join("locked.rs"), src).unwrap();
}
