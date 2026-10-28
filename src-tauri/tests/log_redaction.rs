//! Guards ADR 012: `comnd.log` carries no account identifiers.
//!
//! CodeQL's `rust/cleartext-logging` query follows a tainted value, but it does
//! not treat a local file path as sensitive, so it missed the private-key path
//! that used to be logged at the key-auth lines. This test is the complementary
//! guard: it fails if a `log::` statement in the crate names an identifier that
//! must never be logged.
//!
//! Message text is ignored, so a literal such as `"password prompt"` does not
//! trip it. Only identifiers in code position count.

use std::fs;
use std::path::{Path, PathBuf};

/// Identifiers that must never be passed to a `log::` macro.
const FORBIDDEN: &[&str] = &["username", "key_path", "ssh_key_path", "password"];

fn is_ident(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}

fn is_ident_start(c: u8) -> bool {
    c.is_ascii_alphabetic() || c == b'_'
}

fn crate_sources() -> Vec<PathBuf> {
    fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
    }

    let mut out = Vec::new();
    collect(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut out);
    out.sort();
    out
}

/// Marks every byte as code (`true`) or as part of a string literal, character
/// literal or comment (`false`). Balancing macro arguments needs this: a `(`
/// inside a log message would otherwise end the statement early.
fn code_mask(src: &str) -> Vec<bool> {
    let b = src.as_bytes();
    let mut code = vec![true; b.len()];
    let mut i = 0;

    while i < b.len() {
        if b[i] == b'/' && b.get(i + 1) == Some(&b'/') {
            while i < b.len() && b[i] != b'\n' {
                code[i] = false;
                i += 1;
            }
            continue;
        }

        if b[i] == b'/' && b.get(i + 1) == Some(&b'*') {
            let mut j = i + 2;
            while j < b.len() && !(b[j] == b'*' && b.get(j + 1) == Some(&b'/')) {
                j += 1;
            }
            let end = (j + 2).min(b.len());
            for slot in code.iter_mut().take(end).skip(i) {
                *slot = false;
            }
            i = end;
            continue;
        }

        if b[i] == b'r' && (i == 0 || !is_ident(b[i - 1])) {
            let mut j = i + 1;
            let mut hashes = 0;
            while b.get(j) == Some(&b'#') {
                hashes += 1;
                j += 1;
            }
            if b.get(j) == Some(&b'"') {
                j += 1;
                while j < b.len() {
                    if b[j] == b'"' {
                        let mut k = j + 1;
                        let mut seen = 0;
                        while seen < hashes && b.get(k) == Some(&b'#') {
                            seen += 1;
                            k += 1;
                        }
                        if seen == hashes {
                            j = k;
                            break;
                        }
                    }
                    j += 1;
                }
                for slot in code.iter_mut().take(j.min(b.len())).skip(i) {
                    *slot = false;
                }
                i = j;
                continue;
            }
        }

        if b[i] == b'"' {
            let mut j = i + 1;
            while j < b.len() {
                if b[j] == b'\\' {
                    j += 2;
                    continue;
                }
                if b[j] == b'"' {
                    j += 1;
                    break;
                }
                j += 1;
            }
            for slot in code.iter_mut().take(j.min(b.len())).skip(i) {
                *slot = false;
            }
            i = j;
            continue;
        }

        // A character literal, but not a lifetime such as `'static`.
        if b[i] == b'\'' && i + 1 < b.len() {
            let close = if b[i + 1] == b'\\' { i + 3 } else { i + 2 };
            if close < b.len() && b[close] == b'\'' {
                for slot in code.iter_mut().take(close + 1).skip(i) {
                    *slot = false;
                }
                i = close + 1;
                continue;
            }
        }

        i += 1;
    }

    code
}

/// Every `log::<level>!(...)` statement, as `(line number, args start, args end)`.
/// The `!` is required so `use log::info;` and `log::set_logger(..)` are skipped.
fn log_statements(src: &str, code: &[bool]) -> Vec<(usize, usize, usize)> {
    let b = src.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;

    while i < b.len() {
        if !code[i] || !b[i..].starts_with(b"log::") {
            i += 1;
            continue;
        }

        let mut j = i + 5;
        while j < b.len() && code[j] && b[j].is_ascii_whitespace() {
            j += 1;
        }
        let name_start = j;
        while j < b.len() && code[j] && is_ident(b[j]) {
            j += 1;
        }
        if j == name_start {
            i += 1;
            continue;
        }
        while j < b.len() && code[j] && b[j].is_ascii_whitespace() {
            j += 1;
        }
        if b.get(j) != Some(&b'!') {
            i += 1;
            continue;
        }
        j += 1;
        while j < b.len() && code[j] && b[j].is_ascii_whitespace() {
            j += 1;
        }
        if b.get(j) != Some(&b'(') {
            i += 1;
            continue;
        }

        let start = j;
        let mut depth = 0usize;
        let mut k = j;
        while k < b.len() {
            if code[k] {
                if b[k] == b'(' {
                    depth += 1;
                } else if b[k] == b')' {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
            }
            k += 1;
        }

        let line = b[..i].iter().filter(|&&c| c == b'\n').count() + 1;
        out.push((line, start, k));
        i = k + 1;
    }

    out
}

/// Identifiers appearing in code position inside `start..end`.
fn identifiers_in(src: &str, code: &[bool], start: usize, end: usize) -> Vec<String> {
    let b = src.as_bytes();
    let mut out = Vec::new();
    let mut i = start;

    while i < end.min(b.len()) {
        if code[i] && is_ident_start(b[i]) {
            let from = i;
            while i < b.len() && code[i] && is_ident(b[i]) {
                i += 1;
            }
            out.push(src[from..i].to_string());
        } else {
            i += 1;
        }
    }

    out
}

#[test]
fn no_log_statement_names_an_account_identifier() {
    let mut failures = Vec::new();

    for path in crate_sources() {
        let src = fs::read_to_string(&path).expect("source file should be readable");
        let code = code_mask(&src);

        for (line, start, end) in log_statements(&src, &code) {
            for ident in identifiers_in(&src, &code, start, end) {
                if FORBIDDEN.contains(&ident.as_str()) {
                    failures.push(format!(
                        "{}:{} logs `{}`",
                        path.file_name().unwrap_or_default().to_string_lossy(),
                        line,
                        ident
                    ));
                }
            }
        }
    }

    assert!(
        failures.is_empty(),
        "account identifiers reach the app log (see \
         docs/adr/012-no-account-identifiers-in-app-log.md):\n  {}",
        failures.join("\n  ")
    );
}

#[test]
fn the_scan_finds_log_statements() {
    // Without this, a broken mask or matcher would make the guard above pass
    // vacuously on an empty statement list.
    let total: usize = crate_sources()
        .iter()
        .map(|path| {
            let src = fs::read_to_string(path).expect("source file should be readable");
            log_statements(&src, &code_mask(&src)).len()
        })
        .sum();

    assert!(
        total > 50,
        "expected the crate to contain many log statements, found {total} — the scanner is broken"
    );
}

#[test]
fn the_scanner_ignores_message_text_and_recognises_identifiers() {
    let src = r#"
log::info!("password prompt for {} [session {}]", addr, session_id);
log::warn!("Failed to load SSH key {}: {}", key_name, e);
log::error!("could not use {}", key_path);
use log::info;
log::set_max_level(level);
"#;
    let code = code_mask(src);
    let found: Vec<String> = log_statements(src, &code)
        .into_iter()
        .flat_map(|(_, start, end)| identifiers_in(src, &code, start, end))
        .filter(|ident| FORBIDDEN.contains(&ident.as_str()))
        .collect();

    // `password` appears only inside message text, so it must not be reported.
    // `key_path` is in code position, so it must be.
    assert_eq!(found, vec!["key_path".to_string()]);
}
