mod acp;
mod temper;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(temper::TemperState::connect())
        .manage(acp::AcpState::default())
        .invoke_handler(tauri::generate_handler![
            temper::temper_connection_status,
            temper::temper_whoami,
            temper::temper_resolve_refs,
            acp::acp_start,
            acp::acp_prompt,
            acp::acp_close
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
