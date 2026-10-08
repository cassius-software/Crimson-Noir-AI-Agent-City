// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Lists the adapters wgpu can see (backend, type, driver): which GPU a stress run will get, and why.

fn main() {
    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor::default());
    for a in instance.enumerate_adapters(wgpu::Backends::all()) {
        let i = a.get_info();
        println!("{:?} {:?} {} | driver {} {}", i.backend, i.device_type, i.name, i.driver, i.driver_info);
    }
}
