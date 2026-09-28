//! The window's opening size: most of the screen, never all of it, never more
//! than it. `tauri.conf.json` asks for the preferred size; at startup the window
//! is fitted to the monitor it opened on and centred, so a small screen gets a
//! window that fits and a large one does not get a sprawling one.
//!
//! The window-close draft guard: the surface reports dirty state with
//! `doc_draft_state(dirty)`; a close requested while a draft is dirty is prevented here
//! and announced to the surface with `doc-close-requested`, which the shipped
//! `core:event:default` capability already permits the webview to hear. On the person's
//! confirm the surface clears the dirty flag and calls this again — `close()` from the
//! core side does not re-enter the event, so the confirmed close lands without any
//! `core:window:*` grant.

use tauri::{Emitter, LogicalSize, Manager, WebviewWindow};

/// The size the desktop prefers to open at, in logical pixels — most of a
/// 13-inch laptop screen (1470 × 956 at its default scaling).
pub const PREFERRED: (f64, f64) = (1320.0, 860.0);
/// The share of the monitor the opening window may take in each direction.
pub const SHARE: f64 = 0.9;
/// The smallest the window opens at; below this the shell's panels crowd the room.
pub const MINIMUM: (f64, f64) = (960.0, 640.0);

/// The event a prevented close announces to the webview.
pub const CLOSE_REQUESTED: &str = "doc-close-requested";

/// What a close request should do, decided here so the wiring stays glue.
#[derive(Debug, PartialEq)]
pub enum CloseDecision {
    Proceed,
    /// Prevent the close and announce it — a draft stands.
    PreventAndAnnounce,
}

/// The shape the guard reads out of a window event: is this a request to close at all?
/// The runtime's `WindowEvent` is non-exhaustive, so a test cannot construct its
/// `CloseRequested` variant — the handler maps the real event onto this, and the
/// decision is a pure function over it.
#[derive(Debug, PartialEq)]
pub enum CloseRequest {
    Close,
    Other,
}

/// Decides one close request: requested while a document room holds a dirty draft is
/// prevented and announced; a clean close, and every non-close event, proceeds.
pub fn close_decision(dirty: bool, request: CloseRequest) -> CloseDecision {
    match (dirty, request) {
        (true, CloseRequest::Close) => CloseDecision::PreventAndAnnounce,
        _ => CloseDecision::Proceed,
    }
}

/// Reads the [`CloseRequest`] shape out of a real runtime event.
fn close_request_of(event: &tauri::WindowEvent) -> CloseRequest {
    match event {
        tauri::WindowEvent::CloseRequested { .. } => CloseRequest::Close,
        _ => CloseRequest::Other,
    }
}

/// Whether any open document room holds a dirty draft. Managed here, owned by the
/// surface: the room knows its drafts; this only answers.
pub struct DraftState(std::sync::atomic::AtomicBool);

impl DraftState {
    pub fn new() -> Self {
        Self(std::sync::atomic::AtomicBool::new(false))
    }

    pub fn set(&self, dirty: bool) {
        self.0.store(dirty, std::sync::atomic::Ordering::Relaxed);
    }

    pub fn get(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::Relaxed)
    }
}

/// The opening size for a monitor of `monitor` logical pixels: the preferred
/// size, shrunk to the monitor's share when it would not fit, and never below
/// the minimum unless the monitor itself is smaller.
pub fn fitted_size(monitor: (f64, f64)) -> (f64, f64) {
    let fit = |preferred: f64, minimum: f64, available: f64| {
        preferred.min(available * SHARE).max(minimum.min(available))
    };
    (
        fit(PREFERRED.0, MINIMUM.0, monitor.0),
        fit(PREFERRED.1, MINIMUM.1, monitor.1),
    )
}

/// Fits the window to the monitor it opened on and centres it. A monitor that
/// cannot be read leaves the configured size standing.
pub fn fit_to_monitor(window: &WebviewWindow) {
    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let size = monitor.size();
    let scale = monitor.scale_factor();
    let logical = (size.width as f64 / scale, size.height as f64 / scale);
    let (width, height) = fitted_size(logical);
    let _ = window.set_size(LogicalSize::new(width, height));
    let _ = window.center();
}

/// Registers the close-requested handler on the main window: a close while a draft is
/// dirty is prevented and announced; otherwise it proceeds.
pub fn register_close_guard<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    let handle = window.app_handle().clone();
    window.on_window_event(move |event| {
        let dirty = handle
            .try_state::<DraftState>()
            .map(|d| d.get())
            .unwrap_or(false);
        if close_decision(dirty, close_request_of(event)) != CloseDecision::PreventAndAnnounce {
            return;
        }
        // Preventing from inside the event handler: the runtime consults the event's own
        // API before closing. The confirmed close arrives through `close_confirmed`, which
        // does not re-enter CloseRequested.
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
        }
        let _ = handle.emit(CLOSE_REQUESTED, ());
    })
}

/// Closes the window for a confirmed close: past the draft guard, not re-entering it.
pub fn close_confirmed<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    let _ = window.destroy();
}

/// The surface reports whether any open document room holds a dirty draft. A close
/// requested while this reads true is prevented by the guard and announced back as
/// [`CLOSE_REQUESTED`]; on the person's confirm the surface clears the flag and calls
/// `doc_close_confirmed`.
#[tauri::command]
pub fn doc_draft_state(state: tauri::State<'_, DraftState>, dirty: bool) {
    state.set(dirty);
}

/// The person confirmed closing over a dirty draft: the flag clears and the window
/// closes, past the guard.
#[tauri::command]
pub fn doc_close_confirmed(
    app: tauri::AppHandle,
    state: tauri::State<'_, DraftState>,
) -> Result<(), String> {
    state.set(false);
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "no main window".to_string())?;
    close_confirmed(&window);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_close_while_clean_proceeds() {
        assert_eq!(
            close_decision(false, CloseRequest::Close),
            CloseDecision::Proceed,
            "the guard must not stand between a clean room and its close"
        );
    }

    #[test]
    fn a_close_while_dirty_is_prevented_and_announced() {
        assert_eq!(
            close_decision(true, CloseRequest::Close),
            CloseDecision::PreventAndAnnounce
        );
    }

    #[test]
    fn no_other_event_is_ever_prevented() {
        assert_eq!(
            close_decision(true, CloseRequest::Other),
            CloseDecision::Proceed,
            "only a close request may be prevented"
        );
    }

    #[test]
    fn the_flag_reads_what_was_reported() {
        let draft = DraftState::new();
        assert!(!draft.get(), "a fresh run starts clean");
        draft.set(true);
        assert!(draft.get(), "the report lands");
        draft.set(false);
        assert!(!draft.get(), "a saved draft clears the report");
    }

    /// The handler's event-to-request mapping, driven through a real window on the
    /// MockRuntime with an instrumented listener: every event the runtime delivers is
    /// classified, and only the close of a dirty room reads PreventAndAnnounce. The
    /// runtime's `close()` is a no-op that delivers no event, so the close arm of this
    /// mapping is witnessed by the shipping app — the wiring itself is glue over the
    /// decision proven here.
    #[test]
    fn the_real_events_a_window_delivers_classify_without_preventing_anything() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        window.on_window_event(|event| {
            let request = close_request_of(event);
            let decision = close_decision(true, request);
            // Recorded through a side channel the handler can write and the test reads.
            CLASSES.with(|c| c.borrow_mut().push(decision));
        });
        // The events the MockRuntime does deliver: size and focus changes.
        let _ = window.set_size(tauri::LogicalSize::new(800.0, 600.0));
        let _ = window.set_focus();
        let recorded = CLASSES.with(|c| std::mem::take(&mut *c.borrow_mut()));
        assert!(
            recorded.iter().all(|d| *d == CloseDecision::Proceed),
            "no non-close event may ever read PreventAndAnnounce: {recorded:?}"
        );
    }

    thread_local! {
        static CLASSES: std::cell::RefCell<Vec<CloseDecision>> = const { std::cell::RefCell::new(Vec::new()) };
    }
}
