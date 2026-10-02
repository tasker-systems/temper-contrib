//! A bound lens: a catalog spec plus a binding the core resolves. The lens
//! declares the spec and names which of its elements a read fills; the core
//! makes the read and fills that element's props as a function of the answer
//! alone — the same answer always yields the same props, and no agent stands
//! between the read and the view. The filled spec passes the core's own check
//! before it leaves, and the webview's gate again before it renders.
//!
//! Two reads are bound: `resource-list`, temper's resource listing, which
//! fills a Table; and `graph`, temper's graph reads — a walk from one
//! resource, or an entry read anchored at a context — which fill a Graph.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use temper_client::TemperClient;
use temper_core::types::graph::{EdgeKind, Polarity};
use temper_core::types::graph_atlas::{
    clamp_traversal_depth, AtlasEdge, AtlasEntry, AtlasNode, AtlasSubgraph, NodeHome,
};
use temper_workflow::types::resource::{
    ResourceListParams, ResourceListResponse, ResourceSortField, SortOrder,
};
use uuid::Uuid;

use crate::present_server::CATALOG_JSON;
use crate::spec_check::check_spec;
use crate::temper::{parse_ref, RefResolution, TemperState};

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

/// What the lens is bound to, as the webview holds it: a query's narrowing,
/// or the neighbourhood a graph read walks from.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum LensSubject {
    #[serde(rename_all = "camelCase")]
    Query {
        #[serde(flatten)]
        listing: ListingSubject,
    },
    #[serde(rename_all = "camelCase")]
    Neighbourhood { id: String, depth: i32 },
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
/// How many of a page's fields are weighed for its columns, most often present
/// first; the rest are counted as not shown without being read.
const FIELD_CANDIDATES_MAX: usize = 32;
/// A graph node's own words, cut to the catalog's maxima: the label a node is
/// carried by, the excerpt beside it, the stage and home and edge label.
const NODE_LABEL_MAX: usize = 120;
const EXCERPT_MAX: usize = 200;
const STAGE_MAX: usize = 20;
const HOME_MAX: usize = 120;
const KIND_MAX: usize = 40;
const EDGE_LABEL_MAX: usize = 40;
/// The draw an entry read applies when asked with none — the server's default,
/// stated in the arm as the k actually applied.
const ENTRY_K: i64 = 130;

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
    for (name, _) in ranked.iter().take(FIELD_CANDIDATES_MAX) {
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

/// The Graph's bounds and doc-type tints, read from the same bundled catalog
/// file the checks read: the numbers a view is held to are the catalog's,
/// never restated, and a tint is only ever a role the catalog names.
struct GraphCatalog {
    nodes_max: usize,
    edges_max: usize,
    tints: HashSet<String>,
}

fn graph_catalog() -> &'static GraphCatalog {
    static CATALOG: OnceLock<GraphCatalog> = OnceLock::new();
    CATALOG.get_or_init(|| {
        let catalog: Value =
            serde_json::from_str(CATALOG_JSON).expect("the bundled catalog parses");
        let graph = &catalog["components"]["Graph"]["props"]["properties"];
        let tints = graph["nodes"]["items"]["properties"]["tint"]["enum"]
            .as_array()
            .expect("the catalog names the graph's tints")
            .iter()
            .map(|t| t.as_str().expect("a tint is a word").to_string())
            .collect();
        GraphCatalog {
            nodes_max: graph["nodes"]["maxItems"]
                .as_u64()
                .expect("the catalog bounds the graph's nodes") as usize,
            edges_max: graph["edges"]["maxItems"]
                .as_u64()
                .expect("the catalog bounds the graph's edges") as usize,
            tints,
        }
    })
}

/// A graph read and what it was asked at — what `graph_props` fills from. The
/// homes map is the one contexts read a resolve makes, passed in, so the props
/// stay a function of the answer and the arm alone.
enum GraphRead {
    Walk {
        seed: String,
        depth: i32,
        answer: AtlasSubgraph,
    },
    Entry {
        context: String,
        anchor: Uuid,
        answer: AtlasEntry,
    },
}

impl GraphRead {
    /// How many nodes the answer stood for, before any cut.
    fn answer_nodes_len(&self) -> usize {
        match self {
            GraphRead::Walk { answer, .. } => answer.nodes.len(),
            GraphRead::Entry { answer, .. } => answer.nodes.len(),
        }
    }
}

/// The graph read a subject asks for: a neighbourhood walks from its resource,
/// a query naming a context takes the entry read at that context. The walk's
/// depth clamps through the traversal's own clamp — never restated here.
async fn graph_read(
    client: &TemperClient,
    subject: LensSubject,
    homes: &HashMap<Uuid, String>,
) -> Result<GraphRead, String> {
    match subject {
        LensSubject::Query { listing } => {
            let context = given(&listing.context)
                .ok_or_else(|| "a graph read needs a context to enter".to_string())?;
            let anchor = context_anchor(&context, homes)?;
            let answer = client
                .graph()
                .entry(&[anchor], None)
                .await
                .map_err(|e| e.to_string())?;
            Ok(GraphRead::Entry {
                context,
                anchor,
                answer,
            })
        }
        LensSubject::Neighbourhood { id, depth } => {
            let seed = parse_ref(&id).ok_or_else(|| format!("{id} does not name a resource"))?;
            let depth = clamp_traversal_depth(depth);
            let answer = client
                .graph()
                .traverse(&[seed], Some(depth))
                .await
                .map_err(|e| e.to_string())?;
            Ok(GraphRead::Walk {
                seed: seed.to_string(),
                depth,
                answer,
            })
        }
    }
}

/// The context a ref names, from the words the one contexts read built —
/// `{owner_ref}/{slug}` per row. A ref no row names is refused rather than
/// walked without an anchor.
fn context_anchor(named: &str, homes: &HashMap<Uuid, String>) -> Result<Uuid, String> {
    homes
        .iter()
        .find(|(_, words)| words.as_str() == named)
        .map(|(id, _)| *id)
        .ok_or_else(|| format!("no context named {named} can be read"))
}

/// What the catalog's bounds clipped off the answer, each count said only
/// when some were.
#[derive(Debug, Serialize)]
struct Cut {
    #[serde(skip_serializing_if = "Option::is_none")]
    nodes: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    edges: Option<i64>,
}

/// What an entry read says it drew, verbatim.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Bounds {
    drawn: i32,
    eligible: i32,
    in_scope: i32,
    truncated: bool,
}

/// Where the view was read from.
#[derive(Debug, Serialize)]
#[serde(tag = "read", rename_all = "kebab-case")]
enum Arm {
    Walk { from: Vec<String>, depth: i32 },
    Entry { r#in: Vec<String>, k: i64 },
}

/// One drawn node, as the catalog declares it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GraphNodeProps {
    id: String,
    label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tint: Option<String>,
    r#ref: String,
    corpus_degree: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    excerpt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    updated: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    home: Option<String>,
    home_kind: &'static str,
}

/// One drawn edge, as the catalog declares it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GraphEdgeProps {
    source: String,
    target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    edge_kind: EdgeKind,
    polarity: Polarity,
    weight: f64,
}

/// A Graph's props, as the catalog declares them.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GraphProps {
    total: i64,
    scope: String,
    label: &'static str,
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    arm: Option<Arm>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bounds: Option<Bounds>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cut: Option<Cut>,
    nodes: Vec<GraphNodeProps>,
    edges: Vec<GraphEdgeProps>,
}

/// The answer cut to the catalog's bounds: the first nodes in answer order,
/// then the edges among kept nodes, first edges — and what fell off, each
/// count only when some did.
fn cut_to_bounds(
    nodes: &[AtlasNode],
    edges: &[AtlasEdge],
) -> (Vec<AtlasNode>, Vec<AtlasEdge>, Option<Cut>) {
    let cat = graph_catalog();
    let kept: Vec<AtlasNode> = nodes.iter().take(cat.nodes_max).cloned().collect();
    let nodes_cut = nodes.len().saturating_sub(kept.len());
    let kept_ids: HashSet<Uuid> = kept.iter().map(|n| n.id).collect();
    let among: Vec<&AtlasEdge> = edges
        .iter()
        .filter(|e| kept_ids.contains(&e.source) && kept_ids.contains(&e.target))
        .collect();
    let drawn: Vec<AtlasEdge> = among
        .iter()
        .take(cat.edges_max)
        .map(|e| (*e).clone())
        .collect();
    let edges_cut = among.len().saturating_sub(drawn.len());
    let cut = (nodes_cut > 0 || edges_cut > 0).then(|| Cut {
        nodes: (nodes_cut > 0).then_some(nodes_cut as i64),
        edges: (edges_cut > 0).then_some(edges_cut as i64),
    });
    (kept, drawn, cut)
}

/// One node's props: the answer's own words, clipped to the catalog's maxima.
/// The bare id names the node and is its ref; the home is the anchor's words
/// when the one contexts read names it, else the anchor's bare id — a
/// cogmap-homed node always falls back, the contexts read cannot name one.
fn graph_node(node: &AtlasNode, homes: &HashMap<Uuid, String>) -> GraphNodeProps {
    let tint = node
        .doc_type
        .as_deref()
        .filter(|t| graph_catalog().tints.contains(&format!("doctype-{t}")))
        .map(|t| format!("doctype-{t}"));
    GraphNodeProps {
        id: node.id.to_string(),
        label: clip(&node.title, NODE_LABEL_MAX),
        kind: node.doc_type.as_deref().map(|t| clip(t, KIND_MAX)),
        tint,
        r#ref: node.id.to_string(),
        corpus_degree: node.degree,
        excerpt: node.excerpt.as_deref().map(|e| clip(e, EXCERPT_MAX)),
        stage: node.stage.as_deref().map(|s| clip(s, STAGE_MAX)),
        updated: node
            .updated
            .map(|u| u.format("%Y-%m-%dT%H:%MZ").to_string()),
        home: node.home_id.map(|id| {
            let words = homes.get(&id).cloned().unwrap_or_else(|| id.to_string());
            clip(&words, HOME_MAX)
        }),
        home_kind: match node.home {
            NodeHome::Context => "context",
            NodeHome::Cogmap => "cogmap",
        },
    }
}

fn graph_edge(edge: &AtlasEdge) -> GraphEdgeProps {
    GraphEdgeProps {
        source: edge.source.to_string(),
        target: edge.target.to_string(),
        label: edge.label.as_deref().map(|l| clip(l, EDGE_LABEL_MAX)),
        edge_kind: edge.edge_kind,
        polarity: edge.polarity,
        weight: edge.weight,
    }
}

/// A Graph's props from a graph read's answer — a function of the answer, the
/// read it answers and the one contexts read, nothing else.
///
/// The nodes and edges are the answer's, cut to the catalog's bounds when the
/// answer exceeds them. A walk says where it went and how deep; it carries no
/// bounds — deeper was not reported, and there is no denominator. An entry
/// read carries the bounds it was given. An answer that drew nothing names
/// nothing it does not draw: no arm, no cut.
fn graph_props(read: &GraphRead, homes: &HashMap<Uuid, String>) -> Value {
    let total = read.answer_nodes_len();
    let (scope, nodes, edges, cut, arm, bounds) = match read {
        GraphRead::Walk {
            seed,
            depth,
            answer,
        } => {
            let (nodes, edges, cut) = cut_to_bounds(&answer.nodes, &answer.edges);
            let arm = (!answer.nodes.is_empty()).then(|| Arm::Walk {
                from: vec![seed.clone()],
                depth: *depth,
            });
            (
                format!("reached from {seed} within {depth} hops"),
                nodes,
                edges,
                cut,
                arm,
                None,
            )
        }
        GraphRead::Entry {
            context,
            anchor,
            answer,
        } => {
            let (nodes, edges, cut) = cut_to_bounds(&answer.nodes, &answer.edges);
            let arm = (!answer.nodes.is_empty()).then(|| Arm::Entry {
                r#in: vec![anchor.to_string()],
                k: ENTRY_K,
            });
            (
                format!("the most-connected in {context}"),
                nodes,
                edges,
                cut,
                arm,
                Some(Bounds {
                    drawn: answer.bounds.drawn,
                    eligible: answer.bounds.eligible,
                    in_scope: answer.bounds.in_scope,
                    truncated: answer.bounds.truncated,
                }),
            )
        }
    };
    let props = GraphProps {
        total: total as i64,
        scope: clip(&scope, SCOPE_MAX),
        label: "neighbourhood",
        state: if total > 0 { "present" } else { "empty" },
        arm,
        bounds,
        cut,
        nodes: nodes.iter().map(|n| graph_node(n, homes)).collect(),
        edges: edges.iter().map(graph_edge).collect(),
    };
    serde_json::to_value(props).expect("graph props serialize")
}

/// What the read said each drawn node is, in the shape a reference resolves
/// to: the nodes are drawn with bare ids, and the read already answered for
/// them, so the webview resolves them from this answer rather than reading
/// each again. A node without a doc type fills the empty string, never a
/// guessed type name.
fn node_resolutions(read: &GraphRead, homes: &HashMap<Uuid, String>) -> Vec<RefResolution> {
    let (answer_nodes, answer_edges) = match read {
        GraphRead::Walk { answer, .. } => (&answer.nodes, &answer.edges),
        GraphRead::Entry { answer, .. } => (&answer.nodes, &answer.edges),
    };
    let (nodes, _, _) = cut_to_bounds(answer_nodes, answer_edges);
    nodes
        .iter()
        .map(|n| RefResolution::Resolved {
            id: n.id.to_string(),
            title: n.title.clone(),
            doc_type: n.doc_type.clone().unwrap_or_default(),
            context_ref: (n.home == NodeHome::Context)
                .then_some(n.home_id)
                .flatten()
                .and_then(|id| homes.get(&id).cloned()),
            decorated_ref: n.id.to_string(),
        })
        .collect()
}

/// Whether the binding names a Table in the spec — asked before any read, so
/// a binding that cannot be filled costs nothing.
fn bound_table(spec: &Value, binding: &Binding) -> Result<(), String> {
    let element = spec
        .get("elements")
        .and_then(|e| e.get(&binding.element))
        .ok_or_else(|| format!("the lens's spec has no element {}", binding.element))?;
    if element.get("type").and_then(Value::as_str) != Some("Table") {
        return Err(format!(
            "a {} read fills a Table, and {} is not one",
            binding.read, binding.element
        ));
    }
    Ok(())
}

/// Whether the binding names a Graph in the spec — asked before any read, so
/// a binding that cannot be filled costs nothing.
fn bound_graph(spec: &Value, binding: &Binding) -> Result<(), String> {
    let element = spec
        .get("elements")
        .and_then(|e| e.get(&binding.element))
        .ok_or_else(|| format!("the lens's spec has no element {}", binding.element))?;
    if element.get("type").and_then(Value::as_str) != Some("Graph") {
        return Err(format!(
            "a {} read fills a Graph, and {} is not one",
            binding.read, binding.element
        ));
    }
    Ok(())
}

/// The lens's spec with its bound element filled from the answer, checked.
pub fn fill(spec: &Value, binding: &Binding, props: Value) -> Result<Value, String> {
    match binding.read.as_str() {
        "resource-list" => bound_table(spec, binding)?,
        "graph" => bound_graph(spec, binding)?,
        _ => return Err(format!("no read named {} can be bound", binding.read)),
    }
    let mut spec = spec.clone();
    spec["elements"][&binding.element]["props"] = props;
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
    subject: LensSubject,
    view: ViewState,
) -> Result<Resolved, String> {
    let client = state
        .client()
        .ok_or_else(|| "temper is not connected".to_string())?;
    match binding.read.as_str() {
        "resource-list" => {
            bound_table(&spec, &binding)?;
            let listing = match subject {
                LensSubject::Query { listing } => listing,
                LensSubject::Neighbourhood { .. } => {
                    return Err("a listing is of a query, not a neighbourhood".to_string())
                }
            };
            let mut params = listing_params(&listing, &view)?;
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
                spec: fill(&spec, &binding, table_props(&answer, &listing, &view))?,
                refs: row_resolutions(&answer),
            })
        }
        "graph" => {
            bound_graph(&spec, &binding)?;
            // One contexts read per resolve: it names the entry read's anchor
            // and every home the answer's nodes are homed in.
            let contexts = client.contexts().list().await.map_err(|e| e.to_string())?;
            let homes: HashMap<Uuid, String> = contexts
                .into_iter()
                .map(|c| (c.id.0, format!("{}/{}", c.owner_ref, c.slug)))
                .collect();
            let read = graph_read(client, subject, &homes).await?;
            Ok(Resolved {
                spec: fill(&spec, &binding, graph_props(&read, &homes))?,
                refs: node_resolutions(&read, &homes),
            })
        }
        other => Err(format!("no read named {other} can be bound")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use temper_core::types::graph_atlas::EntryBounds;

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
    fn only_the_most_present_fields_are_weighed_and_the_rest_are_counted() {
        let meta: serde_json::Map<String, Value> = (0..200)
            .map(|i| (format!("k{i:03}"), json!({ "nested": i })))
            .collect();
        let rows = vec![row(1, "task", Value::Object(meta), json!({}))];
        let props = table_props(
            &answer(rows, 1, 0, 50),
            &context_subject(),
            &ViewState::default(),
        );
        assert_eq!(props["fieldsNotShown"], 200);
        fill(&spec(), &binding(), props).expect("passes");
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

    // ── graph ──

    fn graph_spec() -> Value {
        json!({ "root": "graph", "elements": { "graph": { "type": "Graph", "props": {}, "children": [] } } })
    }

    fn graph_binding() -> Binding {
        Binding {
            element: "graph".into(),
            read: "graph".into(),
        }
    }

    fn atlas_node(n: u32, title: &str, doc_type: Option<&str>) -> AtlasNode {
        AtlasNode {
            id: uuid::Uuid::from_u128(n as u128),
            title: title.to_string(),
            doc_type: doc_type.map(str::to_string),
            home: NodeHome::Context,
            degree: 3,
            salience: None,
            excerpt: None,
            stage: None,
            home_id: None,
            updated: None,
        }
    }

    fn atlas_edge(n: u32, source: u32, target: u32, label: Option<&str>, weight: f64) -> AtlasEdge {
        AtlasEdge {
            id: uuid::Uuid::from_u128(9_000 + n as u128),
            source: uuid::Uuid::from_u128(source as u128),
            target: uuid::Uuid::from_u128(target as u128),
            edge_kind: EdgeKind::LeadsTo,
            polarity: Polarity::Forward,
            label: label.map(str::to_string),
            weight,
        }
    }

    fn walk_answer(nodes: Vec<AtlasNode>, edges: Vec<AtlasEdge>) -> AtlasSubgraph {
        AtlasSubgraph { nodes, edges }
    }

    fn entry_answer(
        nodes: Vec<AtlasNode>,
        edges: Vec<AtlasEdge>,
        drawn: i32,
        eligible: i32,
        in_scope: i32,
        truncated: bool,
    ) -> AtlasEntry {
        AtlasEntry {
            nodes,
            edges,
            bounds: EntryBounds {
                drawn,
                eligible,
                in_scope,
                truncated,
            },
        }
    }

    fn homes() -> HashMap<Uuid, String> {
        HashMap::from([(
            uuid::Uuid::from_u128(500),
            "+temper-dev/contrib".to_string(),
        )])
    }

    fn walk_from(seed: &str, depth: i32, answer: AtlasSubgraph) -> GraphRead {
        GraphRead::Walk {
            seed: seed.to_string(),
            depth,
            answer,
        }
    }

    #[test]
    fn the_same_answer_always_yields_the_same_graph_props() {
        let a = walk_answer(
            vec![
                atlas_node(1, "Seed", Some("task")),
                atlas_node(2, "Next", None),
            ],
            vec![atlas_edge(1, 1, 2, Some("then"), 0.5)],
        );
        let read = walk_from(&uuid::Uuid::from_u128(1).to_string(), 2, a);
        assert_eq!(graph_props(&read, &homes()), graph_props(&read, &homes()));
    }

    #[test]
    fn a_walk_names_its_seed_and_depth_and_carries_no_bounds() {
        let a = walk_answer(
            vec![
                atlas_node(1, "Seed", Some("task")),
                atlas_node(2, "Next", None),
            ],
            vec![atlas_edge(1, 1, 2, Some("then"), 0.5)],
        );
        let seed = uuid::Uuid::from_u128(1).to_string();
        let read = walk_from(&seed, 3, a);
        let props = graph_props(&read, &homes());
        assert_eq!(props["total"], 2);
        assert_eq!(props["state"], "present");
        assert_eq!(props["label"], "neighbourhood");
        assert_eq!(props["scope"], format!("reached from {seed} within 3 hops"));
        assert_eq!(
            props["arm"],
            json!({ "read": "walk", "from": [seed], "depth": 3 })
        );
        assert!(props.get("bounds").is_none());
        assert!(props.get("cut").is_none());
        assert_eq!(props["nodes"][0]["kind"], "task");
        assert_eq!(props["nodes"][0]["tint"], "doctype-task");
        assert_eq!(props["nodes"][1]["tint"], serde_json::Value::Null);
        assert_eq!(props["nodes"][0]["ref"], seed);
        assert_eq!(props["nodes"][0]["corpusDegree"], 3);
        assert_eq!(props["nodes"][0]["homeKind"], "context");
        // No home id, no home words: the anchor is named by kind alone.
        assert!(props["nodes"][0].get("home").is_none());
        assert_eq!(
            props["edges"][0],
            json!({
                "source": uuid::Uuid::from_u128(1).to_string(),
                "target": uuid::Uuid::from_u128(2).to_string(),
                "label": "then",
                "edgeKind": "leads_to",
                "polarity": "forward",
                "weight": 0.5
            })
        );
        fill(&graph_spec(), &graph_binding(), props).expect("the walk passes the check");
    }

    #[test]
    fn a_cut_lands_exactly_at_the_catalogs_bounds_and_says_what_fell_off() {
        let nodes: Vec<AtlasNode> = (1..=250)
            .map(|n| atlas_node(n, &format!("Node {n}"), Some("task")))
            .collect();
        // 700 edges among the first 200 nodes, plus 10 whose far end fell off
        // with the node cut: the drawn edges may only reach kept nodes.
        let mut edges: Vec<AtlasEdge> = (0..700)
            .map(|i| {
                atlas_edge(
                    i as u32,
                    (i % 200 + 1) as u32,
                    ((i + 1) % 200 + 1) as u32,
                    None,
                    1.0,
                )
            })
            .collect();
        edges.extend((0..10).map(|i| atlas_edge(700 + i, 1, 201 + i, None, 1.0)));
        let seed = uuid::Uuid::from_u128(1).to_string();
        let read = walk_from(&seed, 1, walk_answer(nodes, edges));
        let props = graph_props(&read, &homes());
        assert_eq!(props["total"], 250);
        assert_eq!(props["nodes"].as_array().unwrap().len(), 200);
        assert_eq!(props["edges"].as_array().unwrap().len(), 600);
        assert_eq!(props["cut"], json!({ "nodes": 50, "edges": 100 }));
        let drawn_ids: HashSet<String> = props["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n["id"].as_str().unwrap().to_string())
            .collect();
        for e in props["edges"].as_array().unwrap() {
            assert!(drawn_ids.contains(e["source"].as_str().unwrap()));
            assert!(drawn_ids.contains(e["target"].as_str().unwrap()));
        }
        fill(&graph_spec(), &graph_binding(), props).expect("the cut view passes the check");
    }

    #[test]
    fn a_cut_of_edges_alone_says_edges_alone() {
        let nodes: Vec<AtlasNode> = (1..=10).map(|n| atlas_node(n, "N", None)).collect();
        let edges: Vec<AtlasEdge> = (0..700)
            .map(|i| {
                atlas_edge(
                    i as u32,
                    (i % 10 + 1) as u32,
                    ((i + 1) % 10 + 1) as u32,
                    None,
                    1.0,
                )
            })
            .collect();
        let seed = uuid::Uuid::from_u128(1).to_string();
        let read = walk_from(&seed, 1, walk_answer(nodes, edges));
        let props = graph_props(&read, &homes());
        assert_eq!(props["nodes"].as_array().unwrap().len(), 10);
        assert_eq!(props["edges"].as_array().unwrap().len(), 600);
        assert_eq!(props["cut"], json!({ "edges": 100 }));
        fill(&graph_spec(), &graph_binding(), props).expect("passes");
    }

    #[test]
    fn an_entry_read_carries_the_bounds_it_was_given_and_the_k_applied() {
        let a = entry_answer(
            vec![
                atlas_node(1, "Top", Some("goal")),
                atlas_node(2, "Next", None),
            ],
            vec![atlas_edge(1, 1, 2, None, 0.25)],
            2,
            5,
            9,
            true,
        );
        let anchor = uuid::Uuid::from_u128(777);
        let read = GraphRead::Entry {
            context: "+temper-dev/contrib".into(),
            anchor,
            answer: a,
        };
        let props = graph_props(&read, &homes());
        assert_eq!(
            props["bounds"],
            json!({ "drawn": 2, "eligible": 5, "inScope": 9, "truncated": true })
        );
        assert_eq!(props["scope"], "the most-connected in +temper-dev/contrib");
        assert_eq!(
            props["arm"],
            json!({ "read": "entry", "in": [anchor.to_string()], "k": 130 })
        );
        assert!(props.get("cut").is_none());
    }

    #[test]
    fn an_empty_walk_says_so_and_names_nothing_it_does_not_draw() {
        let read = walk_from(
            &uuid::Uuid::from_u128(1).to_string(),
            2,
            walk_answer(vec![], vec![]),
        );
        let props = graph_props(&read, &homes());
        assert_eq!(props["total"], 0);
        assert_eq!(props["state"], "empty");
        assert!(props.get("arm").is_none());
        assert!(props.get("cut").is_none());
        assert_eq!(props["nodes"].as_array().unwrap().len(), 0);
        fill(&graph_spec(), &graph_binding(), props).expect("the empty view passes the check");
    }

    #[test]
    fn odd_answer_data_never_refuses_the_graphs_own_view() {
        let long = "x".repeat(300);
        let mut n = atlas_node(1, &long, Some(&"t".repeat(90)));
        n.excerpt = Some(long.clone());
        n.stage = Some("s".repeat(90));
        n.home = NodeHome::Cogmap;
        n.home_id = Some(uuid::Uuid::from_u128(999));
        n.degree = 0;
        let a = walk_answer(vec![n], vec![]);
        let seed = uuid::Uuid::from_u128(1).to_string();
        let props = graph_props(&walk_from(&seed, 1, a), &homes());
        let node = &props["nodes"][0];
        assert_eq!(node["label"].as_str().unwrap().chars().count(), 120);
        assert!(node["label"].as_str().unwrap().ends_with('…'));
        // A type the catalog does not tint is said as kind and carries no tint.
        assert_eq!(node["kind"].as_str().unwrap().chars().count(), 40);
        assert!(node.get("tint").is_none() || node["tint"].is_null());
        assert_eq!(node["stage"].as_str().unwrap().chars().count(), 20);
        // A home no context names falls back to the anchor's bare id.
        assert_eq!(node["home"], uuid::Uuid::from_u128(999).to_string());
        assert_eq!(node["homeKind"], "cogmap");
        fill(&graph_spec(), &graph_binding(), props).expect("odd data still passes");
    }

    #[test]
    fn an_out_of_range_weight_is_refused_not_clamped() {
        let a = walk_answer(
            vec![atlas_node(1, "Seed", None), atlas_node(2, "Next", None)],
            vec![atlas_edge(1, 1, 2, None, 7.5)],
        );
        let seed = uuid::Uuid::from_u128(1).to_string();
        let props = graph_props(&walk_from(&seed, 1, a), &homes());
        assert_eq!(props["edges"][0]["weight"], 7.5);
        assert!(fill(&graph_spec(), &graph_binding(), props).is_err());
    }

    #[test]
    fn the_graphs_nodes_prime_their_references() {
        let mut context_homed = atlas_node(1, "Home", Some("task"));
        context_homed.home_id = Some(uuid::Uuid::from_u128(500));
        let mut cogmap_homed = atlas_node(2, "Away", None);
        cogmap_homed.home = NodeHome::Cogmap;
        cogmap_homed.home_id = Some(uuid::Uuid::from_u128(999));
        let read = walk_from(
            &uuid::Uuid::from_u128(1).to_string(),
            1,
            walk_answer(vec![context_homed, cogmap_homed], vec![]),
        );
        let refs = node_resolutions(&read, &homes());
        assert_eq!(refs.len(), 2);
        assert_eq!(
            refs[0],
            RefResolution::Resolved {
                id: uuid::Uuid::from_u128(1).to_string(),
                title: "Home".into(),
                doc_type: "task".into(),
                context_ref: Some("+temper-dev/contrib".into()),
                decorated_ref: uuid::Uuid::from_u128(1).to_string(),
            }
        );
        // A node without a doc type fills the empty string, never a guess; a
        // cogmap home names no context.
        assert!(
            matches!(&refs[1], RefResolution::Resolved { doc_type, context_ref, .. }
            if doc_type.is_empty() && context_ref.is_none())
        );
    }

    #[test]
    fn a_query_subject_naming_an_unknown_context_is_refused() {
        let err = context_anchor("nope/nope", &homes()).unwrap_err();
        assert!(err.contains("nope/nope"));
        let anchor =
            context_anchor("+temper-dev/contrib", &homes()).expect("the named context reads");
        assert_eq!(anchor, uuid::Uuid::from_u128(500));
    }

    #[test]
    fn a_graph_read_fills_only_a_graph_and_a_listing_only_a_table() {
        let a = walk_answer(
            vec![atlas_node(1, "Seed", None), atlas_node(2, "Next", None)],
            vec![atlas_edge(1, 1, 2, None, 0.5)],
        );
        let props = graph_props(
            &walk_from(&uuid::Uuid::from_u128(1).to_string(), 1, a),
            &homes(),
        );
        fill(&graph_spec(), &graph_binding(), props.clone()).expect("the graph fills a Graph");
        // A listing read fills a Table, and the graph element is not one.
        let listing_on_graph = Binding {
            element: "graph".into(),
            read: "resource-list".into(),
        };
        let err = fill(&graph_spec(), &listing_on_graph, props).unwrap_err();
        assert!(err.contains("a resource-list read fills a Table"));
        let table = table_props(
            &answer(tasks(1), 1, 0, 50),
            &context_subject(),
            &ViewState::default(),
        );
        let graph_on_table = Binding {
            element: "table".into(),
            read: "graph".into(),
        };
        let err = fill(&spec(), &graph_on_table, table).unwrap_err();
        assert!(err.contains("a graph read fills a Graph"));
        // No read at all by that name, refused before anything is filled.
        let unknown = Binding {
            element: "graph".into(),
            read: "junk".into(),
        };
        let err = fill(&graph_spec(), &unknown, json!({})).unwrap_err();
        assert!(err.contains("no read named junk can be bound"));
    }

    #[test]
    fn the_subjects_the_webview_sends_deserialize_to_their_variants() {
        let query: LensSubject = serde_json::from_value(json!({
            "kind": "query", "context": "+temper-dev/contrib", "docType": "task"
        }))
        .expect("a query subject deserializes");
        assert!(matches!(query, LensSubject::Query { ref listing }
            if listing.context.as_deref() == Some("+temper-dev/contrib")
                && listing.doc_type.as_deref() == Some("task")));
        let walk: LensSubject = serde_json::from_value(json!({
            "kind": "neighbourhood", "id": uuid::Uuid::from_u128(1).to_string(), "depth": 1
        }))
        .expect("a neighbourhood subject deserializes");
        assert!(
            matches!(walk, LensSubject::Neighbourhood { ref id, depth: 1 }
            if *id == uuid::Uuid::from_u128(1).to_string())
        );
    }

    /// The evidence a live graph answer settles: counts, cut, bounds, the
    /// weights and doc types observed, and how the homes resolved.
    fn print_graph_evidence(name: &str, read: &GraphRead, props: &Value) {
        let (answer_nodes, answer_edges) = match read {
            GraphRead::Walk { answer, .. } => (answer.nodes.len(), answer.edges.len()),
            GraphRead::Entry { answer, .. } => (answer.nodes.len(), answer.edges.len()),
        };
        let drawn_nodes = props["nodes"].as_array().map_or(0, Vec::len);
        let drawn_edges = props["edges"].as_array().map_or(0, Vec::len);
        let mut weights: Vec<f64> = props["edges"]
            .as_array()
            .map(|es| {
                es.iter()
                    .filter_map(|e| e["weight"].as_f64())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        weights.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        weights.dedup();
        let range = match (weights.first(), weights.last()) {
            (Some(lo), Some(hi)) => format!("{lo}..{hi}"),
            _ => "none".to_string(),
        };
        let mut kinds: Vec<String> = props["nodes"]
            .as_array()
            .map(|ns| {
                ns.iter()
                    .filter_map(|n| n["kind"].as_str())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        kinds.sort();
        kinds.dedup();
        let mut homes_words = 0;
        let mut homes_bare_context = 0;
        let mut homes_bare_cogmap = 0;
        for n in props["nodes"].as_array().map_or(&[][..], Vec::as_slice) {
            let id = n["id"].as_str().unwrap_or_default();
            let home = n["home"].as_str().unwrap_or_default();
            if home.is_empty() {
                continue;
            }
            if home == id {
                if n["homeKind"] == "cogmap" {
                    homes_bare_cogmap += 1;
                } else {
                    homes_bare_context += 1;
                }
            } else {
                homes_words += 1;
            }
        }
        eprintln!(
            "{name}: answer {answer_nodes} nodes / {answer_edges} edges, drawn {drawn_nodes} / \
             {drawn_edges}, cut {}, bounds {}, weights distinct [{}] range {range}, doc types \
             {kinds:?}, homes by words {homes_words}, bare context {homes_bare_context}, bare \
             cogmap {homes_bare_cogmap}, arm {}",
            props.get("cut").map_or("none", |_| "fired"),
            props
                .get("bounds")
                .map_or_else(|| "none".to_string(), Value::to_string),
            if weights.len() > 20 {
                format!("{:?} +{} more", &weights[..20], weights.len() - 20)
            } else {
                format!("{weights:?}")
            },
            props
                .get("arm")
                .map_or("none".to_string(), Value::to_string),
        );
    }

    /// The bound graph from live reads: a walk from a real resource of
    /// `TEMPER_WITNESS_CONTEXT`, then the entry read for that context. Each
    /// filled view passes the core's check; the cut and the bounds are printed
    /// with what the answers held — the walk asks depth 9 so the arm shows the
    /// clamp applied.
    /// Run locally: `TEMPER_WITNESS_CONTEXT=+team/slug WITNESS_DUMP=/tmp/graph-witness \
    ///   cargo test -p desktop -- --ignored a_live_graph`
    #[tokio::test]
    #[ignore = "requires temper credentials, network, and TEMPER_WITNESS_CONTEXT"]
    async fn a_live_graph_fills_a_graph_the_check_admits() {
        let state = TemperState::connect();
        let client = state
            .client()
            .expect("machine temper credentials should resolve to a client");
        let context = std::env::var("TEMPER_WITNESS_CONTEXT")
            .expect("set TEMPER_WITNESS_CONTEXT to a context ref you can read");
        // One contexts read, shared: the entry's anchor and every home's words.
        let contexts = client.contexts().list().await.expect("contexts list");
        let homes: HashMap<Uuid, String> = contexts
            .iter()
            .map(|c| (c.id.0, format!("{}/{}", c.owner_ref, c.slug)))
            .collect();

        // The walk: from a real resource of the context, named by a listing.
        let subject = ListingSubject {
            context: Some(context.clone()),
            ..Default::default()
        };
        let listing = client
            .resources()
            .list_meta(&listing_params(&subject, &ViewState::default()).unwrap())
            .await
            .expect("the listing reads");
        let seed = listing
            .rows
            .first()
            .expect("the context holds a resource to walk from")
            .id
            .0;
        let requested = 9;
        let depth = clamp_traversal_depth(requested);
        let answer = client
            .graph()
            .traverse(&[seed], Some(depth))
            .await
            .expect("the walk reads");
        let read = GraphRead::Walk {
            seed: seed.to_string(),
            depth,
            answer,
        };
        let props = graph_props(&read, &homes);
        print_graph_evidence("walk", &read, &props);
        if let Ok(dir) = std::env::var("WITNESS_DUMP") {
            std::fs::write(
                format!("{dir}/props-walk.json"),
                serde_json::to_string_pretty(&props).unwrap(),
            )
            .unwrap();
        }
        let filled = fill(&graph_spec(), &graph_binding(), props).unwrap_or_else(|e| panic!("{e}"));
        eprintln!(
            "walk: requested depth {requested}, arm carries depth {}",
            filled["elements"]["graph"]["props"]["arm"]["depth"]
        );

        // The entry read for the same context.
        let anchor = context_anchor(&context, &homes).expect("the witness context reads");
        let answer = client
            .graph()
            .entry(&[anchor], None)
            .await
            .expect("the entry read reads");
        let read = GraphRead::Entry {
            context: context.clone(),
            anchor,
            answer,
        };
        let props = graph_props(&read, &homes);
        print_graph_evidence("entry", &read, &props);
        if let Ok(dir) = std::env::var("WITNESS_DUMP") {
            std::fs::write(
                format!("{dir}/props-entry.json"),
                serde_json::to_string_pretty(&props).unwrap(),
            )
            .unwrap();
        }
        fill(&graph_spec(), &graph_binding(), props).unwrap_or_else(|e| panic!("{e}"));
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
