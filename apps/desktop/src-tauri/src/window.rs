//! The window's opening size: most of the screen, never all of it, never more
//! than it. `tauri.conf.json` asks for the preferred size; at startup the window
//! is fitted to the monitor it opened on and centred, so a small screen gets a
//! window that fits and a large one does not get a sprawling one.

use tauri::{LogicalSize, WebviewWindow};

/// The size the desktop prefers to open at, in logical pixels — most of a
/// 13-inch laptop screen (1470 × 956 at its default scaling).
pub const PREFERRED: (f64, f64) = (1320.0, 860.0);
/// The share of the monitor the opening window may take in each direction.
pub const SHARE: f64 = 0.9;
/// The smallest the window opens at; below this the shell's panels crowd the room.
pub const MINIMUM: (f64, f64) = (960.0, 640.0);

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
    let logical = monitor.size().to_logical::<f64>(monitor.scale_factor());
    let (width, height) = fitted_size((logical.width, logical.height));
    let _ = window.set_size(LogicalSize::new(width, height));
    let _ = window.center();
}

#[cfg(test)]
mod tests {
    use super::{fitted_size, MINIMUM, PREFERRED};

    #[test]
    fn a_thirteen_inch_laptop_gets_most_of_its_screen() {
        // A MacBook Air 13" at its default scaling.
        let (w, h) = fitted_size((1470.0, 956.0));
        assert_eq!((w, h), PREFERRED);
        assert!(w / 1470.0 > 0.85 && h / 956.0 > 0.85);
    }

    #[test]
    fn a_large_screen_does_not_get_a_sprawling_window() {
        assert_eq!(fitted_size((2560.0, 1440.0)), PREFERRED);
    }

    #[test]
    fn a_small_screen_gets_a_window_that_fits() {
        let (w, h) = fitted_size((1280.0, 800.0));
        assert!(w <= 1280.0 * 0.9 && h <= 800.0 * 0.9);
        assert!(w >= MINIMUM.0 && h >= MINIMUM.1);
    }

    #[test]
    fn a_tiny_screen_is_never_overflowed() {
        let (w, h) = fitted_size((800.0, 600.0));
        assert!(w <= 800.0 && h <= 600.0);
    }
}
