# Crimson Noir OS: the declarative containment configuration (generation 0).
#
# Everything the system may hold is declared here and locked at compile time. The build scripts parse this file
# (a strict subset of the Nix language: sets, dotted paths, lists, strings, whole numbers, booleans, comments),
# refuse anything outside the system's rules, check the SHA-256 of its canonical form against containment.lock,
# and compile the result into the image as constant tables. Nothing here can be switched at runtime: a change is
# a rebuild with a new lock (a changed file fails the build and prints the digest to pin once reviewed).
{
  system = {
    name = "crimson-noir";
    version = "0.9.0";
    tickHz = 60;
    seed = 1337;            # the spawn layout and the self-test's run are derived from it
  };

  # The Global Matrix: one row per agent slot, in flat 1-D arrays.
  pool = {
    capacity = 4096;        # agent slots, a power of two
    blockWords = 64;        # each agent's private memory block, in 32-bit words (a power of two)
  };

  # The floor the swarm routes on, in cells, and its docking stations (one learned weight per station per agent).
  world = {
    width = 64;
    depth = 64;
    stations = 8;
  };

  # Everything the system may allocate. The bootable image takes exactly this much from the firmware, carves the
  # declared layout out of it and seals its allocator: any allocation after boot is a fault.
  memory = {
    arenaBytes = 16777216;  # 16 MiB
  };

  containment = {
    loopLimit = 100;        # identical failure states in a row before an index is flushed and zeroed
    network = false;        # the air gap: there is no network capability; true is refused
  };

  # The compute kernels' parameters (the same values drive the CPU kernels and the WGSL shaders).
  kernels = {
    stepEighths = 1;        # cells moved per tick, in eighths of a cell
    learnShift = 3;         # learning rate 1/2^3
    explore = 2048;         # exploration noise on a station's learned weight (Q16.16)
  };

  # The tutorial's render target, in pixels, and the most triangles its scene may hold.
  display = {
    width = 640;
    height = 360;
    triangles = 16384;
  };

  # The terminal: dictionary cells, stack depth, the steps one command line may take, scrollback lines.
  terminal = {
    cells = 16384;
    stack = 256;
    stepBudget = 5000000;
    lines = 256;
  };

  # The roles an agent may be spawned as, how many of each, and the only privileges each holds.
  roles = {
    courier = { count = 3072; caps = [ "move" "route" "learn" "memory" ]; };
    sentry = { count = 1023; caps = [ "move" "memory" ]; };
    tutor = { count = 1; caps = [ "move" "route" "memory" ]; };
  };

  # The crates the bootable image may link, and nothing else (the boot build checks Cargo.lock against this list).
  dependencies = [ "crimson_boot" "noir_core" "font8x8" "log" ];
}
