//! Side panel undock — window lifecycle, geometry and persisted state.
//!
//! The panel has two homes. Docked, it is part of the main window's terminal
//! view and pushes the terminal (ADR-003 — it never overlays). Undocked, it is
//! a second OS window the user can move across monitors and resize, then dock
//! again. See `docs/plans/066-plan-side-panel-undock.md`.
//!
//! This module owns only the window, its geometry and the config entries. The
//! content lives in the frontend: the main window mirrors its panel snapshot
//! into this window over a Tauri event, and the panel window sends user actions
//! back. Nothing here touches the keystroke or suggestion path.
//!
//! Two invariants the commands below enforce:
//!  * At most one panel window exists — `panel_open` reuses and focuses the
//!    existing one instead of building a second.
//!  * The window is never created at launch. `panel_open` is only reachable
//!    from a user action, and the persisted config deliberately omits the
//!    open/closed state so a relaunch cannot restore one.

use crate::config::{PanelConfig, PanelWindowGeometry};
use crate::state::AppState;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

/// Window label of the undocked panel. Also the entry this label needs in
/// `capabilities/default.json`.
pub const PANEL_LABEL: &str = "panel";
/// Emitted to the main window when the panel window goes away without the app
/// asking (its own close button, or the app shutting down) so the frontend can
/// drop its open state and re-fit the terminal.
pub const PANEL_CLOSED_EVENT: &str = "comnd:panel-closed";

/// Docked panel width bounds, in CSS px. Mirrors the resizer's own clamp in
/// `terminal-view.ts` (`initSidebarResize`), which keeps the drag between 240 and
/// 60% of the terminal width.
pub const DOCKED_WIDTH_MIN: u32 = 240;
pub const DOCKED_WIDTH_MAX: u32 = 1200;

const DEFAULT_WINDOW_WIDTH: u32 = 420;
const DEFAULT_WINDOW_HEIGHT: u32 = 640;
/// Below this the panel's own content stops being usable.
const MIN_WINDOW_WIDTH: f64 = 260.0;
const MIN_WINDOW_HEIGHT: f64 = 240.0;
/// How long a move/resize must settle before the geometry is written. Dragging
/// fires one event per pixel; each write rewrites and fsyncs config.json
/// (ADR-015), so they are coalesced here and flushed synchronously on close.
const GEOMETRY_DEBOUNCE: Duration = Duration::from_millis(300);

// ─── Geometry clamping ─────────────────────────────────────────────

/// A monitor rectangle in physical pixels, matching `outer_position()` and
/// `inner_size()`. Kept as a plain struct so `clamp_position` is a pure
/// function the unit tests can drive without a display attached.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MonitorRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

fn contains(rect: &MonitorRect, x: i32, y: i32) -> bool {
    let right = rect.x as i64 + rect.width as i64;
    let bottom = rect.y as i64 + rect.height as i64;
    (x as i64) >= rect.x as i64 && (x as i64) < right && (y as i64) >= rect.y as i64 && (y as i64) < bottom
}

/// Squared distance from a point to the nearest edge of a monitor rect, 0 when
/// the point is inside it. Used to pick the monitor a vanished window should
/// land on.
fn distance_squared(rect: &MonitorRect, x: i32, y: i32) -> i64 {
    let right = rect.x as i64 + rect.width as i64;
    let bottom = rect.y as i64 + rect.height as i64;
    let px = x as i64;
    let py = y as i64;
    let dx = if px < rect.x as i64 {
        rect.x as i64 - px
    } else if px > right {
        px - right
    } else {
        0
    };
    let dy = if py < rect.y as i64 {
        rect.y as i64 - py
    } else if py > bottom {
        py - bottom
    } else {
        0
    };
    dx * dx + dy * dy
}

/// Clamp a saved top-left corner back onto the nearest visible monitor, keeping
/// the saved size.
///
/// A corner already inside a monitor is left exactly where it was: the user may
/// deliberately straddle two monitors, and only a corner outside *every* monitor
/// means the window is unreachable. The clamp then guarantees the top-left is on
/// the chosen monitor, pulling the window fully on screen when it fits and
/// keeping the saved size when the monitor is smaller than it — a window that is
/// too big to fit must not silently shrink.
pub fn clamp_position(
    saved_x: i32,
    saved_y: i32,
    width: u32,
    height: u32,
    monitors: &[MonitorRect],
) -> (i32, i32) {
    if monitors.is_empty() {
        // No monitor could be enumerated, so there is nothing to clamp onto.
        return (saved_x, saved_y);
    }
    if monitors.iter().any(|m| contains(m, saved_x, saved_y)) {
        return (saved_x, saved_y);
    }
    let nearest = monitors
        .iter()
        .min_by_key(|m| distance_squared(m, saved_x, saved_y))
        .expect("monitors is non-empty");
    let max_x = nearest.x + nearest.width as i32 - width.min(nearest.width) as i32;
    let max_y = nearest.y + nearest.height as i32 - height.min(nearest.height) as i32;
    (saved_x.clamp(nearest.x, max_x), saved_y.clamp(nearest.y, max_y))
}

fn monitor_rects(app: &AppHandle) -> Vec<MonitorRect> {
    app.available_monitors()
        .unwrap_or_default()
        .into_iter()
        .map(|m| MonitorRect {
            x: m.position().x,
            y: m.position().y,
            width: m.size().width,
            height: m.size().height,
        })
        .collect()
}

/// Where a panel with no saved geometry opens: the default size, centred on the
/// primary monitor.
///
/// The default size is nominal logical pixels, and the returned rectangle must be
/// physical, so it is scaled by the primary monitor's factor — otherwise the first
/// undock at 150% scale would open a window two-thirds of the intended size.
fn default_geometry(app: &AppHandle) -> PanelWindowGeometry {
    let mut geometry = PanelWindowGeometry {
        x: 100,
        y: 100,
        width: DEFAULT_WINDOW_WIDTH,
        height: DEFAULT_WINDOW_HEIGHT,
    };
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let scale = monitor.scale_factor();
        let position = monitor.position();
        let size = monitor.size();
        geometry.width = (DEFAULT_WINDOW_WIDTH as f64 * scale).round() as u32;
        geometry.height = (DEFAULT_WINDOW_HEIGHT as f64 * scale).round() as u32;
        geometry.x = position.x + (size.width as i32 - geometry.width as i32) / 2;
        geometry.y = position.y + (size.height as i32 - geometry.height as i32) / 2;
    }
    geometry
}

fn clamped_docked_width(width: u32) -> u32 {
    width.clamp(DOCKED_WIDTH_MIN, DOCKED_WIDTH_MAX)
}

// ─── Persisted state ───────────────────────────────────────────────

fn read_panel_config(app: &AppHandle) -> PanelConfig {
    let state = app.state::<AppState>();
    let guard = match state.config.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let mut panel = guard.get().panel.clone();
    panel.docked_width = clamped_docked_width(panel.docked_width);
    panel
}

fn write_panel_config(app: &AppHandle, panel: PanelConfig) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut guard = match state.config.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    guard.set_panel(panel)
}

/// Persist only the window rectangle, leaving the undocked flag and docked width
/// as they are. Called from the debounce worker and from the close handler.
fn persist_geometry(app: &AppHandle, geometry: PanelWindowGeometry) -> Result<(), String> {
    let mut panel = read_panel_config(app);
    panel.window = Some(geometry);
    write_panel_config(app, panel)
}

// ─── Window lifecycle ──────────────────────────────────────────────

/// Debounced geometry writer. Dragging emits one move event per pixel; this
/// coalesces them into at most one config write per `GEOMETRY_DEBOUNCE`, and the
/// close handler flushes the last one synchronously so quitting straight after a
/// drag cannot lose it.
struct GeometrySaver {
    pending: Arc<Mutex<Option<PanelWindowGeometry>>>,
    stop: Arc<AtomicBool>,
}

impl GeometrySaver {
    fn start(app: &AppHandle) -> Self {
        let pending: Arc<Mutex<Option<PanelWindowGeometry>>> = Arc::new(Mutex::new(None));
        let stop = Arc::new(AtomicBool::new(false));
        let worker_pending = Arc::clone(&pending);
        let worker_stop = Arc::clone(&stop);
        let worker_app = app.clone();
        std::thread::spawn(move || {
            while !worker_stop.load(Ordering::Relaxed) {
                std::thread::sleep(GEOMETRY_DEBOUNCE);
                let next = match worker_pending.lock() {
                    Ok(mut slot) => slot.take(),
                    Err(_) => None,
                };
                if let Some(geometry) = next {
                    if let Err(e) = persist_geometry(&worker_app, geometry) {
                        log::warn!("Failed to save panel window geometry: {}", e);
                    }
                }
            }
        });
        GeometrySaver { pending, stop }
    }

    fn record(&self, geometry: PanelWindowGeometry) {
        if let Ok(mut slot) = self.pending.lock() {
            *slot = Some(geometry);
        }
    }

    /// Take the pending rectangle, if any, for a synchronous write. Used by the
    /// close handler, where waiting for the debounce would lose the last move.
    fn take(&self) -> Option<PanelWindowGeometry> {
        self.pending.lock().ok().and_then(|mut slot| slot.take())
    }

    /// Stop the debounce thread once the window is gone.
    fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// The size the window manager reports is the inner size, and the position is the
/// outer top-left; both are physical pixels. Persisting that pair round-trips
/// exactly through `set_position` + `set_size`, so it survives a DPI change
/// between launches without a unit conversion.
fn current_geometry(window: &WebviewWindow, fallback: PanelWindowGeometry) -> PanelWindowGeometry {
    let position = window.outer_position().ok();
    let size = window.inner_size().ok();
    PanelWindowGeometry {
        x: position.map(|p| p.x).unwrap_or(fallback.x),
        y: position.map(|p| p.y).unwrap_or(fallback.y),
        width: size.map(|s| s.width).unwrap_or(fallback.width),
        height: size.map(|s| s.height).unwrap_or(fallback.height),
    }
}

fn attach_geometry_tracking(app: &AppHandle, window: &WebviewWindow, initial: PanelWindowGeometry) {
    let saver = Arc::new(GeometrySaver::start(app));
    // The latest known rectangle: a move event carries only the position and a
    // resize event only the size, so the two are merged here.
    let latest = Arc::new(Mutex::new(initial));
    let close_app = app.clone();
    let close_saver = Arc::clone(&saver);
    let move_saver = Arc::clone(&saver);
    let size_saver = Arc::clone(&saver);
    let destroy_saver = Arc::clone(&saver);

    window.on_window_event(move |event| match event {
        WindowEvent::Moved(position) => {
            if let Ok(mut value) = latest.lock() {
                value.x = position.x;
                value.y = position.y;
                move_saver.record(*value);
            }
        }
        WindowEvent::Resized(size) => {
            if let Ok(mut value) = latest.lock() {
                value.width = size.width;
                value.height = size.height;
                size_saver.record(*value);
            }
        }
        WindowEvent::CloseRequested { api, .. } => {
            // The panel's own close button (and the OS close shortcut) closes the
            // panel rather than docking it: docking is the explicit action, and a
            // window that the user dismissed must not reappear docked.
            api.prevent_close();
            // Flush the final rectangle synchronously — the debounce worker may
            // not have written the last move before the window goes away.
            if let Some(geometry) = close_saver.take() {
                if let Err(e) = persist_geometry(&close_app, geometry) {
                    log::warn!("Failed to save panel window geometry on close: {}", e);
                }
            }
            if let Some(window) = close_app.get_webview_window(PANEL_LABEL) {
                let _ = window.destroy();
            }
            if let Err(e) = close_app.emit_to("main", PANEL_CLOSED_EVENT, ()) {
                log::warn!("Failed to report panel close to the main window: {}", e);
            }
        }
        WindowEvent::Destroyed => destroy_saver.stop(),
        _ => {}
    });
}

/// Close the panel window if one exists. Safe to call when there is none.
fn close_panel_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(PANEL_LABEL) {
        window.destroy().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ─── Commands ──────────────────────────────────────────────────────

/// The panel state the frontend needs on launch. `open` is deliberately absent:
/// the panel always starts closed, whatever was persisted.
#[tauri::command]
pub async fn panel_get_state(app: AppHandle) -> Result<PanelConfig, String> {
    Ok(read_panel_config(&app))
}

/// Persist where the panel lives. Docking also destroys the window, so a stale
/// panel window can never outlive the docked state.
#[tauri::command]
pub async fn panel_set_undocked(app: AppHandle, undocked: bool) -> Result<(), String> {
    let mut panel = read_panel_config(&app);
    panel.undocked = undocked;
    write_panel_config(&app, panel)?;
    if !undocked {
        close_panel_window(&app)?;
    }
    Ok(())
}

/// Persist the docked width. Clamped so a hand-edited config cannot make the
/// docked panel swallow the terminal.
#[tauri::command]
pub async fn panel_set_docked_width(app: AppHandle, width: u32) -> Result<u32, String> {
    let width = clamped_docked_width(width);
    let mut panel = read_panel_config(&app);
    panel.docked_width = width;
    write_panel_config(&app, panel)?;
    Ok(width)
}

/// Open the panel window, or focus the one that already exists, at its saved
/// geometry clamped onto a visible monitor. Returns the rectangle it ended up
/// with.
#[tauri::command]
pub async fn panel_open(app: AppHandle) -> Result<PanelWindowGeometry, String> {
    if let Some(window) = app.get_webview_window(PANEL_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        window.set_focus().map_err(|e| e.to_string())?;
        let fallback = default_geometry(&app);
        return Ok(current_geometry(&window, fallback));
    }

    let saved = read_panel_config(&app).window.unwrap_or_else(|| default_geometry(&app));
    let (x, y) = clamp_position(saved.x, saved.y, saved.width, saved.height, &monitor_rects(&app));

    // Built hidden, then placed with physical pixels, then shown: setting the
    // builder's position/size means logical pixels, which at 150% scale would
    // land the restored window in the wrong place. Showing only after the
    // geometry is applied also avoids a one-frame flash at the default position.
    let window = WebviewWindowBuilder::new(&app, PANEL_LABEL, WebviewUrl::App("index.html".into()))
        .title("Comnd Panel")
        .inner_size(DEFAULT_WINDOW_WIDTH as f64, DEFAULT_WINDOW_HEIGHT as f64)
        .min_inner_size(MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)
        .resizable(true)
        .visible(false)
        .build()
        .map_err(|e| format!("Failed to create the panel window: {}", e))?;

    window
        .set_size(PhysicalSize::new(saved.width, saved.height))
        .map_err(|e| e.to_string())?;
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;

    let geometry = PanelWindowGeometry { x, y, width: saved.width, height: saved.height };
    attach_geometry_tracking(&app, &window, geometry);
    Ok(geometry)
}

/// Close the panel window without docking it. The docked width and the undocked
/// flag are untouched, so reopening returns the panel to the same home.
#[tauri::command]
pub async fn panel_close(app: AppHandle) -> Result<(), String> {
    close_panel_window(&app)
}

// ─── Debug-only helpers for the app-level smoke suite ──────────────

#[cfg(debug_assertions)]
#[derive(Debug, Clone, serde::Serialize)]
pub struct PanelWindowInfo {
    pub label: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub visible: bool,
    pub focused: bool,
}

/// Every webview window the app owns, with its physical rectangle. The smoke
/// suite uses this when the WebDriver on the host cannot switch to the second
/// native window: it proves the panel window exists, where it is, and that there
/// is exactly one of it.
#[cfg(debug_assertions)]
#[tauri::command]
pub async fn test_panel_windows(app: AppHandle) -> Result<Vec<PanelWindowInfo>, String> {
    let mut windows: Vec<PanelWindowInfo> = app
        .webview_windows()
        .into_iter()
        .map(|(label, window)| {
            let fallback = default_geometry(&app);
            let geometry = current_geometry(&window, fallback);
            PanelWindowInfo {
                label,
                x: geometry.x,
                y: geometry.y,
                width: geometry.width,
                height: geometry.height,
                visible: window.is_visible().unwrap_or(false),
                focused: window.is_focused().unwrap_or(false),
            }
        })
        .collect();
    windows.sort_by(|a, b| a.label.cmp(&b.label));
    Ok(windows)
}

/// Move and resize the panel window, persisting the rectangle immediately. The
/// relaunch smoke scenario sets up a known geometry through this so the restored
/// position can be asserted without depending on where a drag happened to land.
#[cfg(debug_assertions)]
#[tauri::command]
pub async fn test_panel_set_geometry(
    app: AppHandle,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let window = app
        .get_webview_window(PANEL_LABEL)
        .ok_or_else(|| "The panel window is not open".to_string())?;
    window
        .set_size(PhysicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    persist_geometry(&app, PanelWindowGeometry { x, y, width, height })
}

/// Destroy the panel window when the main window goes away, so quitting the app
/// with the panel undocked cannot leave an orphan window keeping the process
/// alive.
pub fn attach_main_window_cleanup(app: &AppHandle) {
    let Some(main) = app.get_webview_window("main") else {
        log::warn!("Main window missing at setup; panel cleanup not attached");
        return;
    };
    let handle = app.clone();
    main.on_window_event(move |event| {
        if matches!(
            event,
            WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
        ) {
            let _ = close_panel_window(&handle);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: i32, y: i32, width: u32, height: u32) -> MonitorRect {
        MonitorRect { x, y, width, height }
    }

    #[test]
    fn clamp_keeps_a_position_that_is_already_visible() {
        let monitors = [rect(0, 0, 1920, 1080)];
        assert_eq!(clamp_position(100, 80, 420, 640, &monitors), (100, 80));
    }

    #[test]
    fn clamp_keeps_an_inside_corner_of_a_window_straddling_two_monitors() {
        // Corner inside the second monitor: the user placed it there on purpose.
        let monitors = [rect(0, 0, 1920, 1080), rect(1920, 0, 1920, 1080)];
        assert_eq!(clamp_position(1900, 100, 420, 640, &monitors), (1900, 100));
    }

    #[test]
    fn clamp_lands_geometry_outside_every_monitor_on_the_nearest_one() {
        // The monitor the window was last on is gone; only a 1920x1080 display
        // is left, and the saved corner is far past its right edge.
        let monitors = [rect(0, 0, 1920, 1080)];
        assert_eq!(clamp_position(5200, 120, 420, 640, &monitors), (1500, 120));
    }

    #[test]
    fn clamp_picks_the_nearer_monitor_not_the_primary() {
        let monitors = [rect(0, 0, 1920, 1080), rect(1920, 0, 1920, 1080)];
        // Past the right edge of the right-hand monitor: nearest is that one.
        assert_eq!(clamp_position(4200, 100, 400, 600, &monitors), (3440, 100));
        // Left of everything: nearest is the left-hand monitor.
        assert_eq!(clamp_position(-900, 100, 400, 600, &monitors), (0, 100));
    }

    #[test]
    fn clamp_handles_a_monitor_with_a_negative_origin() {
        // A display placed above-left of the primary starts at a negative origin.
        // Its bottom edge is y = 0, so a 640-high panel has to sit at y <= -640 to
        // be fully on it: the corner moves in, the size is kept.
        let monitors = [rect(0, 0, 1920, 1080), rect(-1920, -1080, 1920, 1080)];
        assert_eq!(clamp_position(-2400, -300, 420, 640, &monitors), (-1920, -640));
    }

    #[test]
    fn clamp_keeps_the_saved_size_when_the_window_is_larger_than_the_monitor() {
        // 2400x1600 saved on a 1280x720 display: the size must survive, only the
        // corner moves, so the window still starts on screen.
        let monitors = [rect(0, 0, 1280, 720)];
        assert_eq!(clamp_position(3000, 2000, 2400, 1600, &monitors), (0, 0));
    }

    #[test]
    fn clamp_without_monitors_leaves_the_saved_position_alone() {
        assert_eq!(clamp_position(400, 300, 420, 640, &[]), (400, 300));
    }

    #[test]
    fn docked_width_is_clamped_to_the_resizer_bounds() {
        assert_eq!(clamped_docked_width(0), DOCKED_WIDTH_MIN);
        assert_eq!(clamped_docked_width(1), DOCKED_WIDTH_MIN);
        assert_eq!(clamped_docked_width(320), 320);
        assert_eq!(clamped_docked_width(99_999), DOCKED_WIDTH_MAX);
    }
}
