// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
// Why does this file exist? It is the light kernel's way for someone asked over: the same two functions as
// crowdWay.wgsl (roomWay, lastStretch), each a straight line. crowdCompute.ts appends it to crowd.wgsl in place of
// crowdWay.wgsl when a GPU's own shader compiler refused the full simulate kernel (crowdSim.ts), so that phone has a
// crowd, its First-Law sensing, its containment and its no-harm contact unchanged (all of crowd.wgsl), and only the
// way across a room and round a lot is simpler: across a room, straight at the spot off the furniture nearest the
// operator (offFurniture), the containment sliding the step along whatever stands in the way; on the street, the
// flow field's arrow until the last stretch, then the straight line to the spot off the lot (offLot). Nobody walks
// through a wall or a table here either: the containment is crowd.wgsl's.
// What breaks if it is removed? A GPU that refuses the full kernel has no lighter one to run, and shows the card.

// Straight at the spot off room r's furniture nearest `to` (the trail and the room's corners are the full kernel's).
fn roomWay(r: u32, me: vec2f, to: vec2f, follow: bool, there: bool) -> vec2f {
  return dirTo(me, offFurniture(r, to));
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
