mod acp;
mod adapters;
// The connection room's core: the setup/edit half of `temper init` — derive
// the provider entry the wizard would write and merge it into the CLI-shared
// config's [auth] section, preserving every other byte.
mod connection;
// The desktop's own temper credential custody: keychain-backed, or a file
// under TEMPER_DESKTOP_AUTH_STORE for dev and witness runs.
pub mod auth_store;
mod document;
mod document_create;
mod document_panel;
mod document_save;
mod hub;
mod hub_queue;
mod lens_binding;
mod person_context;
// The plugin packages the desktop ships beside itself: scanned and read here, their
// format owned by the shell's loader on the other side of the IPC.
mod plugins;
// The harness-fidelity probe is a test fixture, not an app surface: the only
// caller is the witness. The real presentation server (Chunk 1's module)
// replaces it, so the probe is compiled out of every non-test build.
mod present_board;
#[cfg(test)]
mod present_probe;
mod present_server;
mod presentation;
mod roster;
mod settings;
mod spec_check;
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
    let builder = builder.plugin(tauri_plugin_opener::init());
    builder
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            app.manage(settings::SettingsState::load(dir.clone()));
            let queue = hub_queue::HubQueue::load(dir);
            let pending = !queue.queued().is_empty();
            app.manage(queue);
            // Leaves queued by an earlier run that exited offline are committed now.
            if pending {
                hub_queue::commit_soon(app.handle().clone());
            }
            app.manage(window::DraftState::new());
            if let Some(main) = app.get_webview_window("main") {
                window::fit_to_monitor(&main);
                window::register_close_guard(&main);
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
            settings::settings_set_device_label,
            settings::settings_set_agent,
            settings::settings_remove_agent,
            roster::roster_get,
            temper::temper_connection_status,
            connection::temper_connection_gather,
            connection::temper_connection_apply,
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
            document_create::doc_create,
            window::doc_draft_state,
            window::doc_close_confirmed,
            temper::temper_teams,
            temper::temper_contexts,
            temper::temper_context_create,
            temper::temper_recent_work,
            temper::temper_list_resources,
            temper::temper_context_shape,
            lens_binding::lens_resolve,
            plugins::plugin_packages,
            work::temper_write_work_record,
            hub::hub_commit_recent_work,
            hub::hub_recent_work,
            hub_queue::hub_note_left,
            acp::acp_start,
            acp::acp_prompt,
            acp::acp_set_mode,
            acp::acp_set_config_option,
            acp::acp_close,
            acp::acp_ask_surface,
            acp::acp_answer_permission,
            presentation::present_answer,
            presentation::present_read
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // One bounded attempt to commit what is queued; the rest waits in
            // the queue file for the next launch.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                hub_queue::flush_at_exit(app);
            }
        });
}
