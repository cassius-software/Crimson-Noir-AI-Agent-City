// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
// Why does this file exist? It is the full kernel's way for someone asked over: across a room round its furniture
// and along the operator's own trail (roomWay), and the last stretch on the street round the buildings' lots and a
// room's glass (lastStretch). crowd.wgsl calls both from summonWay; crowdCompute.ts appends this file to it for the
// full kernel and crowdWayLite.wgsl, which defines the same two functions in a few lines, for the light one. The
// light kernel exists because this file is where the simulate pass grows past what some phones' shader compilers
// take: these two functions inline a dozen loops of loops (the trail's sixteen points against every piece of
// furniture and every pane of glass, four corners a piece, four corners a lot), and a GPU whose driver refuses the
// full simulate kernel (crowdSim.ts: the browser reports it as an internal error, not a validation one) is given the
// light kernel instead of no city. Everything a car's First-Law sensing, the containment and the no-harm contact
// need stays in crowd.wgsl, the same in both kernels.
// What breaks if it is removed? Someone asked over across a room walks straight at the operator and is held on
// the first table in the way, and on the street is slid along a lot's face short of its corner.

// Whether the line from a to b keeps clear of room r's furniture, each box grown by `pad`. A line along a grown face,
// or leaving it, is clear: someone the containment holds on a face can walk off it.
fn clearOfFurniture(r: u32, a: vec2f, b: vec2f, pad: f32) -> bool {
  let n = min(u32(P.rooms[r].b.y), ROOM_FURNITURE);
  for (var k = 0u; k < n; k++) {
    let box = P.rooms[r].furniture[k];
    if (hitsBox(a, b - a, box.xy - pad, box.zw + pad)) { return false; }
  }
  return true;
}
// Point k of the operator's trail (newest first), as someone asked over across room r makes for it (offFurniture).
fn trailSpot(r: u32, k: u32) -> vec2f {
  let row = P.trail[k / 2u];
  return offFurniture(r, select(row.xy, row.zw, (k & 1u) != 0u));
}
// The way across room r from me to `to` round its furniture: the straight line to it (offFurniture's spot for it) when
// that is clear of every piece by the containment's reach (`held`: a line inside it, such as one along a piece's side
// on from a gap's mouth, is one the containment refuses every step of). Else, for someone coming to the operator
// (`follow`), the operator's own way: the newest point of their trail in such a line with no glass between, or once level with it the one after it where no piece stands
// between (the operator walked from one to the next, round whatever corner hides it), which leads into a dead end and
// round the end of a long piece where no one corner opens, and out of a room the operator has left. Only the part of
// the trail the crowd can walk serves: from each point to the one after it, and on to `to` when the operator is there
// (`there`), the line passes through no piece and no glass. The operator steps over an AGV dock; the containment
// holds everyone off it, so a trail over one would pin them on its face. A line cutting a piece's grown corner is no
// gap: the operator's body goes round the corner on an arc, and the containment slides the crowd round it too. Else by the corner of a piece (ROOM_ROUND beyond
// its grown corner, on the floor and clear of the other pieces) that makes the shortest clear two-leg walk, and on the
// corner or along its leg on from there, straight on where that line is clear at `clear` too: the legs are tested at
// `clear`, so the straight line refused at `held` from there would hold them on the corner for good, while near a
// 1 m gap in a row of tables a line from beside the leg can run into the next table's end; with none, out along the
// nearer aisle towards the hub, from where one may open. The crowd's flow field cannot do this: its 2 m cells run straight through a conveyor or a
// rack 0.8 m deep.
fn roomWay(r: u32, me: vec2f, to: vec2f, follow: bool, there: bool) -> vec2f {
  let clear = ROOM_PAD - 0.05;
  let held = ROOM_PAD - 1e-3;
  let goal = offFurniture(r, to);
  if (clearOfFurniture(r, me, goal, held)) { return dirTo(me, goal); }
  if (follow) {
    var next = goal;
    for (var k = 0u; k < min(P.trailCount, TRAIL_POINTS); k++) {
      let t = trailSpot(r, k);
      if ((k > 0u || there) && (!clearOfFurniture(r, t, next, 0.0) || walled(t, next))) { break; }
      if (clearOfFurniture(r, me, t, held) && !walled(me, t)) {
        let on = distance(me, next) <= distance(t, next) && clearOfFurniture(r, me, next, 0.0) && !walled(me, next);
        return dirTo(me, select(t, next, on));
      }
      next = t;
    }
  }
  let n = min(u32(P.rooms[r].b.y), ROOM_FURNITURE);
  let reach = CITY_LOT_HALF - ROOM_WALL - ROOM_PAD;
  var best = 1e9;
  var aim = roomWorld(r, vec2f(P.rooms[r].b.x, select(-ROOM_AISLE, ROOM_AISLE, roomLocal(r, me).y >= 0.0)));
  for (var k = 0u; k < n; k++) {
    let box = P.rooms[r].furniture[k];
    for (var c = 0u; c < 4u; c++) {
      let q = select(box.xy - (ROOM_PAD + ROOM_ROUND), box.zw + (ROOM_PAD + ROOM_ROUND), vec2<bool>((c & 1u) != 0u, (c & 2u) != 0u));
      let l = roomLocal(r, q);
      let cost = distance(me, q) + distance(q, goal);
      if (max(abs(l.x), abs(l.y)) >= reach || cost >= best) { continue; }
      if (!clearOfFurniture(r, q, q, ROOM_PAD) || !clearOfFurniture(r, me, q, clear) || !clearOfFurniture(r, q, goal, clear)) { continue; }
      best = cost;
      aim = q;
    }
  }
  let leg = goal - aim;
  let along = clamp(dot(me - aim, leg) / max(dot(leg, leg), 1e-6), 0.0, 1.0);
  if (best < 1e9 && distance(me, aim + leg * along) < ROOM_ROUND && clearOfFurniture(r, me, goal, clear)) { return dirTo(me, goal); }
  return dirTo(me, aim);
}
// Whether the segment from a to b cuts the containment of the lot p stands by: a building's lot square, or a room's
// glass, grown by `pad`.
fn lotCut(p: vec2f, a: vec2f, b: vec2f, pad: f32) -> bool {
  let r = roomOf(p);
  if (r >= 0) { return crossesGlass(u32(r), a, b, pad); }
  let c = lotCenter(p);
  return hitsBox(a, b - a, c - (CITY_LOT_HALF + pad), c + (CITY_LOT_HALF + pad));
}
// The last stretch of a summons on the street, for someone at `me` with no glass of the operator's room between them and
// `at`, `dist` away, the flow field's arrow under their feet `flow0` (zero where it is silent). The whole way round the
// buildings is here (the light kernel, crowdWayLite.wgsl, has none of it).
// The last stretch is the straight line to the operator (offLot's spot for them) only where it cuts no lot's
// containment (the pad less a millimetre: walking along a face someone is held on is no cut), so nobody is slid
// along a face until they stand level with the operator short of its corner. A doorway's jamb in the way (one of
// them in the opening's band, the other outside beside it) is gone round by its outer corner, just off the opening,
// where the field's 2 m cells see nothing to go round. A lot with no room in it is gone round by the corner of its
// square, just off it: the field walks across a park, and round a building standing back from its lot's edge, where
// the containment holds everyone out of the whole square, so its arrow would pin them on the square's face. First,
// though, the spot on their own face nearest an operator inside the lot, where that is within talking reach; and
// only a corner within the last stretch of the operator (walking to one further would take them past the stretch's
// edge, where the arrow turns them back) or with the operator in talking reach of the lot's edge. While the arrow
// would take them into the square of the lot they and the operator are by, or the operator stands in that square and
// the straight line to the spot on its face is clear, this way holds at any distance: where a building stands back
// from its lot's edge the field enters the square beside it, so along the face its arrow runs back the way they came,
// and arrow and line would trade every few frames.
// Anything else by the field's arrow, one cell off the glass where the cell under them is silent. Coming onto a lot's
// face they walk for a spot a quarter metre past it (`onto`), so they come right onto it at the last stretch's pace
// and the containment holds them there: easing to a stop on the face itself, they would stand a few millimetres
// short where a step at 120 frames a second is less than a 32-bit float's spacing, out of talking reach of an
// operator 1.15 m into a park.
fn lastStretch(me: vec2f, at: vec2f, dist: f32, flow0: vec2f) -> vec2f {
  var flow = flow0;
  let goal = offLot(at);
  let onto = select(goal, pushOut(at, ROOM_PAD - 0.25), roomOf(at) < 0);
  let pad = ROOM_PAD - 1e-3;
  let inward = dot(flow, flow) > 0.5 && roomOf(me) < 0 && all(abs(lotCenter(me) - lotCenter(goal)) < vec2f(0.5)) && (lotCut(me, me, me + flow * 2.0, pad) || (any(goal != at) && !lotCut(me, me, goal, pad)));
  if (dist <= 4.0 * SUMMON_STOP || inward) {
    if (!lotCut(me, me, goal, pad) && !lotCut(goal, me, goal, pad)) { return arriveAt(me, onto); }
    let r = roomOf(me);
    if (r >= 0 && r == roomOf(goal)) {
      var best = 1e9;
      var aim = goal;
      for (var s = -1.0; s < 2.0; s += 2.0) {
        let c = roomWorld(u32(r), vec2f(CITY_LOT_HALF + ROOM_PAD + 0.05, s * (ROOM_DOOR - ROOM_PAD - 0.05)));
        let cost = distance(me, c) + distance(c, goal);
        if (cost < best && !crossesGlass(u32(r), me, c, pad) && !crossesGlass(u32(r), c, goal, pad)) {
          best = cost;
          aim = c;
        }
      }
      if (best < 1e9) { return dirTo(me, aim); }
    }
    let p = select(goal, me, lotCut(me, me, goal, pad));
    if (roomOf(p) < 0) {
      let c = lotCenter(p);
      let g = CITY_LOT_HALF + ROOM_PAD + 0.05;
      let face = CITY_LOT_HALF + ROOM_PAD;
      let l = me - c;
      let own = c + select(vec2f(clamp(at.x - c.x, -face, face), sign(l.y) * face), vec2f(sign(l.x) * face, clamp(at.y - c.y, -face, face)), abs(l.x) >= abs(l.y));
      if (distance(own, at) < SUMMON_STOP && !lotCut(me, me, own, pad) && !lotCut(goal, me, own, pad)) { return dirTo(me, own); }
      var best = 1e9;
      var aim = goal;
      for (var k = 0u; k < 4u; k++) {
        let q = c + vec2f(select(-g, g, (k & 1u) != 0u), select(-g, g, (k & 2u) != 0u));
        let cost = distance(me, q) + distance(q, goal);
        if (cost < best && (distance(q, at) <= 4.0 * SUMMON_STOP || distance(goal, at) < SUMMON_STOP) && !lotCut(me, me, q, pad) && !lotCut(goal, me, q, pad) && !lotCut(me, q, goal, pad) && !lotCut(goal, q, goal, pad)) {
          best = cost;
          aim = q;
        }
      }
      if (best < 1e9) { return dirTo(me, aim); }
    }
  }
  if (dot(flow, flow) <= 0.5) {
    let here = roomOf(me);
    if (here >= 0) { flow = flowAt(me + offGlass(u32(here), me) / FLOW_INV_CELL); }
  }
  return select(arriveAt(me, onto), flow, dot(flow, flow) > 0.5);
}
