mod acp;
mod document;
mod document_panel;
mod document_save;
mod hub;
mod person_context;
mod settings;
mod temper;
mod window;
mod work;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The embedded WebDriver server the CSP witness drives on macOS, where tauri-driver has no
    // WKWebView driver. Behind the `webdriver` feature — the witness builds with it, so
    // development and release builds never compile an endpoint — and only when the witness (or
    // WebdriverIO) names a port: an ordinary run starts no endpoint.
    #[cfg(feature = "webdriver")]
    let builder = if std::env::var_os("TAURI_WEBDRIVER_PORT").is_some() {
        tauri::Builder::default().plugin(tauri_plugin_wdio_webdriver::init())
    } else {
        tauri::Builder::default()
    };
    #[cfg(not(feature = "webdriver"))]
    let builder = tauri::Builder::default();
    builder
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            app.manage(settings::SettingsState::load(dir));
            if let Some(main) = app.get_webview_window("main") {
                window::fit_to_monitor(&main);
            }
            Ok(())
        })
        .manage(temper::TemperState::connect())
        .manage(acp::AcpState::default())
        .invoke_handler(tauri::generate_handler![
            settings::settings_get,
            settings::settings_set_working_dir,
            settings::settings_set_theme,
            settings::settings_set_temper_context,
            settings::settings_set_agent,
            settings::settings_remove_agent,
            temper::temper_connection_status,
            temper::temper_whoami,
            temper::temper_resolve_refs,
            document::doc_open,
            document_panel::doc_connections,
            document_panel::doc_related,
            document_panel::doc_history,
            document_panel::doc_sources,
            document_save::doc_save_body,
            document_save::doc_save_meta,
            document_save::doc_show_changes,
            temper::temper_teams,
            temper::temper_contexts,
            temper::temper_context_create,
            temper::temper_recent_work,
            temper::temper_list_resources,
            work::temper_write_work_record,
            hub::hub_commit_recent_work,
            hub::hub_recent_work,
            acp::acp_start,
            acp::acp_prompt,
            acp::acp_set_mode,
            acp::acp_set_config_option,
            acp::acp_close,
            acp::acp_ask_surface,
            acp::acp_answer_permission
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
