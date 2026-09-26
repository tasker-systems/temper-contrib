mod acp;
mod settings;
mod temper;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            app.manage(settings::SettingsState::load(dir));
            Ok(())
        })
        .manage(temper::TemperState::connect())
        .manage(acp::AcpState::default())
        .invoke_handler(tauri::generate_handler![
            settings::settings_get,
            settings::settings_set_working_dir,
            settings::settings_set_theme,
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
