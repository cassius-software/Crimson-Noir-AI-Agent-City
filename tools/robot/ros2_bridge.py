#!/usr/bin/env python3
# Copyright (c) 2026 Julian Cassius Subban
# SPDX-License-Identifier: MIT
# Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
# Why does this file exist? It is an EXAMPLE of a `/robot` peer of the robot relay (docs/joint-bridge-spec.md §3.2)
# written for ROS 2: it subscribes to /joint_states and forwards each reading to the relay as a state frame, and it
# forwards the setpoints the relay admits to a position command topic. It was written from the documentation of
# rclpy and the `websockets` package and has NEVER BEEN RUN HERE: no ROS 2 installation and no robot exist in this
# repository (docs/joint-bridge-spec.md §8). Read it as a sketch of the protocol, try it on a bench with a physical
# stop within reach, and treat every line as unconfirmed until you have.
# What breaks if it is removed? Nothing in the city; a ROS 2 user has no starting point for a peer.
#
#   pip install websockets
#   python3 tools/robot/ros2_bridge.py ws://127.0.0.1:8790/robot <robot token> --urdf robot.urdf \
#       --command-topic /forward_position_controller/commands
#
# The relay reads the URDF (urdf.ts) and answers `welcome` with `order`, the movable joints' names in the manifest's
# order; every q, qd and tau array below is in that order. Setpoints go out as std_msgs/Float64MultiArray, the shape
# ros2_control's forward command controllers take; a JointTrajectory publisher would be the same few lines.
import argparse
import asyncio
import json
import threading
import time

import rclpy
from rclpy.node import Node
from sensor_msgs.msg import JointState
from std_msgs.msg import Float64MultiArray
import websockets

HOLD_MS = 500          # the device rule: hold when no fresh setpoints arrived within this (or the ttl)
BEAT_S = 0.15          # beat at least every 200 ms while armed


class Bridge(Node):
    def __init__(self, order_holder):
        super().__init__('agentcity_joint_bridge')
        self.order_holder = order_holder          # filled by `welcome`
        self.latest = None                        # the newest JointState as a frame
        self.seq = 0
        self.ack = None
        self.create_subscription(JointState, '/joint_states', self.on_joint_state, 10)
        self.command_pub = None

    def on_joint_state(self, msg):
        order = self.order_holder.get('order')
        if not order:
            return
        index = {name: i for i, name in enumerate(msg.name)}

        def pick(arr):
            # A JointState names its joints in its own order and may leave velocity or effort empty.
            return [float(arr[index[n]]) if n in index and index[n] < len(arr) else 0.0 for n in order]

        frame = {'stamp': int(time.time() * 1000), 'seq': self.seq, 'q': pick(msg.position), 'qd': pick(msg.velocity), 'tau': pick(msg.effort)}
        if self.ack is not None:
            frame['ack'] = self.ack
        self.seq += 1
        self.latest = frame


async def run(url, token, urdf_text, command_topic, hz):
    rclpy.init()
    holder = {}
    node = Bridge(holder)
    node.command_pub = node.create_publisher(Float64MultiArray, command_topic, 10)
    spinner = threading.Thread(None, rclpy.spin, args=(node,), daemon=True)
    spinner.start()
    armed = False
    last_fresh = 0.0
    ttl_ms = 0
    async with websockets.connect(url, subprotocols=['joints.1', 'auth.' + token], max_size=1 << 20) as ws:
        await ws.send(json.dumps({'t': 'hello', 'v': 1, 'urdf': urdf_text, 'caps': {'class': 'actuator', 'telemetry': ['joints'], 'actuation': ['servo']}}))

        async def frames():
            while True:
                await asyncio.sleep(1.0 / hz)
                if node.latest is not None and holder.get('order'):
                    await ws.send(json.dumps({'t': 'state', 'frame': node.latest}))

        async def beats():
            n = 0
            while True:
                await asyncio.sleep(BEAT_S)
                if armed:
                    n += 1
                    await ws.send(json.dumps({'t': 'beat', 'n': n}))

        asyncio.ensure_future(frames())
        asyncio.ensure_future(beats())
        async for text in ws:
            m = json.loads(text)
            t = m.get('t')
            if t == 'welcome':
                holder['order'] = m['order']
                node.get_logger().info('welcomed as %s: %s' % (m['id'], ', '.join(m['order'])))
            elif t == 'arm':
                armed = True
                await ws.send(json.dumps({'t': 'armed', 'nonce': m['nonce']}))
            elif t == 'disarm':
                armed = False
                node.get_logger().warn('disarmed: %s' % m.get('cause'))
            elif t == 'targets' and armed:
                sp = m['setpoints']
                now_ms = time.time() * 1000
                # The relay admitted these; the controller below is still the robot's own last word. The device rule
                # (hold after HOLD_MS or the ttl, judged from arrival) belongs in the controller or a watchdog node:
                # a forward command controller holds its last command, so a watchdog that republishes the present
                # position when `now_ms - last_fresh` passes the hold is the missing piece on a real robot.
                last_fresh = now_ms
                ttl_ms = sp['ttlMs']
                msg = Float64MultiArray()
                msg.data = [float(x) for x in sp['q']]
                node.command_pub.publish(msg)
                node.ack = sp['seq']
                await ws.send(json.dumps({'t': 'ack', 'seq': sp['seq']}))
    rclpy.shutdown()


def main():
    p = argparse.ArgumentParser(description='an example ROS 2 peer of the Agent City robot relay (never run here)')
    p.add_argument('url')
    p.add_argument('token')
    p.add_argument('--urdf', required=True, help='the robot description file the relay will read')
    p.add_argument('--command-topic', default='/forward_position_controller/commands')
    p.add_argument('--hz', type=float, default=50.0)
    a = p.parse_args()
    with open(a.urdf, encoding='utf-8') as f:
        urdf_text = f.read()
    asyncio.run(run(a.url, a.token, urdf_text, a.command_topic, a.hz))


if __name__ == '__main__':
    main()
