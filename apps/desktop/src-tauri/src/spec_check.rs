//! The core's own check of a presented spec, run before the spec is recorded.
//! The webview's `checkSpec` is the gate a view renders through; this is the
//! gate a record is written through, so a webview that answers `rendered`
//! for a spec it should have refused cannot get it durably recorded as
//! checked. It checks what `checkSpec` checks, from the same catalog file: the
//! closed shape and every element's props against the schema the server
//! advertises (compiled from the catalog), one bounded tree from `root`, and
//! the BoundedList counts JSON Schema cannot say.

use std::collections::HashSet;
use std::sync::OnceLock;

use serde_json::{json, Value};

use crate::present_server::{present_view_input_schema, CATALOG_JSON};

/// The bounds a view is held to, read from the catalog file `checkSpec`
/// reads them from: a view is a bounded glance. (Name length is in the
/// projected schema.)
#[derive(Clone, Copy)]
struct Limits {
    max_elements: usize,
    max_depth: usize,
}

fn limits() -> &'static Limits {
    static LIMITS: OnceLock<Limits> = OnceLock::new();
    LIMITS.get_or_init(|| {
        let catalog: Value =
            serde_json::from_str(CATALOG_JSON).expect("the bundled catalog parses");
        let bound = |name: &str| {
            catalog["limits"][name]
                .as_u64()
                .unwrap_or_else(|| panic!("the catalog declares limits.{name}"))
                as usize
        };
        Limits {
            max_elements: bound("maxElements"),
            max_depth: bound("maxDepth"),
        }
    })
}

/// The largest integer the webview's check admits (zod's `int`, bounded by
/// JavaScript's safe integers): a count past it is refused there, so here.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

const RESERVED_KEYS: [&str; 3] = ["__proto__", "constructor", "prototype"];

fn validator() -> &'static jsonschema::Validator {
    static VALIDATOR: OnceLock<jsonschema::Validator> = OnceLock::new();
    VALIDATOR.get_or_init(|| {
        jsonschema::validator_for(&present_view_input_schema())
            .expect("the projected catalog schema compiles")
    })
}

/// Every reason the spec fails, or `Ok` when it passes. Keeps going where
/// the shape allows it, so a refusal lists every reason, not the first.
pub fn check_spec(spec: &Value) -> Result<(), Vec<String>> {
    let mut errors: Vec<String> = validator()
        .iter_errors(&json!({ "spec": spec }))
        .map(|e| {
            let path = e.instance_path().to_string();
            let path = path.trim_start_matches("/spec").trim_start_matches('/');
            format!(
                "{}: {}",
                if path.is_empty() { "<root>" } else { path },
                e.masked()
            )
        })
        .collect();
    errors.extend(tree_errors(spec));
    errors.extend(bounded_list_errors(spec));
    let mut seen = HashSet::new();
    errors.retain(|e| seen.insert(e.clone()));
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

/// One tree from `root`: each element reached exactly once, none
/// unreachable, no cycle, within the bounds — a cycle or a shared child
/// multiplies a render without limit.
fn tree_errors(spec: &Value) -> Vec<String> {
    let Some(elements) = spec.get("elements").and_then(Value::as_object) else {
        return Vec::new();
    };
    let Limits {
        max_elements,
        max_depth,
    } = *limits();
    if elements.len() > max_elements {
        return vec![format!(
            "elements: {} elements, more than {max_elements}",
            elements.len()
        )];
    }
    let mut errors: Vec<String> = elements
        .keys()
        .filter(|k| RESERVED_KEYS.contains(&k.as_str()))
        .map(|k| format!("elements/{k}: a reserved name"))
        .collect();
    let root = match spec.get("root").and_then(Value::as_str) {
        Some(root) if elements.contains_key(root) => root,
        other => {
            errors.push(format!(
                "root: \"{}\" is not an element",
                other.unwrap_or("undefined")
            ));
            return errors;
        }
    };
    let mut reached: HashSet<&str> = HashSet::from([root]);
    let mut stack: Vec<(&str, usize)> = vec![(root, 1)];
    while let Some((key, depth)) = stack.pop() {
        if depth > max_depth {
            errors.push(format!("elements/{key}: nested deeper than {max_depth}"));
            continue;
        }
        let children = elements[key]
            .get("children")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        for child in children {
            let Some(child) = child.as_str().filter(|c| elements.contains_key(*c)) else {
                errors.push(format!(
                    "elements/{key}: names a child {child} that does not exist"
                ));
                continue;
            };
            if !reached.insert(child) {
                errors.push(format!(
                    "elements/{key}: \"{child}\" is already placed — a view is a tree"
                ));
                continue;
            }
            stack.push((child, depth + 1));
        }
    }
    errors.extend(
        elements
            .keys()
            .filter(|k| !reached.contains(k.as_str()))
            .map(|k| format!("elements/{k}: not reachable from root")),
    );
    errors
}

/// A BoundedList never shows more rows than it stands for, nor a different
/// number of rows than it has. Counts are read as numbers, not only as
/// `u64`: JSON Schema admits `5.0` and an integer past `u64` as integers, and
/// the webview reads both — a count this check skipped would pass a spec the
/// webview refuses.
fn bounded_list_errors(spec: &Value) -> Vec<String> {
    let Some(elements) = spec.get("elements").and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut errors = Vec::new();
    for (key, el) in elements {
        if el.get("type").and_then(Value::as_str) != Some("BoundedList") {
            continue;
        }
        let props = el.get("props");
        let count = |name: &str| props.and_then(|p| p.get(name)).and_then(Value::as_f64);
        let (Some(total), Some(shown)) = (count("total"), count("shown")) else {
            continue;
        };
        for (name, value) in [("total", total), ("shown", shown)] {
            if value > MAX_SAFE_INTEGER {
                errors.push(format!(
                    "elements/{key}/props/{name}: larger than {MAX_SAFE_INTEGER}"
                ));
            }
        }
        if shown > total {
            errors.push(format!("elements/{key}: shows {shown} of {total}"));
        }
        let present = props.and_then(|p| p.get("state")).and_then(Value::as_str) == Some("present");
        let rows = el
            .get("children")
            .and_then(Value::as_array)
            .map_or(0, Vec::len) as f64;
        if present && rows != shown {
            errors.push(format!(
                "elements/{key}: says it shows {shown} but has {rows} rows"
            ));
        }
    }
    errors
}

#[cfg(test)]
mod tests {
    use super::*;

    fn region(children: &[&str]) -> Value {
        json!({ "type": "RegionState", "props": { "state": "failed", "label": "history" }, "children": children })
    }

    fn errors_of(spec: Value) -> Vec<String> {
        check_spec(&spec).expect_err("the core should refuse this spec")
    }

    fn any_contains(errors: &[String], needle: &str) -> bool {
        errors.iter().any(|e| e.contains(needle))
    }

    #[test]
    fn a_conforming_spec_passes() {
        let spec = json!({ "root": "list", "elements": {
            "list": { "type": "BoundedList", "props": {
                "total": 4, "shown": 1, "scope": "in this context", "label": "sources", "state": "present"
            }, "children": ["ref"] },
            "ref": { "type": "ResourceRef", "props": { "id": "01a0d873-59c9-72f0-a31f-23f0da5d8789" }, "children": [] }
        } });
        assert_eq!(check_spec(&spec), Ok(()));
    }

    #[test]
    fn a_prop_the_catalog_does_not_declare_is_refused() {
        let errors = errors_of(json!({ "root": "r", "elements": { "r": {
            "type": "RegionState", "props": { "state": "failed", "label": "history", "colour": "red" }, "children": []
        } } }));
        assert!(any_contains(&errors, "elements/r"), "{errors:?}");
    }

    #[test]
    fn a_key_outside_the_closed_shape_is_refused() {
        let mut el = region(&[]);
        el["on"] = json!({ "press": { "action": "x" } });
        assert!(!errors_of(json!({ "root": "r", "elements": { "r": el } })).is_empty());
        let top = errors_of(json!({ "root": "r", "state": {}, "elements": { "r": region(&[]) } }));
        assert!(any_contains(&top, "<root>"), "{top:?}");
    }

    #[test]
    fn a_cycle_is_refused() {
        let errors = errors_of(json!({ "root": "a", "elements": { "a": region(&["a"]) } }));
        assert!(any_contains(&errors, "already placed"), "{errors:?}");
    }

    #[test]
    fn a_shared_child_is_refused() {
        let errors = errors_of(json!({ "root": "a", "elements": {
            "a": region(&["b", "b"]), "b": region(&[])
        } }));
        assert!(any_contains(&errors, "already placed"), "{errors:?}");
    }

    #[test]
    fn nesting_past_the_depth_bound_is_refused() {
        let mut elements = serde_json::Map::new();
        for i in 0..=limits().max_depth {
            let child = format!("e{}", i + 1);
            let children: Vec<&str> = if i < limits().max_depth {
                vec![&child]
            } else {
                vec![]
            };
            elements.insert(format!("e{i}"), region(&children));
        }
        let errors = errors_of(json!({ "root": "e0", "elements": elements }));
        assert!(any_contains(&errors, "nested deeper than"), "{errors:?}");
    }

    #[test]
    fn more_elements_than_the_bound_are_refused() {
        let elements: serde_json::Map<String, Value> = (0..=limits().max_elements)
            .map(|i| (format!("e{i}"), region(&[])))
            .collect();
        let errors = errors_of(json!({ "root": "e0", "elements": elements }));
        assert!(any_contains(&errors, "more than 256"), "{errors:?}");
    }

    #[test]
    fn an_unreachable_element_and_a_missing_child_are_refused() {
        let errors = errors_of(json!({ "root": "a", "elements": {
            "a": region(&["ghost"]), "loose": region(&[])
        } }));
        assert!(any_contains(&errors, "does not exist"), "{errors:?}");
        assert!(
            any_contains(&errors, "elements/loose: not reachable"),
            "{errors:?}"
        );
    }

    #[test]
    fn prototype_names_are_refused() {
        let errors = errors_of(json!({ "root": "constructor", "elements": {
            "constructor": region(&[])
        } }));
        assert!(any_contains(&errors, "a reserved name"), "{errors:?}");
        let typed = errors_of(json!({ "root": "a", "elements": { "a": {
            "type": "constructor", "props": {}, "children": []
        } } }));
        assert!(!typed.is_empty());
    }

    #[test]
    fn a_bounded_list_s_counts_must_agree() {
        let errors = errors_of(json!({ "root": "l", "elements": { "l": {
            "type": "BoundedList",
            "props": { "total": 1, "shown": 2, "scope": "s", "label": "l", "state": "present" },
            "children": []
        } } }));
        assert!(any_contains(&errors, "shows 2 of 1"), "{errors:?}");
        assert!(
            any_contains(&errors, "says it shows 2 but has 0 rows"),
            "{errors:?}"
        );
    }

    /// Counts JSON Schema admits as integers but `as_u64` does not read are
    /// still checked, as the webview checks them.
    #[test]
    fn a_bounded_list_s_counts_are_checked_whatever_their_json_form() {
        let list = |total: Value, shown: Value| {
            json!({ "root": "l", "elements": { "l": {
                "type": "BoundedList",
                "props": { "total": total, "shown": shown, "scope": "s", "label": "l", "state": "present" },
                "children": []
            } } })
        };
        let floats = errors_of(list(json!(1.0), json!(5.0)));
        assert!(any_contains(&floats, "shows 5 of 1"), "{floats:?}");
        assert!(any_contains(&floats, "but has 0 rows"), "{floats:?}");
        let huge: Value = serde_json::from_str("100000000000000000000").unwrap();
        let errors = errors_of(list(json!(1), huge));
        assert!(
            any_contains(&errors, "props/shown: larger than"),
            "{errors:?}"
        );
        assert_eq!(check_spec(&list(json!(3.0), json!(0.0))), Ok(()));
    }

    #[test]
    fn a_non_object_spec_is_refused() {
        assert!(check_spec(&json!("a view")).is_err());
        assert!(check_spec(&json!({ "root": "r" })).is_err());
    }

    /// The corpus the webview's `checkSpec` runs too (`catalog.test.ts`):
    /// the two gates are written twice, so each case pins a verdict both
    /// must give.
    #[test]
    fn the_shared_corpus_gets_the_verdicts_the_webview_gives() {
        let corpus: Value =
            serde_json::from_str(include_str!("../../src/lib/catalog/spec-fixtures.json"))
                .expect("the corpus parses");
        let cases = corpus["cases"].as_array().expect("the corpus has cases");
        assert!(!cases.is_empty());
        let wrong: Vec<String> = cases
            .iter()
            .filter(|c| check_spec(&c["spec"]).is_ok() != c["ok"].as_bool().unwrap())
            .map(|c| {
                format!(
                    "{} (expected ok={}, got {:?})",
                    c["name"],
                    c["ok"],
                    check_spec(&c["spec"])
                )
            })
            .collect();
        assert!(wrong.is_empty(), "verdicts that differ: {wrong:#?}");
    }
}
