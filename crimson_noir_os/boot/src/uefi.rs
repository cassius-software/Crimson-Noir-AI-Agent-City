//! Why does this file exist? It is the firmware boundary of the bootable image, written out by hand from the UEFI
//! specification (2.10): the system table, the boot services the image calls before it takes the machine over (pages,
//! the memory map, the protocol lookup, the stall, the watchdog, ExitBootServices), the text console for the one
//! message before the screen is ours, and the Graphics Output Protocol that names the linear framebuffer. Only the
//! entries the image calls are typed; every other slot is a placeholder of the right size, so each table's layout is
//! the specification's. No UEFI crate: every byte of the image is either this workspace's or a crate the containment
//! configuration declares.
//! What breaks if it is removed? The image cannot ask the firmware for a screen, memory or the machine.

use core::ffi::c_void;

pub type Handle = *mut c_void;
pub type Status = usize;

pub const SUCCESS: Status = 0;
const ERROR: usize = 1 << 63;
pub const UNSUPPORTED: Status = ERROR | 3;
pub const OUT_OF_RESOURCES: Status = ERROR | 9;

#[repr(C)]
pub struct TableHeader {
    pub signature: u64,
    pub revision: u32,
    pub header_size: u32,
    pub crc32: u32,
    pub reserved: u32,
}

#[repr(C)]
pub struct SystemTable {
    pub hdr: TableHeader,
    pub firmware_vendor: *const u16,
    pub firmware_revision: u32,
    pub console_in_handle: Handle,
    pub con_in: *mut c_void,
    pub console_out_handle: Handle,
    pub con_out: *mut TextOutput,
    pub standard_error_handle: Handle,
    pub std_err: *mut TextOutput,
    pub runtime_services: *mut RuntimeServices,
    pub boot_services: *mut BootServices,
    pub number_of_table_entries: usize,
    pub configuration_table: *mut c_void,
}

#[repr(C)]
pub struct TextOutput {
    pub reset: extern "efiapi" fn(*mut TextOutput, bool) -> Status,
    pub output_string: extern "efiapi" fn(*mut TextOutput, *const u16) -> Status,
    test_string: usize,
    query_mode: usize,
    set_mode: usize,
    set_attribute: usize,
    clear_screen: usize,
    set_cursor_position: usize,
    enable_cursor: usize,
    mode: usize,
}

/// EFI_ALLOCATE_TYPE
pub const ALLOCATE_ANY_PAGES: u32 = 0;
/// EFI_MEMORY_TYPE
pub const LOADER_DATA: u32 = 2;
pub const CONVENTIONAL_MEMORY: u32 = 7;

#[repr(C)]
pub struct BootServices {
    pub hdr: TableHeader,
    raise_tpl: usize,
    restore_tpl: usize,
    pub allocate_pages: extern "efiapi" fn(alloc: u32, memory_type: u32, pages: usize, memory: *mut u64) -> Status,
    free_pages: usize,
    pub get_memory_map: extern "efiapi" fn(
        map_size: *mut usize,
        map: *mut u8,
        map_key: *mut usize,
        descriptor_size: *mut usize,
        descriptor_version: *mut u32,
    ) -> Status,
    allocate_pool: usize,
    free_pool: usize,
    create_event: usize,
    set_timer: usize,
    wait_for_event: usize,
    signal_event: usize,
    close_event: usize,
    check_event: usize,
    install_protocol_interface: usize,
    reinstall_protocol_interface: usize,
    uninstall_protocol_interface: usize,
    handle_protocol: usize,
    reserved: usize,
    register_protocol_notify: usize,
    locate_handle: usize,
    locate_device_path: usize,
    install_configuration_table: usize,
    load_image: usize,
    start_image: usize,
    exit: usize,
    unload_image: usize,
    pub exit_boot_services: extern "efiapi" fn(image: Handle, map_key: usize) -> Status,
    get_next_monotonic_count: usize,
    pub stall: extern "efiapi" fn(microseconds: usize) -> Status,
    pub set_watchdog_timer: extern "efiapi" fn(timeout: usize, code: u64, data_size: usize, data: *const u16) -> Status,
    connect_controller: usize,
    disconnect_controller: usize,
    open_protocol: usize,
    close_protocol: usize,
    open_protocol_information: usize,
    protocols_per_handle: usize,
    locate_handle_buffer: usize,
    pub locate_protocol: extern "efiapi" fn(protocol: *const Guid, registration: *mut c_void, interface: *mut *mut c_void) -> Status,
}

/// EFI_RESET_TYPE
pub const RESET_COLD: u32 = 0;
pub const RESET_SHUTDOWN: u32 = 2;

#[repr(C)]
pub struct RuntimeServices {
    pub hdr: TableHeader,
    get_time: usize,
    set_time: usize,
    get_wakeup_time: usize,
    set_wakeup_time: usize,
    set_virtual_address_map: usize,
    convert_pointer: usize,
    get_variable: usize,
    get_next_variable_name: usize,
    set_variable: usize,
    get_next_high_monotonic_count: usize,
    pub reset_system: extern "efiapi" fn(reset_type: u32, status: Status, data_size: usize, data: *const c_void) -> !,
}

#[repr(C)]
pub struct Guid {
    pub data1: u32,
    pub data2: u16,
    pub data3: u16,
    pub data4: [u8; 8],
}

/// EFI_GRAPHICS_OUTPUT_PROTOCOL_GUID
pub const GOP_GUID: Guid = Guid { data1: 0x9042_a9de, data2: 0x23dc, data3: 0x4a38, data4: [0x96, 0xfb, 0x7a, 0xde, 0xd0, 0x80, 0x51, 0x6a] };

#[repr(C)]
pub struct Gop {
    pub query_mode: extern "efiapi" fn(*mut Gop, mode: u32, size_of_info: *mut usize, info: *mut *mut ModeInfo) -> Status,
    pub set_mode: extern "efiapi" fn(*mut Gop, mode: u32) -> Status,
    blt: usize,
    pub mode: *mut GopMode,
}

#[repr(C)]
pub struct GopMode {
    pub max_mode: u32,
    pub mode: u32,
    pub info: *mut ModeInfo,
    pub size_of_info: usize,
    pub frame_buffer_base: u64,
    pub frame_buffer_size: usize,
}

/// EFI_GRAPHICS_PIXEL_FORMAT
pub const PIXEL_RGB: u32 = 0;
pub const PIXEL_BGR: u32 = 1;
pub const PIXEL_BITMASK: u32 = 2;

#[repr(C)]
pub struct ModeInfo {
    pub version: u32,
    pub horizontal_resolution: u32,
    pub vertical_resolution: u32,
    pub pixel_format: u32,
    /// Red, green, blue and reserved masks (PIXEL_BITMASK only).
    pub pixel_information: [u32; 4],
    pub pixels_per_scan_line: u32,
}

/// One entry of the memory map (the firmware's stride is `descriptor_size`, which may be larger).
#[repr(C)]
pub struct MemoryDescriptor {
    pub ty: u32,
    pub physical_start: u64,
    pub virtual_start: u64,
    pub number_of_pages: u64,
    pub attribute: u64,
}

/// Writes an ASCII line to the firmware's text console (before the screen is the image's).
pub fn print(st: *mut SystemTable, line: &str) {
    let mut buf = [0u16; 160];
    let mut n = 0;
    for b in line.bytes().take(buf.len() - 3) {
        buf[n] = b as u16;
        n += 1;
    }
    buf[n] = b'\r' as u16;
    buf[n + 1] = b'\n' as u16;
    buf[n + 2] = 0;
    // SAFETY: the system table and its console are the firmware's, valid while boot services run.
    unsafe {
        let out = (*st).con_out;
        if !out.is_null() {
            ((*out).output_string)(out, buf.as_ptr());
        }
    }
}
