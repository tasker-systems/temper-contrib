//! A bound lens: a catalog spec plus a binding the core resolves. The lens
//! declares the spec and names which of its elements a read fills; the core
//! makes the read and fills that element's props as a function of the answer
//! alone — the same answer always yields the same props, and no agent stands
//! between the read and the view. The filled spec passes the core's own check
//! before it leaves, and the webview's gate again before it renders.
//!
//! One read is bound so far: `resource-list`, temper's resource listing,
//! which fills a Table.

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use temper_workflow::types::resource::{
    ResourceListParams, ResourceListResponse, ResourceSortField, SortOrder,
};

use crate::spec_check::check_spec;
use crate::temper::{RefResolution, TemperState};

/// Which element of the lens's spec a read fills, and which read.
#[derive(Debug, Deserialize)]
pub struct Binding {
    pub element: String,
    pub read: String,
}

/// What the listing is of: a query subject's narrowing, as the tab holds it.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListingSubject {
    pub context: Option<String>,
    pub doc_type: Option<String>,
    pub text: Option<String>,
}

/// Where the reader is in the listing: the page, and the order asked for.
#[derive(Debug, Default, Deserialize)]
pub struct ViewState {
    #[serde(default)]
    pub offset: i64,
    pub size: Option<i64>,
    pub sort: Option<Sort>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct Sort {
    pub key: String,
    pub order: Order,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Order {
    Asc,
    Desc,
}

/// temper-ui's page size for its vault grid.
pub const PAGE_SIZE: i64 = 50;
/// The most rows a Table carries (the catalog's `rows.maxItems`).
pub const PAGE_MAX: i64 = 100;
/// The most columns a Table carries (the catalog's `columns.maxItems`).
const COLUMNS_MAX: usize = 8;
/// The most values a facet lists (the catalog's `counts.maxItems`).
const FACET_VALUES_MAX: usize = 24;
const CELL_MAX: usize = 200;
const LIST_ITEM_MAX: usize = 60;
const LIST_ITEMS_MAX: usize = 12;
const HEADER_MAX: usize = 40;
const SCOPE_MAX: usize = 80;
const LABEL_MAX: usize = 60;

/// The listing's sortable columns, and the field temper orders each by.
fn sort_field(key: &str) -> Option<ResourceSortField> {
    Some(match key {
        "title" => ResourceSortField::Title,
        "context" => ResourceSortField::ContextName,
        "type" => ResourceSortField::DocTypeName,
        "stage" => ResourceSortField::Stage,
        "updated" => ResourceSortField::Updated,
        _ => return None,
    })
}

fn default_sort() -> Sort {
    Sort {
        key: "updated".into(),
        order: Order::Desc,
    }
}

fn given(v: &Option<String>) -> Option<String> {
    v.as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// The read a listing subject and view state ask for. A sort the listing
/// cannot order by is refused rather than quietly replaced.
pub fn listing_params(
    subject: &ListingSubject,
    view: &ViewState,
) -> Result<ResourceListParams, String> {
    let sort = view.sort.clone().unwrap_or_else(default_sort);
    let field = sort_field(&sort.key)
        .ok_or_else(|| format!("the listing cannot be ordered by {}", sort.key))?;
    Ok(ResourceListParams {
        context_ref: given(&subject.context),
        doc_type_name: given(&subject.doc_type),
        q: given(&subject.text),
        sort: Some(field),
        order: Some(match sort.order {
            Order::Asc => SortOrder::Asc,
            Order::Desc => SortOrder::Desc,
        }),
        limit: Some(view.size.unwrap_or(PAGE_SIZE).clamp(1, PAGE_MAX)),
        offset: Some(view.offset.max(0)),
        ..Default::default()
    })
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Text,
    Number,
    Date,
    Resource,
    Category,
    List,
}

#[derive(Debug, Serialize)]
struct Column {
    key: String,
    header: String,
    kind: Kind,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    sortable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
enum Cell {
    Text(String),
    Number(serde_json::Number),
    List(Vec<String>),
}

#[derive(Debug, Serialize)]
struct Page {
    offset: i64,
    size: i64,
    more: bool,
}

#[derive(Debug, Serialize)]
struct FacetCount {
    value: String,
    count: i64,
}

#[derive(Debug, Serialize)]
struct Facet {
    key: &'static str,
    label: &'static str,
    counts: Vec<FacetCount>,
    #[serde(skip_serializing_if = "Option::is_none")]
    active: Option<String>,
    #[serde(skip_serializing_if = "is_zero")]
    unlisted: usize,
}

fn is_zero(n: &usize) -> bool {
    *n == 0
}

/// A Table's props, as the catalog declares them.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TableProps {
    total: i64,
    scope: String,
    label: String,
    state: &'static str,
    columns: Vec<Column>,
    rows: Vec<BTreeMap<String, Cell>>,
    page: Page,
    #[serde(skip_serializing_if = "Option::is_none")]
    sort: Option<Sort>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    facets: Vec<Facet>,
    #[serde(skip_serializing_if = "is_zero")]
    fields_not_shown: usize,
}

/// A string cut to `max` characters, the cut shown — never silently.
fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut cut: String = s.chars().take(max - 1).collect();
        cut.push('…');
        cut
    }
}

/// A value that says nothing: absent, null, an empty string or an empty list.
/// A field only blank on a page is not one of the page's columns.
fn blank(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::String(s) => s.trim().is_empty(),
        Value::Array(items) => items.is_empty(),
        _ => false,
    }
}

fn scalar_text(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// How an `open_meta` field can be drawn, judged over every row that has it:
/// numbers, words, or a few short values. A field holding anything else
/// (an object, a list of objects) is not a column. A blank value says
/// nothing, so it does not decide the kind either.
fn field_kind<'a>(values: impl Iterator<Item = &'a Value>) -> Option<Kind> {
    let (mut list, mut number, mut text) = (false, false, false);
    for v in values.filter(|v| !blank(v)) {
        match v {
            Value::Number(_) => number = true,
            Value::String(_) | Value::Bool(_) => text = true,
            Value::Array(items) if items.iter().all(|i| scalar_text(i).is_some()) => list = true,
            _ => return None,
        }
    }
    Some(if list {
        Kind::List
    } else if number && !text {
        Kind::Number
    } else {
        Kind::Text
    })
}

fn field_cell(kind: &Kind, v: &Value) -> Option<Cell> {
    if blank(v) {
        return None;
    }
    match (kind, v) {
        (Kind::Number, Value::Number(n)) => Some(Cell::Number(n.clone())),
        (Kind::List, Value::Array(items)) => {
            let mut values: Vec<String> = items
                .iter()
                .filter_map(scalar_text)
                .map(|s| clip(&s, LIST_ITEM_MAX))
                .collect();
            if values.len() > LIST_ITEMS_MAX {
                let rest = values.len() - (LIST_ITEMS_MAX - 1);
                values.truncate(LIST_ITEMS_MAX - 1);
                values.push(format!("+{rest} more"));
            }
            Some(Cell::List(values))
        }
        (Kind::List, v) => scalar_text(v).map(|s| Cell::List(vec![clip(&s, LIST_ITEM_MAX)])),
        (_, v) => scalar_text(v).map(|s| Cell::Text(clip(&s, CELL_MAX))),
    }
}

/// One field's counts over the listing, most first (ties by value). A blank
/// value is not one a reader could pick out, so it is counted as unlisted.
fn facet(
    key: &'static str,
    label: &'static str,
    counts: &HashMap<String, i64>,
    active: Option<String>,
) -> Option<Facet> {
    if counts.is_empty() {
        return None;
    }
    let mut all: Vec<(&String, &i64)> = counts
        .iter()
        .filter(|(v, _)| !v.trim().is_empty())
        .collect();
    all.sort_by(|a, b| b.1.cmp(a.1).then_with(|| a.0.cmp(b.0)));
    let unlisted = counts.len() - all.len().min(FACET_VALUES_MAX);
    Some(Facet {
        key,
        label,
        counts: all
            .into_iter()
            .take(FACET_VALUES_MAX)
            .map(|(value, count)| FacetCount {
                value: clip(value, LIST_ITEM_MAX),
                count: *count,
            })
            .collect(),
        active: active.map(|a| clip(&a, LIST_ITEM_MAX)),
        unlisted,
    })
}

/// What the listing is of, in words: what `total` counts.
fn scope_words(subject: &ListingSubject) -> String {
    let mut words = vec!["resources".to_string()];
    if let Some(t) = given(&subject.doc_type) {
        words.push(format!("of type {t}"));
    }
    if let Some(c) = given(&subject.context) {
        words.push(format!("in {c}"));
    }
    if let Some(q) = given(&subject.text) {
        words.push(format!("matching “{q}”"));
    }
    clip(&words.join(" "), SCOPE_MAX)
}

/// A Table's props from a listing's answer — a function of the answer, the
/// subject it answers and the view it was asked in, nothing else.
///
/// The columns: Title; Context unless the listing is one context's; Type
/// unless it is one doc type's; Stage and Status when any row carries one;
/// Updated; then the `open_meta` fields the rows carry a value for, most
/// often first (ties by name), as many as fit. temper's own fields come first
/// so a wide row never scrolls them out of view. Fields that do not fit, or
/// cannot be drawn, are counted, not dropped unsaid; a field blank on every
/// row of the page is not a field of the page.
pub fn table_props(
    answer: &ResourceListResponse,
    subject: &ListingSubject,
    view: &ViewState,
) -> Value {
    let rows = &answer.rows;
    let sort = view.sort.clone().unwrap_or_else(default_sort);
    // The column the rows are ordered by is always drawn, so the order is always said.
    let sorted_by = |key: &str| sort.key == key;
    let one_context = given(&subject.context).is_some() && !sorted_by("context");
    let one_type = given(&subject.doc_type).is_some() && !sorted_by("type");

    let mut columns = vec![Column {
        key: "title".into(),
        header: "Title".into(),
        kind: Kind::Resource,
        sortable: true,
    }];
    if !one_context {
        columns.push(Column {
            key: "context".into(),
            header: "Context".into(),
            kind: Kind::Text,
            sortable: true,
        });
    }
    if !one_type {
        columns.push(Column {
            key: "type".into(),
            header: "Type".into(),
            kind: Kind::Category,
            sortable: true,
        });
    }
    let has_stage = sorted_by("stage") || rows.iter().any(|r| r.managed_meta.stage.is_some());
    let has_status = rows.iter().any(|r| r.managed_meta.status.is_some());
    if has_stage {
        columns.push(Column {
            key: "stage".into(),
            header: "Stage".into(),
            kind: Kind::Category,
            sortable: true,
        });
    }
    if has_status {
        columns.push(Column {
            key: "status".into(),
            header: "Status".into(),
            kind: Kind::Category,
            sortable: false,
        });
    }

    columns.push(Column {
        key: "updated".into(),
        header: "Updated".into(),
        kind: Kind::Date,
        sortable: true,
    });

    // Every open_meta field on the page, how many rows carry it.
    let mut presence: BTreeMap<&str, usize> = BTreeMap::new();
    for r in rows {
        if let Some(Value::Object(meta)) = &r.open_meta {
            for (k, _v) in meta.iter().filter(|(_, v)| !blank(v)) {
                *presence.entry(k.as_str()).or_default() += 1;
            }
        }
    }
    let mut ranked: Vec<(&str, usize)> = presence.iter().map(|(k, n)| (*k, *n)).collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    let room = COLUMNS_MAX.saturating_sub(columns.len());
    let mut fields: Vec<(&str, String, Kind)> = Vec::new();
    for (name, _) in &ranked {
        if fields.len() == room {
            break;
        }
        if name.trim().is_empty() || name.chars().count() > HEADER_MAX {
            continue;
        }
        let values = rows.iter().filter_map(|r| r.open_meta.as_ref()?.get(*name));
        if let Some(kind) = field_kind(values) {
            fields.push((name, format!("f{}", fields.len() + 1), kind));
        }
    }
    let fields_not_shown = ranked.len() - fields.len();
    for (name, key, kind) in &fields {
        columns.push(Column {
            key: key.clone(),
            header: (*name).to_string(),
            kind: kind.clone(),
            sortable: false,
        });
    }

    let table_rows = rows
        .iter()
        .map(|r| {
            let mut row = BTreeMap::new();
            // The bare id, not the decorated ref: a slug is as long as the title it comes from,
            // and the link resolves its title and address from temper either way.
            row.insert("title".to_string(), Cell::Text(r.id.0.to_string()));
            if !one_context {
                let home = r
                    .context_ref
                    .clone()
                    .or_else(|| r.cogmap_name.clone())
                    .or_else(|| r.context_name.clone());
                if let Some(home) = home {
                    row.insert("context".into(), Cell::Text(clip(&home, CELL_MAX)));
                }
            }
            if !one_type {
                row.insert("type".into(), Cell::Text(clip(&r.doc_type_name, CELL_MAX)));
            }
            if has_stage {
                if let Some(s) = &r.managed_meta.stage {
                    row.insert("stage".into(), Cell::Text(clip(s, CELL_MAX)));
                }
            }
            if has_status {
                if let Some(s) = &r.managed_meta.status {
                    row.insert("status".into(), Cell::Text(clip(s, CELL_MAX)));
                }
            }
            for (name, key, kind) in &fields {
                if let Some(cell) = r
                    .open_meta
                    .as_ref()
                    .and_then(|m| m.get(*name))
                    .and_then(|v| field_cell(kind, v))
                {
                    row.insert(key.clone(), cell);
                }
            }
            row.insert(
                "updated".into(),
                Cell::Text(r.updated.format("%Y-%m-%d %H:%MZ").to_string()),
            );
            row
        })
        .collect();

    let sort = columns.iter().any(|c| c.key == sort.key).then_some(sort);
    let size = answer
        .limit
        .unwrap_or(view.size.unwrap_or(PAGE_SIZE))
        .clamp(1, PAGE_MAX);

    let props = TableProps {
        total: answer.total,
        scope: scope_words(subject),
        label: clip(
            given(&subject.doc_type).as_deref().unwrap_or("resources"),
            LABEL_MAX,
        ),
        state: "present",
        columns,
        rows: table_rows,
        page: Page {
            offset: answer.offset,
            size,
            more: answer.truncated,
        },
        sort,
        facets: [
            facet(
                "type",
                "Type",
                &answer.facets.doc_type,
                given(&subject.doc_type),
            ),
            facet("stage", "Stage", &answer.facets.stage, None),
            facet("status", "Status", &answer.facets.status, None),
        ]
        .into_iter()
        .flatten()
        .collect(),
        fields_not_shown,
    };
    serde_json::to_value(props).expect("table props serialize")
}

/// The lens's spec with its bound element filled from the answer, checked.
pub fn fill(spec: &Value, binding: &Binding, props: Value) -> Result<Value, String> {
    let mut spec = spec.clone();
    let element = spec
        .get_mut("elements")
        .and_then(|e| e.get_mut(&binding.element))
        .ok_or_else(|| format!("the lens's spec has no element {}", binding.element))?;
    if element.get("type").and_then(Value::as_str) != Some("Table") {
        return Err(format!(
            "a {} read fills a Table, and {} is not one",
            binding.read, binding.element
        ));
    }
    element["props"] = props;
    check_spec(&spec)
        .map_err(|errors| format!("the filled view was refused: {}", errors.join("; ")))?;
    Ok(spec)
}

/// What the read said each row is, in the shape a reference resolves to: the
/// rows' title cells hold bare ids, and the listing already answered for them,
/// so the webview resolves them from this answer rather than reading each again.
pub fn row_resolutions(answer: &ResourceListResponse) -> Vec<RefResolution> {
    answer
        .rows
        .iter()
        .map(|r| RefResolution::Resolved {
            id: r.id.0.to_string(),
            title: r.title.clone(),
            doc_type: r.doc_type_name.clone(),
            context_ref: r.context_ref.clone(),
            decorated_ref: r.r#ref.clone(),
        })
        .collect()
}

/// Where the last page starts, when an answer's page starts past its end —
/// the listing shrank between the reader's last page and this one.
pub fn last_page_offset(answer: &ResourceListResponse) -> Option<i64> {
    let size = answer.limit.unwrap_or(PAGE_SIZE).max(1);
    (answer.offset > 0 && answer.rows.is_empty() && answer.offset >= answer.total)
        .then(|| (answer.total.max(1) - 1) / size * size)
}

/// A resolved bound lens: the filled, checked spec, and what the read said
/// each resource it names is.
#[derive(Debug, Serialize)]
pub struct Resolved {
    pub spec: Value,
    pub refs: Vec<RefResolution>,
}

/// Resolve a bound lens: make its read, fill its element, check the result.
#[tauri::command]
pub async fn lens_resolve(
    state: tauri::State<'_, TemperState>,
    spec: Value,
    binding: Binding,
    subject: ListingSubject,
    view: ViewState,
) -> Result<Resolved, String> {
    if binding.read != "resource-list" {
        return Err(format!("no read named {} can be bound", binding.read));
    }
    let mut params = listing_params(&subject, &view)?;
    let client = state
        .client()
        .ok_or_else(|| "temper is not connected".to_string())?;
    let mut answer = client
        .resources()
        .list_meta(&params)
        .await
        .map_err(|e| e.to_string())?;
    // The listing shrank since the page was asked for, and it now starts past the end:
    // show its last page rather than a page that says it holds rows it does not.
    if let Some(last) = last_page_offset(&answer) {
        params.offset = Some(last);
        answer = client
            .resources()
            .list_meta(&params)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(Resolved {
        spec: fill(&spec, &binding, table_props(&answer, &subject, &view))?,
        refs: row_resolutions(&answer),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(n: u32, doc_type: &str, meta: Value, managed: Value) -> Value {
        json!({
            "id": format!("01a0f73b-9ce3-74e0-a823-8ecb60bd{n:04}"),
            "ref": format!("row-{n}-01a0f73b-9ce3-74e0-a823-8ecb60bd{n:04}"),
            "title": format!("Row {n}"),
            "origin_uri": "",
            "context_ref": "+temper-dev/contrib",
            "doc_type_name": doc_type,
            "owner_handle": "someone",
            "owner_profile_id": "019d4add-f49d-7c43-a87d-dda470e5dd9c",
            "originator_profile_id": "019d4add-f49d-7c43-a87d-dda470e5dd9c",
            "is_active": true,
            "created": "2026-10-01T11:31:14Z",
            "updated": "2026-10-01T11:31:14Z",
            "managed_meta": managed,
            "open_meta": meta
        })
    }

    fn answer(rows: Vec<Value>, total: i64, offset: i64, limit: i64) -> ResourceListResponse {
        let returned = rows.len() as i64;
        serde_json::from_value(json!({
            "rows": rows,
            "total": total,
            "facets": {
                "doc_type": { "task": 40, "session": 11 },
                "stage": { "in-progress": 3, "backlog": 37 },
                "status": {}
            },
            "returned": returned,
            "truncated": offset + returned < total,
            "limit": limit,
            "offset": offset
        }))
        .expect("an answer deserializes")
    }

    fn spec() -> Value {
        json!({ "root": "table", "elements": { "table": { "type": "Table", "props": {}, "children": [] } } })
    }

    fn binding() -> Binding {
        Binding {
            element: "table".into(),
            read: "resource-list".into(),
        }
    }

    fn tasks(n: u32) -> Vec<Value> {
        (0..n)
            .map(|i| {
                row(
                    i,
                    "task",
                    json!({ "tags": ["ui", "table"], "estimate": 3 }),
                    json!({ "temper-stage": "backlog" }),
                )
            })
            .collect()
    }

    fn context_subject() -> ListingSubject {
        ListingSubject {
            context: Some("+temper-dev/contrib".into()),
            doc_type: Some("task".into()),
            text: None,
        }
    }

    #[test]
    fn the_same_answer_always_yields_the_same_props() {
        let a = answer(tasks(3), 51, 0, 3);
        let s = context_subject();
        let v = ViewState::default();
        assert_eq!(table_props(&a, &s, &v), table_props(&a, &s, &v));
    }

    #[test]
    fn a_page_of_fifty_out_of_fifty_one_says_more_follow() {
        let a = answer(tasks(50), 51, 0, 50);
        let props = table_props(&a, &context_subject(), &ViewState::default());
        assert_eq!(props["total"], 51);
        assert_eq!(
            props["page"],
            json!({ "offset": 0, "size": 50, "more": true })
        );
        let filled = fill(&spec(), &binding(), props).expect("the filled view passes the check");
        assert_eq!(
            filled["elements"]["table"]["props"]["rows"]
                .as_array()
                .unwrap()
                .len(),
            50
        );
    }

    #[test]
    fn the_last_page_says_nothing_follows() {
        let a = answer(tasks(1), 51, 50, 50);
        let props = table_props(&a, &context_subject(), &ViewState::default());
        assert_eq!(props["page"]["more"], false);
        fill(&spec(), &binding(), props).expect("the last page passes the check");
    }

    #[test]
    fn one_context_s_tasks_draw_title_stage_their_fields_and_updated() {
        let a = answer(tasks(2), 2, 0, 50);
        let props = table_props(&a, &context_subject(), &ViewState::default());
        let headers: Vec<&str> = props["columns"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["header"].as_str().unwrap())
            .collect();
        assert_eq!(headers, ["Title", "Stage", "Updated", "estimate", "tags"]);
        assert_eq!(props["rows"][0]["f2"], json!(["ui", "table"]));
        assert_eq!(props["rows"][0]["f1"], json!(3));
        assert_eq!(props["sort"], json!({ "key": "updated", "order": "desc" }));
        // The type facet counts the whole context and marks the type in view.
        assert_eq!(props["facets"][0]["active"], "task");
        assert_eq!(
            props["facets"][0]["counts"][0],
            json!({ "value": "task", "count": 40 })
        );
        // A histogram with nothing in it is not drawn.
        assert_eq!(props["facets"].as_array().unwrap().len(), 2);
        fill(&spec(), &binding(), props).expect("passes");
    }

    #[test]
    fn odd_values_from_temper_never_make_the_core_refuse_its_own_view() {
        let rows = vec![
            row(
                1,
                "task",
                json!({ "": "nameless", "   ": 2, "kind": ["a"] }),
                json!({ "temper-stage": "" }),
            ),
            row(2, "task", json!({ "kind": [] }), json!({})),
        ];
        let mut a = answer(rows, 2, 0, 50);
        a.facets.stage = HashMap::from([(String::new(), 1), ("done".into(), 1)]);
        let long_type = "t".repeat(90);
        a.facets.doc_type.insert(long_type.clone(), 1);
        let subject = ListingSubject {
            doc_type: Some(long_type),
            ..context_subject()
        };
        let props = table_props(&a, &subject, &ViewState::default());
        // The nameless fields are said, not drawn; the blank stage is counted, not listed.
        assert_eq!(props["fieldsNotShown"], 2);
        let stage = props["facets"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["key"] == "stage")
            .unwrap();
        assert_eq!(stage["unlisted"], 1);
        // A blank value does not make a list of what holds a list.
        assert_eq!(
            props["columns"].as_array().unwrap().last().unwrap()["kind"],
            "list"
        );
        fill(&spec(), &binding(), props).expect("passes");
    }

    #[test]
    fn the_column_the_rows_are_ordered_by_is_always_drawn() {
        let view = ViewState {
            sort: Some(Sort {
                key: "stage".into(),
                order: Order::Asc,
            }),
            ..Default::default()
        };
        let rows = vec![row(1, "note", json!({}), json!({}))];
        let props = table_props(&answer(rows, 1, 0, 50), &context_subject(), &view);
        assert_eq!(props["sort"], json!({ "key": "stage", "order": "asc" }));
        fill(&spec(), &binding(), props).expect("passes");
    }

    #[test]
    fn a_page_past_the_end_of_a_shrunken_listing_turns_to_its_last_page() {
        assert_eq!(last_page_offset(&answer(vec![], 49, 50, 50)), Some(0));
        assert_eq!(last_page_offset(&answer(vec![], 120, 150, 50)), Some(100));
        assert_eq!(last_page_offset(&answer(vec![], 0, 50, 50)), Some(0));
        assert_eq!(last_page_offset(&answer(vec![], 0, 0, 50)), None);
        assert_eq!(last_page_offset(&answer(tasks(1), 51, 50, 50)), None);
    }

    #[test]
    fn a_field_blank_on_every_row_is_not_a_column() {
        let rows = vec![
            row(
                1,
                "task",
                json!({ "tags": [], "note": "", "kind": "spike" }),
                json!({}),
            ),
            row(2, "task", json!({ "tags": null, "note": "  " }), json!({})),
        ];
        let props = table_props(
            &answer(rows, 2, 0, 50),
            &context_subject(),
            &ViewState::default(),
        );
        let headers: Vec<&str> = props["columns"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["header"].as_str().unwrap())
            .collect();
        assert_eq!(headers, ["Title", "Updated", "kind"]);
        assert!(props.get("fieldsNotShown").is_none());
        assert!(props["rows"][1].get("f1").is_none());
    }

    #[test]
    fn a_title_with_a_long_slug_still_fills_a_title_cell() {
        let mut long = row(1, "task", json!({}), json!({}));
        long["ref"] = json!(format!(
            "{}-{}",
            "word-".repeat(60),
            long["id"].as_str().unwrap()
        ));
        let props = table_props(
            &answer(vec![long.clone()], 1, 0, 50),
            &context_subject(),
            &ViewState::default(),
        );
        assert_eq!(props["rows"][0]["title"], long["id"]);
        fill(&spec(), &binding(), props).expect("passes");
    }

    #[test]
    fn a_mixed_listing_draws_context_and_type_and_counts_the_fields_that_do_not_fit() {
        let meta = json!({
            "a": 1, "b": 2, "c": 3, "d": 4, "e": 5, "nested": { "x": 1 }
        });
        let rows = vec![
            row(1, "task", meta.clone(), json!({ "temper-stage": "done" })),
            row(2, "goal", meta, json!({ "temper-status": "active" })),
        ];
        let props = table_props(
            &answer(rows, 2, 0, 50),
            &ListingSubject::default(),
            &ViewState::default(),
        );
        let headers: Vec<&str> = props["columns"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["header"].as_str().unwrap())
            .collect();
        assert_eq!(
            headers,
            ["Title", "Context", "Type", "Stage", "Status", "Updated", "a", "b"]
        );
        // c, d, e did not fit; `nested` cannot be drawn: all four are said.
        assert_eq!(props["fieldsNotShown"], 4);
        fill(&spec(), &binding(), props).expect("passes");
    }

    #[test]
    fn a_sort_the_listing_cannot_order_by_is_refused() {
        let view = ViewState {
            sort: Some(Sort {
                key: "f1".into(),
                order: Order::Asc,
            }),
            ..Default::default()
        };
        assert!(listing_params(&ListingSubject::default(), &view).is_err());
        let ok = ViewState {
            offset: 50,
            size: Some(500),
            sort: Some(Sort {
                key: "title".into(),
                order: Order::Asc,
            }),
        };
        let params = listing_params(&context_subject(), &ok).unwrap();
        assert_eq!(params.limit, Some(PAGE_MAX));
        assert_eq!(params.offset, Some(50));
        assert!(matches!(params.sort, Some(ResourceSortField::Title)));
        assert!(matches!(params.order, Some(SortOrder::Asc)));
    }

    #[test]
    fn a_binding_on_anything_but_a_table_is_refused() {
        let props = table_props(
            &answer(tasks(1), 1, 0, 50),
            &context_subject(),
            &ViewState::default(),
        );
        let not_a_table = json!({ "root": "t", "elements": { "t": { "type": "Text", "props": {}, "children": [] } } });
        assert!(fill(&not_a_table, &binding(), props.clone()).is_err());
        let missing = Binding {
            element: "nope".into(),
            read: "resource-list".into(),
        };
        assert!(fill(&spec(), &missing, props).is_err());
    }

    #[test]
    fn long_values_are_cut_visibly_and_long_lists_say_how_many_more() {
        let long = "x".repeat(300);
        let many: Vec<String> = (0..20).map(|i| format!("t{i}")).collect();
        let rows = vec![row(
            1,
            "task",
            json!({ "note": long, "tags": many }),
            json!({}),
        )];
        let props = table_props(
            &answer(rows, 1, 0, 50),
            &context_subject(),
            &ViewState::default(),
        );
        let note = props["rows"][0]["f1"].as_str().unwrap();
        assert_eq!(note.chars().count(), 200);
        assert!(note.ends_with('…'));
        let tags = props["rows"][0]["f2"].as_array().unwrap();
        assert_eq!(tags.len(), 12);
        assert_eq!(tags[11], "+9 more");
        fill(&spec(), &binding(), props).expect("passes");
    }

    /// The bound table from a live listing: a context's resources, then one doc type within
    /// it sorted by title, then its second page. Each filled view passes the core's check, and
    /// says whether more follow exactly as the answer did.
    /// Run locally: `TEMPER_WITNESS_CONTEXT=+team/slug cargo test -- --ignored a_live_listing`
    #[tokio::test]
    #[ignore = "requires temper credentials, network, and TEMPER_WITNESS_CONTEXT"]
    async fn a_live_listing_fills_a_table_the_check_admits() {
        let state = TemperState::connect();
        let client = state
            .client()
            .expect("machine temper credentials should resolve to a client");
        let context = std::env::var("TEMPER_WITNESS_CONTEXT")
            .expect("set TEMPER_WITNESS_CONTEXT to a context ref you can read");
        let cases = [
            (None, ViewState::default()),
            (
                Some("task"),
                ViewState {
                    sort: Some(Sort {
                        key: "title".into(),
                        order: Order::Asc,
                    }),
                    ..Default::default()
                },
            ),
            (
                Some("task"),
                ViewState {
                    offset: PAGE_SIZE,
                    ..Default::default()
                },
            ),
        ];
        for (doc_type, view) in cases {
            let subject = ListingSubject {
                context: Some(context.clone()),
                doc_type: doc_type.map(str::to_string),
                text: None,
            };
            let answer = client
                .resources()
                .list_meta(&listing_params(&subject, &view).unwrap())
                .await
                .expect("the listing reads");
            let props = table_props(&answer, &subject, &view);
            assert_eq!(props["page"]["more"], answer.truncated);
            assert_eq!(props["page"]["offset"], view.offset);
            assert_eq!(props["total"], answer.total);
            if let Ok(dir) = std::env::var("WITNESS_DUMP") {
                let name = format!(
                    "{dir}/props-{}-{}.json",
                    doc_type.unwrap_or("all"),
                    view.offset
                );
                std::fs::write(name, serde_json::to_string_pretty(&props).unwrap()).unwrap();
            }
            let filled = fill(&spec(), &binding(), props).unwrap_or_else(|e| panic!("{e}"));
            let table = &filled["elements"]["table"]["props"];
            eprintln!(
                "{doc_type:?} offset {}: {} of {} rows, columns {:?}, {} fields not shown",
                view.offset,
                table["rows"].as_array().map_or(0, Vec::len),
                table["total"],
                table["columns"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|c| c["header"].as_str().unwrap_or_default())
                    .collect::<Vec<_>>(),
                table
                    .get("fieldsNotShown")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
            );
        }
    }
}
