mod acp;
mod document;
mod document_panel;
mod document_save;
mod hub;
mod person_context;
mod settings;
mod temper;
mod work;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
