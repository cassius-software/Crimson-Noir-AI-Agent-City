//! Why does this file exist? Placeholder entry of the hosted runtime while the core comes up.
//! What breaks if it is removed? The package has no binary.
#[allow(dead_code)]
mod locked {
    include!(concat!(env!("OUT_DIR"), "/locked.rs"));
}

fn main() {
    println!("{} {} (containment {})", locked::NAME, locked::VERSION, locked::DIGEST);
}
