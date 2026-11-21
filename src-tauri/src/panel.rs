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
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
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

/// Run `change` against the config store under one guard, so a read-modify-write
/// of one panel field cannot lose a concurrent write of another (the geometry
/// worker, a dock and a width save all run independently).
fn with_config<T>(
    app: &AppHandle,
    change: impl FnOnce(&mut crate::config::ConfigStore) -> Result<T, String>,
) -> Result<T, String> {
    let state = app.state::<AppState>();
    let mut guard = match state.config.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    change(&mut guard)
}

fn read_panel_config(app: &AppHandle) -> PanelConfig {
    let mut panel = with_config(app, |store| Ok(store.get().panel.clone())).unwrap_or_default();
    panel.docked_width = clamped_docked_width(panel.docked_width);
    panel
}

/// Persist only the window rectangle, leaving the home and docked width alone.
/// Called from the debounce worker and from the close path.
fn persist_geometry(app: &AppHandle, geometry: PanelWindowGeometry) -> Result<(), String> {
    with_config(app, |store| store.save_panel_geometry(Some(geometry)))
}

fn persist_undocked(app: &AppHandle, undocked: bool) -> Result<(), String> {
    with_config(app, |store| store.save_panel_undocked(undocked))
}

fn persist_docked_width(app: &AppHandle, width: u32) -> Result<(), String> {
    with_config(app, |store| store.save_panel_docked_width(width))
}

// ─── Window lifecycle ──────────────────────────────────────────────

/// Where a collected rectangle is written. Boxed so the saver's ordering rules
/// (stop, in-flight write, stale drop) are testable without a window or a config
/// file.
type PersistFn = Arc<dyn Fn(PanelWindowGeometry) + Send + Sync>;

/// Debounced geometry writer. Dragging emits one move event per pixel; this
/// coalesces them into at most one config write per `GEOMETRY_DEBOUNCE`, and the
/// close path flushes the live rectangle synchronously so quitting straight after
/// a drag cannot lose it.
struct GeometrySaver {
    pending: Arc<Mutex<Option<PanelWindowGeometry>>>,
    stop: Arc<AtomicBool>,
    /// Held by a write. The close path takes it after setting `stop`, so a
    /// rectangle the worker already collected cannot land *after* the final one.
    writes: Arc<Mutex<()>>,
}

impl GeometrySaver {
    fn start(app: &AppHandle) -> Self {
        let worker_app = app.clone();
        Self::with_persist(Arc::new(move |geometry| {
            // Debug builds can hold one write to prove the close paths behave
            // while a write is genuinely in flight; a release build has no gate.
            #[cfg(debug_assertions)]
            worker_app
                .state::<PanelGeometryWriter>()
                .debug_wait(geometry);
            if let Err(e) = persist_geometry(&worker_app, geometry) {
                log::warn!("Failed to save panel window geometry: {}", e);
            }
        }))
    }

    fn with_persist(persist: PersistFn) -> Self {
        let pending: Arc<Mutex<Option<PanelWindowGeometry>>> = Arc::new(Mutex::new(None));
        let stop = Arc::new(AtomicBool::new(false));
        let writes: Arc<Mutex<()>> = Arc::new(Mutex::new(()));
        let worker_pending = Arc::clone(&pending);
        let worker_stop = Arc::clone(&stop);
        let worker_writes = Arc::clone(&writes);
        std::thread::spawn(move || {
            while !worker_stop.load(Ordering::SeqCst) {
                std::thread::sleep(GEOMETRY_DEBOUNCE);
                let next = match worker_pending.lock() {
                    Ok(mut slot) => slot.take(),
                    Err(_) => None,
                };
                let Some(geometry) = next else { continue };
                let _writing = match worker_writes.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                // The window closed while this rectangle waited for the lock:
                // the close path has already saved the live one, and writing
                // this older value would undo it.
                if worker_stop.load(Ordering::SeqCst) {
                    continue;
                }
                persist(geometry);
            }
        });
        GeometrySaver { pending, stop, writes }
    }

    fn record(&self, geometry: PanelWindowGeometry) {
        if let Ok(mut slot) = self.pending.lock() {
            *slot = Some(geometry);
        }
    }

    /// Stop the debounce thread and wait for a write it already started, so the
    /// caller's own rectangle is the last one persisted. Idempotent: a second
    /// call waits on the same lock and returns once any write has finished.
    fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
        let _writing = match self.writes.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
    }
}

/// The live rectangle, or `None` when the window is already going away.
///
/// The close path must never fall back to `default_geometry`: a destroyed window
/// fails both queries, and substituting the default would overwrite the user's
/// saved rectangle with a centred one.
fn live_geometry(window: &WebviewWindow) -> Option<PanelWindowGeometry> {
    let position = window.outer_position().ok()?;
    let size = window.inner_size().ok()?;
    Some(PanelWindowGeometry {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    })
}

/// The geometry writer for the live panel window, plus the lock that serialises
/// closes. Registered while the window exists so every destruction path can stop
/// the writer before saving the final rectangle — including the programmatic
/// `destroy()` calls that Tauri routes around `CloseRequested`.
#[derive(Default)]
pub struct PanelGeometryWriter {
    saver: Mutex<Option<Arc<GeometrySaver>>>,
    /// Serialises the whole close path, not only the write.
    closing: Mutex<()>,
    /// Set once a close has claimed the window. `destroy()` reaches the event
    /// loop asynchronously, so `get_webview_window` keeps reporting the label for
    /// a moment afterwards; without this claim a second close would read a dying
    /// window and (before `live_geometry`) save the default rectangle.
    closed: AtomicBool,
    /// Debug-only: holds one worker write until a test releases it, so the smoke
    /// suite can start both close paths while a write is genuinely in flight. The
    /// worker sends the rectangle it actually took, not one the test guessed.
    #[cfg(debug_assertions)]
    gate: Mutex<Option<(std::sync::mpsc::Sender<PanelWindowGeometry>, std::sync::mpsc::Receiver<()>)>>,
    /// Debug-only: closes blocked acquiring `closing`.
    #[cfg(debug_assertions)]
    waiting: AtomicUsize,
    /// Debug-only: closes that found the write lock held, i.e. are queued behind
    /// an in-flight write.
    #[cfg(debug_assertions)]
    at_stop: AtomicUsize,
}

impl PanelGeometryWriter {
    fn install(&self, saver: Arc<GeometrySaver>) {
        let mut slot = match self.saver.lock() {
            Ok(slot) => slot,
            Err(poisoned) => poisoned.into_inner(),
        };
        *slot = Some(saver);
        // A new window has been built, so it may be closed again.
        self.closed.store(false, Ordering::SeqCst);
    }

    /// Enter the close path, or `None` when a close already claimed the window.
    /// Hold the returned guard until the final rectangle is written and the
    /// window destroyed.
    fn begin_close(&self) -> Option<MutexGuard<'_, ()>> {
        // Observe contention rather than announcing an intention: a thread that
        // only increments a counter can be descheduled before it ever blocks, so
        // the counter would not prove anything. `waiting` is raised only while a
        // close is actually queued on a guard another close holds.
        let guard = match self.closing.try_lock() {
            Ok(guard) => guard,
            Err(std::sync::TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
            Err(std::sync::TryLockError::WouldBlock) => {
                #[cfg(debug_assertions)]
                self.waiting.fetch_add(1, Ordering::SeqCst);
                let waited = match self.closing.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                #[cfg(debug_assertions)]
                self.waiting.fetch_sub(1, Ordering::SeqCst);
                waited
            }
        };
        if self.closed.load(Ordering::SeqCst) {
            return None;
        }
        Some(guard)
    }

    /// Claim the window for this close, before the destroy can reach the event
    /// loop. Idempotent.
    fn mark_closed(&self) {
        self.closed.store(true, Ordering::SeqCst);
    }

    /// Stop the writer, waiting out a write already in flight. The saver is kept
    /// rather than taken, so a second close still waits on the same lock instead
    /// of writing beside a write that is still in progress.
    fn stop(&self) {
        let saver = {
            let slot = match self.saver.lock() {
                Ok(slot) => slot,
                Err(poisoned) => poisoned.into_inner(),
            };
            slot.clone()
        };
        if let Some(saver) = saver {
            saver.stop();
        }
    }
}

#[cfg(debug_assertions)]
impl PanelGeometryWriter {
    /// Hold the next worker write at the gate. The worker signals `started` and
    /// blocks until `release` fires or the gate is dropped.
    fn debug_arm(
        &self,
        started: std::sync::mpsc::Sender<PanelWindowGeometry>,
        release: std::sync::mpsc::Receiver<()>,
    ) {
        let mut slot = match self.gate.lock() {
            Ok(slot) => slot,
            Err(poisoned) => poisoned.into_inner(),
        };
        *slot = Some((started, release));
        // Counters are per-race, so a second run proves its own sequence.
        self.waiting.store(0, Ordering::SeqCst);
        self.at_stop.store(0, Ordering::SeqCst);
    }

    /// Called by the close path just before it stops the writer. The counter is
    /// raised only when the write lock is actually held, so it records a close
    /// queued behind an in-flight write rather than one that merely reached the
    /// call.
    fn debug_note_stop(&self) {
        let saver = {
            let slot = match self.saver.lock() {
                Ok(slot) => slot,
                Err(poisoned) => poisoned.into_inner(),
            };
            slot.clone()
        };
        if let Some(saver) = saver {
            if saver.writes.try_lock().is_err() {
                self.at_stop.fetch_add(1, Ordering::SeqCst);
            }
        }
    }

    /// (closes queued on the guard, closes queued behind a write).
    fn debug_close_state(&self) -> (usize, usize) {
        (
            self.waiting.load(Ordering::SeqCst),
            self.at_stop.load(Ordering::SeqCst),
        )
    }

    /// Drop an armed gate, unblocking a worker that is waiting on it.
    fn debug_disarm(&self) {
        let mut slot = match self.gate.lock() {
            Ok(slot) => slot,
            Err(poisoned) => poisoned.into_inner(),
        };
        *slot = None;
    }

    /// Called by the worker immediately before it writes. Sends the rectangle it
    /// actually took, then blocks while a test holds the gate — which is what
    /// makes "a write in flight" observable.
    fn debug_wait(&self, geometry: PanelWindowGeometry) {
        let gate = {
            let mut slot = match self.gate.lock() {
                Ok(slot) => slot,
                Err(poisoned) => poisoned.into_inner(),
            };
            slot.take()
        };
        if let Some((started, release)) = gate {
            started.send(geometry).ok();
            // A dropped receiver also releases the worker, so a failed test cannot
            // wedge it.
            release.recv().ok();
        }
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
    app.state::<PanelGeometryWriter>().install(Arc::clone(&saver));
    // The latest known rectangle: a move event carries only the position and a
    // resize event only the size, so the two are merged here.
    let latest = Arc::new(Mutex::new(initial));
    let close_app = app.clone();
    let move_saver = Arc::clone(&saver);
    let size_saver = Arc::clone(&saver);
    let destroy_app = app.clone();

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
            // Same flush-and-destroy path programmatic closes use, so the last
            // move is saved whether the user or the app closes the window.
            if let Err(e) = close_panel_window(&close_app) {
                log::warn!("Failed to close the panel window: {}", e);
            }
            if let Err(e) = close_app.emit_to("main", PANEL_CLOSED_EVENT, ()) {
                log::warn!("Failed to report panel close to the main window: {}", e);
            }
        }
        WindowEvent::Destroyed => destroy_app.state::<PanelGeometryWriter>().stop(),
        _ => {}
    });
}

/// Close the panel window if one exists. Safe to call when there is none.
///
/// The final rectangle is read from the live window and saved here: Tauri's
/// `destroy()` bypasses `CloseRequested`, so docking, the panel's Close button
/// and app shutdown would otherwise drop a move the debounce worker had not
/// written yet.
fn close_panel_window(app: &AppHandle) -> Result<(), String> {
    let writer = app.state::<PanelGeometryWriter>();
    // Claim the window before anything else. Two closes must not both keep a
    // handle: `destroy()` reaches the event loop asynchronously, so the label
    // stays listed for a moment and the second close would read a dying window.
    let Some(_closing) = writer.begin_close() else {
        return Ok(());
    };
    let Some(window) = app.get_webview_window(PANEL_LABEL) else {
        writer.mark_closed();
        return Ok(());
    };
    let Some(geometry) = live_geometry(&window) else {
        // Already being destroyed: there is nothing to record, and the default
        // fallback must never overwrite the user's rectangle.
        writer.mark_closed();
        return Ok(());
    };
    // Stop the worker *before* writing: waiting out a write already in flight
    // means it cannot land after this rectangle and undo it.
    #[cfg(debug_assertions)]
    writer.debug_note_stop();
    writer.stop();
    if let Err(e) = persist_geometry(app, geometry) {
        log::warn!("Failed to save panel window geometry before closing: {}", e);
    }
    writer.mark_closed();
    window.destroy().map_err(|e| e.to_string())
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
///
/// The write comes first: if it fails the home is unchanged and the window stays
/// where the user can still reach it, rather than the frontend claiming a dock
/// the config does not have.
#[tauri::command]
pub async fn panel_set_undocked(app: AppHandle, undocked: bool) -> Result<(), String> {
    persist_undocked(&app, undocked)?;
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
    persist_docked_width(&app, width)?;
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
    // Frameless, like the main window: the header the panel already draws is
    // its drag region. Decorations stay off but `shadow` keeps its default, so
    // the DWM frame still supplies the resize borders and the drop shadow.
    let window = WebviewWindowBuilder::new(&app, PANEL_LABEL, WebviewUrl::App("index.html".into()))
        .title("Comnd Panel")
        .inner_size(DEFAULT_WINDOW_WIDTH as f64, DEFAULT_WINDOW_HEIGHT as f64)
        .min_inner_size(MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)
        .resizable(true)
        .decorations(false)
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
    // A window that has never been shown is still measured against the default
    // captioned frame, so the `set_size` above leaves the client area too tall on
    // Windows — 43 px at 150% scale here, the difference between the captioned
    // and undecorated frame heights. Showing settles the frame; re-applying the
    // saved rectangle then lands exactly, and is skipped when the first call was
    // already right.
    let restored = window.inner_size().map(|s| (s.width, s.height)).ok();
    if restored != Some((saved.width, saved.height)) {
        window
            .set_size(PhysicalSize::new(saved.width, saved.height))
            .map_err(|e| e.to_string())?;
    }

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

/// Move and resize the panel window. Deliberately does *not* write the config:
/// the production `Moved`/`Resized` tracker owns that, so the relaunch scenario
/// proves the path the user's own drag takes.
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
        .map_err(|e| e.to_string())
}

/// What `test_panel_race_close` observed: the rectangle the close paths saved, the
/// window's real rectangle when the race started, and the stale rectangle the
/// worker was paused on.
#[cfg(debug_assertions)]
#[derive(Debug, Clone, serde::Serialize)]
pub struct PanelCloseRaceReport {
    pub saved: PanelWindowGeometry,
    pub live: PanelWindowGeometry,
    pub stale: PanelWindowGeometry,
}

/// Close the panel window twice at the same time while a worker write is held,
/// then let the write finish, and report what the close paths saved.
///
/// Debug only. The sequence is made observable rather than hoped for:
///  * rectangle A is recorded and the worker is paused inside that write;
///  * the window is then moved to a distinct rectangle B, so the paused write is
///    a *stale* value that must not win;
///  * both close paths start, and the test waits for signals showing one is at
///    `stop()` (blocked on the paused write) and the other is queued on the
///    close guard;
///  * only then is the write released.
#[cfg(debug_assertions)]
#[tauri::command]
pub async fn test_panel_race_close(app: AppHandle) -> Result<PanelCloseRaceReport, String> {
    let writer = app.state::<PanelGeometryWriter>();
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();

    let window = app
        .get_webview_window(PANEL_LABEL)
        .ok_or_else(|| "The panel window is not open".to_string())?;
    let start = live_geometry(&window)
        .ok_or_else(|| "The panel window has no readable geometry".to_string())?;

    // Arm the gate, then move so the tracker has a rectangle to write.
    writer.debug_arm(started_tx, release_rx);
    window
        .set_position(PhysicalPosition::new(start.x + 2, start.y + 2))
        .map_err(|e| e.to_string())?;

    // The worker sends the rectangle it actually took, so "stale" is what is
    // really paused rather than a value this command guessed.
    let stale = match started_rx.recv_timeout(GEOMETRY_DEBOUNCE * 4) {
        Ok(geometry) => geometry,
        Err(_) => {
            writer.debug_disarm();
            return Err("The geometry worker never reached the paused write".to_string());
        }
    };

    // B: a rectangle far enough from A that a stale write cannot pass for it.
    let target = PanelWindowGeometry {
        x: start.x + 40,
        y: start.y + 40,
        ..start
    };
    window
        .set_position(PhysicalPosition::new(target.x, target.y))
        .map_err(|e| e.to_string())?;
    let mut live = None;
    let settle = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < settle {
        if let Some(current) = live_geometry(&window) {
            if current.x == target.x && current.y == target.y {
                live = Some(current);
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let Some(live) = live else {
        let _ = release_tx.send(());
        return Err("The panel window never moved to the second rectangle".to_string());
    };

    let first = app.clone();
    let second = app.clone();
    let a = std::thread::spawn(move || close_panel_window(&first));
    let b = std::thread::spawn(move || close_panel_window(&second));

    // Wait for the sequence, not for a sleep: one close must have reached
    // `stop()` (it blocks there, because the paused write holds the lock) and the
    // other must be queued on the guard.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        let (waiting, at_stop) = writer.debug_close_state();
        if waiting >= 1 && at_stop >= 1 {
            break;
        }
        if std::time::Instant::now() > deadline {
            let _ = release_tx.send(());
            let _ = a.join();
            let _ = b.join();
            return Err(format!(
                "The close paths never overlapped the paused write (waiting {}, at stop {})",
                waiting, at_stop
            ));
        }
        std::thread::sleep(Duration::from_millis(5));
    }

    let _ = release_tx.send(());
    a.join().map_err(|_| "The first close panicked".to_string())??;
    b.join().map_err(|_| "The second close panicked".to_string())??;
    let saved = read_panel_config(&app)
        .window
        .ok_or_else(|| "The close paths saved no geometry".to_string())?;
    Ok(PanelCloseRaceReport { saved, live, stale })
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

    fn geometry(x: i32, y: i32, width: u32, height: u32) -> PanelWindowGeometry {
        PanelWindowGeometry { x, y, width, height }
    }

    /// A saver whose writes land in `sink`, so the ordering rules can be driven
    /// without a window or a config file.
    fn saver_into(sink: Arc<Mutex<Vec<PanelWindowGeometry>>>) -> Arc<GeometrySaver> {
        Arc::new(GeometrySaver::with_persist(Arc::new(move |geometry| {
            sink.lock().unwrap().push(geometry);
        })))
    }

    fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !done() {
            assert!(
                std::time::Instant::now() < deadline,
                "timed out waiting for {}",
                what
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn a_rectangle_collected_before_stop_is_not_written_after_it() {
        let written = Arc::new(Mutex::new(Vec::new()));
        let saver = saver_into(Arc::clone(&written));

        // Hold the write lock so the worker has to queue behind it with the
        // rectangle already collected.
        let blocked = saver.writes.lock().unwrap();
        saver.record(geometry(10, 20, 300, 400));
        wait_until("the worker to collect the rectangle", || {
            saver.pending.lock().unwrap().is_none()
        });

        let stopper = {
            let saver = Arc::clone(&saver);
            std::thread::spawn(move || saver.stop())
        };
        // stop() cannot return while a write holds the lock.
        std::thread::sleep(Duration::from_millis(100));
        assert!(!stopper.is_finished(), "stop() returned with a write in flight");

        drop(blocked);
        stopper.join().unwrap();
        assert!(
            written.lock().unwrap().is_empty(),
            "a rectangle collected before stop() was written afterwards"
        );
    }

    #[test]
    fn a_rectangle_recorded_after_stop_is_never_written() {
        let written = Arc::new(Mutex::new(Vec::new()));
        let saver = saver_into(Arc::clone(&written));
        saver.stop();
        saver.record(geometry(1, 2, 3, 4));
        std::thread::sleep(GEOMETRY_DEBOUNCE * 2);
        assert!(
            written.lock().unwrap().is_empty(),
            "the worker kept writing after stop()"
        );
    }

    #[test]
    fn close_paths_are_serialised() {
        let writer = Arc::new(PanelGeometryWriter::default());
        let held = writer
            .begin_close()
            .expect("the first close must claim the window");
        let (tx, rx) = std::sync::mpsc::channel();
        let second = {
            let writer = Arc::clone(&writer);
            std::thread::spawn(move || {
                let guard = writer.begin_close();
                tx.send(guard.is_some()).unwrap();
            })
        };
        assert!(
            rx.recv_timeout(Duration::from_millis(150)).is_err(),
            "a second close entered the path while the first was still running"
        );
        // The real close marks the window before it drops the guard.
        writer.mark_closed();
        drop(held);
        let ran = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("the second close never ran after the first released");
        assert!(!ran, "the second close claimed a window the first had closed");
        second.join().unwrap();
    }

    #[test]
    fn a_claimed_window_is_not_closed_twice() {
        // `destroy()` reaches the event loop asynchronously, so the label stays
        // listed for a moment: the claim is what stops the second close reading a
        // dying window and saving the default rectangle.
        let writer = PanelGeometryWriter::default();
        let first = writer
            .begin_close()
            .expect("the first close must claim the window");
        drop(first);
        writer.mark_closed();
        assert!(
            writer.begin_close().is_none(),
            "a claimed window was handed to a second close"
        );
    }

    #[test]
    fn a_rebuilt_window_can_be_closed_again() {
        let writer = PanelGeometryWriter::default();
        writer.mark_closed();
        assert!(writer.begin_close().is_none());

        let written = Arc::new(Mutex::new(Vec::new()));
        let saver = saver_into(Arc::clone(&written));
        writer.install(Arc::clone(&saver));
        assert!(
            writer.begin_close().is_some(),
            "a rebuilt window must be closeable"
        );
        saver.stop();
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
