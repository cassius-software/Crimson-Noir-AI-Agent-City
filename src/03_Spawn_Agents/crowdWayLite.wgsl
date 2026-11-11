// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
// Why does this file exist? It is the light kernel's way for someone asked over: the same two functions as
// crowdWay.wgsl (roomWay, lastStretch), each a straight line. crowdCompute.ts appends it to crowd.wgsl in place of
// crowdWay.wgsl when a GPU's own shader compiler refused the full simulate kernel (crowdSim.ts), so that phone has a
// crowd, its First-Law sensing, its containment and its no-harm contact unchanged (all of crowd.wgsl), and only the
// way across a room and round a lot is simpler: across a room, straight at the spot off the furniture nearest the
// operator (offFurniture) while that line is clear, else round the first piece in its way by whichever of its corners
// makes the shorter walk (the operator's trail and the room's aisles are the full kernel's); on the street, the flow
// field's arrow until the last stretch, then the straight line to the spot off the lot (offLot). Nobody walks through
// a wall or a table here either: the containment is crowd.wgsl's.
// What breaks if it is removed? A GPU that refuses the full kernel has no lighter one to run, and shows the card.

// Straight at the spot off room r's furniture nearest `to` (offFurniture) while that line is clear of every piece by
// the containment's reach; else round the first piece in its way, by whichever of the piece's corners (ROOM_ROUND
// beyond its grown corner, as the full kernel's) in sight from here makes the shorter two-leg walk. The containment
// refuses a step square into a face whole (the slide keeps only the part along the face), so the straight line alone
// would hold someone across a table from the operator on it for good. The operator's trail and the room's aisles are
// the full kernel's; `follow` and `there` are its.
fn roomWay(r: u32, me: vec2f, to: vec2f, follow: bool, there: bool) -> vec2f {
  let held = ROOM_PAD - 1e-3;
  let goal = offFurniture(r, to);
  let n = min(u32(P.rooms[r].b.y), ROOM_FURNITURE);
  for (var k = 0u; k < n; k++) {
    let box = P.rooms[r].furniture[k];
    let lo = box.xy - held;
    let hi = box.zw + held;
    if (!hitsBox(me, goal - me, lo, hi)) { continue; }
    var best = 1e9;
    var aim = goal;
    for (var c = 0u; c < 4u; c++) {
      let q = select(box.xy - (ROOM_PAD + ROOM_ROUND), box.zw + (ROOM_PAD + ROOM_ROUND), vec2<bool>((c & 1u) != 0u, (c & 2u) != 0u));
      let cost = distance(me, q) + distance(q, goal);
      if (cost < best && distance(me, q) > 0.05 && !hitsBox(me, q - me, lo, hi)) {
        best = cost;
        aim = q;
      }
    }
    return dirTo(me, aim);
  }
  return dirTo(me, goal);
}
// The last stretch of a summons on the street: within four talking distances the straight line to the spot off the
// operator's lot, easing to a stop on it (arriveAt); farther, the flow field's arrow where it has one (one cell off a
// room's glass where the cell under them is silent), the straight line where it has none.
fn lastStretch(me: vec2f, at: vec2f, dist: f32, flow0: vec2f) -> vec2f {
  var flow = flow0;
  let goal = offLot(at);
  let onto = select(goal, pushOut(at, ROOM_PAD - 0.25), roomOf(at) < 0);
  if (dist <= 4.0 * SUMMON_STOP) { return arriveAt(me, onto); }
  if (dot(flow, flow) <= 0.5) {
    let here = roomOf(me);
    if (here >= 0) { flow = flowAt(me + offGlass(u32(here), me) / FLOW_INV_CELL); }
  }
  return select(arriveAt(me, onto), flow, dot(flow, flow) > 0.5);
}
